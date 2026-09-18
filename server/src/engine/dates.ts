import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { find } from '../db/attributes.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { complete, completeJson, extractJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import {
  activeDate, addMessage, clearWakeup, createDate, dateMessages, deleteMessages, finishDate,
  getCharacter, getDate, getLocation, getMessage, getRelationship, getUserProfile, listDates,
  saveRelationship, setDateOutfit, type StoredMessage,
} from '../repo.js';
import type { Character, DateSession, Location, Relationship } from '../types.js';
import {
  appearanceBlock, flagsBlock, historyBlock, identityBlock, interestsBlock, languageBlock,
  ledgerBlock, lifeBlock, moodBlock, quirksBlock, seedBlock, sexualBlock, spiceBlock, userBlock,
} from './blocks.js';
import { claimTurn, currentEpoch, deleteMessage, isRunning, releaseTurn } from './chat.js';
import { describeHim } from './discovery.js';
import { describeSeed } from './generator.js';
import { enqueueImage } from './images.js';
import { describeHerMoment } from './moment.js';
import { currentStage } from './stage.js';
import { EVENT_FLAGS, NEGATIVE_FLAG_HOURS, STATE_FLAGS, applyUpdate, type DirectorUpdate } from './state.js';
import { userCardBlock } from './usercard.js';

/**
 * Dates: the other half of the game.
 *
 * Everything else in here simulates a phone. A date is the opposite register - the two of
 * them in the same room, written as roleplay, actions and all - so it gets its own prompt
 * (actor_date.md), its own transcript (messages.date_id) and its own turn loop. The texting
 * engine is frozen for the duration rather than sharing a turn with this one: she cannot
 * plausibly be across a table from him and texting him at the same time.
 *
 * Only he can start one. She is free to ask for a date in the chat and the Director can
 * steer her towards asking, but the button is his - which is the whole point of it being an
 * invitation.
 */

/** Her opening beat is generated from an empty transcript, so the scene starts already moving. */
const OPENING_NOTE = 'The date has just begun. Open the scene: arrive, or be found already there.';

/**
 * Used when the model fails twice. Deliberately in register - a canned "sorry, my phone did
 * something weird" would be nonsense from someone sitting in front of him - and flagged so
 * the client can mark it as a failed generation rather than a beat she actually played. Plain
 * narration, no markup: see actor_date.md for the three-part syntax this has to stay valid
 * under (plain text narrates, "quotes" speak, *asterisks* are a hidden private thought).
 */
const FALLBACK_BEAT = 'Something catches her attention across the room, and she loses the thread of what she was about to say.';

/** How much of a beat is actually enforced to be short - see MAX_VISIBLE_WORDS below. */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * What the beat leaves behind once her private thoughts - the *asterisk* spans neither he
 * nor the player ever sees - are stripped back out. Used both to catch a turn that is
 * nothing but a hidden thought (which would render as a blank bubble) and to measure the
 * length that actually matters: the visible part is what has to stay short, not the thought
 * riding along with it.
 */
function visibleContent(text: string): string {
  return text.replace(/\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A beat with real substance left after her private thoughts are stripped, but too much of
 * it - more than a couple of full paragraphs, well past the point where it reads as one beat
 * rather than the model playing out the rest of the evening unprompted. Only checked on the
 * first attempt: a slightly-too-long second attempt still beats spending both retries on
 * wordcount and landing on the fallback line instead.
 */
const MAX_VISIBLE_WORDS = 220;

export interface DateTurnResult {
  text: string;
  hidden: { thoughts: string; mood: string; wants: string };
}

// ------------------------------------------------------------------ prompt blocks

/** Where they are, as she experiences it. His own description of the place, plus the time. */
export function locationBlock(date: DateSession, location: Location | null): string {
  const lines = [`Place: ${location?.name || date.where_at || 'somewhere the two of you agreed on'}`];
  const description = location?.description?.trim();
  if (description) lines.push(description);
  if (date.when_at) lines.push(`When: ${date.when_at}`);
  return lines.join('\n');
}

function buildDatePrompt(
  character: Character,
  rel: Relationship,
  date: DateSession,
  transcript: StoredMessage[],
): string {
  const user = getUserProfile();
  const seed = character.seed;
  const flags = rel.flags;

  return render('actor_date', {
    char_display_name: flags.state.real_name_known ? character.real_name : `@${character.username}`,
    user_name: user?.display_name ?? 'him',
    location_block: locationBlock(date, date.location_id ? getLocation(date.location_id) : null),
    // Empty on the opening beat, which is what OPENING_NOTE replaces.
    history_block: transcript.length
      ? historyBlock(transcript, character, user)
      : OPENING_NOTE,
    identity_block: identityBlock(character, flags),
    quirks_block: quirksBlock(seed),
    // Unconditional here, unlike the chat: he is looking straight at her, so withholding what
    // she looks like until a photo unlocks it makes no sense at all in person.
    appearance_block: appearanceBlock(seed, flags),
    // Decided once in openDate(), read fresh here on every single turn - so the opening
    // beat, every later beat and the arrival photo all agree on what she is wearing rather
    // than three separate guesses.
    outfit_block: date.outfit
      ? `What she is wearing tonight: ${date.outfit}\nThis holds for the whole evening unless ` +
        `the scene itself changes it (a jacket comes off, shoes come off) - never have her in ` +
        `a different outfit than this without narrating an actual reason for the change.`
      : '',
    life_block: lifeBlock(seed),
    interests_block: interestsBlock(seed),
    sexual_block: sexualBlock(seed),
    // 'in_person': the texting version of this block forbids narration and asterisk actions
    // and demands phone-typing habits, which flatly contradicts actor_date.md's own format -
    // feeding it in unmodified used to hand the model two contradictory rule sets at once.
    spice_block: spiceBlock(seed, rel.arousal, flags, 'in_person'),
    language_block: seed.languages.length > 1 ? languageBlock(seed) : '',
    user_block: [
      userBlock(user, flags),
      user ? userCardBlock(user, flags) : '',
      describeHim(rel),
    ].filter(Boolean).join('\n\n'),
    ledger_block: ledgerBlock(rel.ledger),
    mood_block: moodBlock(rel.arousal, currentStage(rel, character).label, seed.hints.arousal_tell, 'in_person'),
    moment_block: describeHerMoment(character),
  });
}

/**
 * The one thing that ruins a roleplay scene faster than bad prose: writing his half of it.
 * Narration is plain text now (see actor_date.md's three-part syntax), so this checks each
 * narrated sentence - the bits outside quoted speech and hidden thoughts - for one that
 * opens on him as its subject, plus the blatant "you feel/decide" tell that means the same
 * thing wherever it lands. Leaves the rest ("she takes your hand") alone, which is the point:
 * he can be touched, spoken to and reacted to, just never driven.
 */
export function writesForHim(text: string): boolean {
  const narration = text.replace(/"[^"]*"/g, ' ').replace(/\*[^*]*\*/g, ' ');
  const sentences = narration.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.some((s) => /^(you|he)\b/i.test(s))) return true;
  return /\byou (feel|felt|find yourself|can't help|couldn't help|decide|realise|realize)\b/i.test(text);
}

// ------------------------------------------------------------------ the turn

async function runDateActor(
  character: Character,
  rel: Relationship,
  date: DateSession,
): Promise<DateTurnResult> {
  const settings = getSettings();
  const prompt = buildDatePrompt(character, rel, date, dateMessages(date.id));
  const base = [{ role: 'user' as const, content: prompt }];
  let correction: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = await complete({
        scope: 'actor',
        label: `date:${character.username}${attempt ? ':retry' : ''}`,
        config: settings.models.actor,
        json: true,
        messages: correction ? [...base, { role: 'user', content: correction }] : base,
      });
    } catch (err) {
      logger.error('actor', `date actor call failed for ${character.username}`, { error: String(err) });
      if (attempt === 0) continue;
      break;
    }

    let parsed: any;
    try {
      parsed = extractJson(raw);
    } catch {
      correction = 'That was not valid JSON. Reply with a single JSON object and nothing else.';
      continue;
    }

    const text = String(parsed?.text ?? '').trim();
    if (!text || !visibleContent(text)) {
      correction =
        'Your reply contained no visible scene - a hidden thought on its own renders as a blank ' +
        'message. Write one beat of the date: narration, or speech, or both, with a thought riding ' +
        'along if it wants to, not a thought standing in for the beat.';
      continue;
    }
    if (writesForHim(text)) {
      logger.warn('actor', 'date beat wrote his half of the scene', { character: character.username, text });
      correction =
        'You wrote his actions or his feelings for him. Write only what SHE does, says and notices - ' +
        'describe what she does TO him, and stop there. Write the beat again from scratch, same JSON shape.';
      continue;
    }
    if (attempt === 0 && countWords(visibleContent(text)) > MAX_VISIBLE_WORDS) {
      logger.warn('actor', 'date beat ran long, re-requesting', {
        character: character.username,
        words: countWords(visibleContent(text)),
      });
      correction =
        `That ran long even for a full beat - he needs room to actually reply, not a whole scene to ` +
        `read first. Two or three paragraphs at most, ${MAX_VISIBLE_WORDS} words or under not counting ` +
        `any hidden thought. Write it again, tighter, same JSON shape.`;
      continue;
    }

    return {
      text,
      hidden: {
        thoughts: String(parsed?.hidden?.thoughts ?? ''),
        mood: String(parsed?.hidden?.mood ?? ''),
        wants: String(parsed?.hidden?.wants ?? ''),
      },
    };
  }

  logger.error('actor', `date actor failed twice for ${character.username}, using fallback`);
  return { text: FALLBACK_BEAT, hidden: { thoughts: 'fallback beat, the model failed', mood: '', wants: '' } };
}

/**
 * One of her beats, delivered into the date transcript. Shares chat.ts's per-character turn
 * lock, so a stray wakeup and a date beat can never run at once.
 */
async function takeDateTurn(dateId: string): Promise<void> {
  const date = getDate(dateId);
  if (!date || date.status !== 'active') return;
  const character = getCharacter(date.character_id);
  const rel = getRelationship(date.character_id);
  if (!character || !rel) return;
  if (!claimTurn(character.id)) return;

  const startedIn = currentEpoch();
  bus.emitEvent({ type: 'typing', character_id: character.id, on: true });
  try {
    const result = await runDateActor(character, rel, date);
    // The world may have been reset, or the date ended by hand, while the call was in flight.
    if (currentEpoch() !== startedIn) return;
    if (getDate(dateId)?.status !== 'active') return;

    const stored = addMessage({
      character_id: character.id,
      sender: 'character',
      text: result.text,
      date_id: dateId,
      meta: result.text === FALLBACK_BEAT ? { failed: true } : {},
      read_at: null,
    });
    bus.emitEvent({ type: 'message', character_id: character.id, message: stored });

    const fresh = getRelationship(character.id);
    if (fresh) {
      fresh.mood = {
        ...fresh.mood,
        actor_mood: result.hidden.mood || fresh.mood.actor_mood,
        thoughts: result.hidden.thoughts,
        date_wants: result.hidden.wants,
      };
      fresh.last_contact_at = nowIso();
      saveRelationship(fresh);
    }
  } finally {
    bus.emitEvent({ type: 'typing', character_id: character.id, on: false });
    releaseTurn(character.id);
  }
}

// ------------------------------------------------------------------ lifecycle

export interface StartDateInput {
  characterId: string;
  locationId: string;
  /** Free text, exactly as he typed it: "tonight, 8pm", "Saturday afternoon". */
  when: string;
}

/** Sized like a photo idea call - one short, concrete paragraph, not a whole dossier. */
const OUTFIT_TOKENS = 600;

/** Used only when the outfit call fails outright - close to her usual style, nothing specific. */
function fallbackOutfit(character: Character): string {
  const style = find('clothing_style', character.seed.clothing_style)?.image_prompt
    ?? find('clothing_style', character.seed.clothing_style)?.label
    ?? 'something she feels good in';
  return `Something in her usual style tonight - ${style.toLowerCase()}.`;
}

/**
 * What she is actually wearing tonight, decided once as the date opens and then read fresh
 * on every turn after that (see outfit_block in buildDatePrompt) - so the opening beat, every
 * later beat and the arrival photo all agree on the same outfit instead of each guessing its
 * own. Mirrors profilePicConcept()/freshPhotoIdea() in images.ts: a small, cheap call asking
 * her rather than deciding for her, so the answer actually varies with who she is and where
 * she is going rather than always landing on the same generic "cute outfit".
 */
async function decideDateOutfit(character: Character, date: DateSession, location: Location): Promise<string> {
  try {
    const out = await completeJson<{ outfit?: string }>({
      scope: 'image',
      label: `date_outfit:${character.username}`,
      config: { ...getSettings().models.actor, max_tokens: OUTFIT_TOKENS },
      require: ['outfit'],
      messages: [
        {
          role: 'user',
          content: render('actor_date_outfit', {
            real_name: character.real_name,
            dossier: character.seed.hints.dossier || describeSeed(character.seed),
            location_block: locationBlock(date, location),
          }),
        },
      ],
    });
    const outfit = (out.outfit ?? '').trim();
    if (outfit) return outfit;
  } catch (err) {
    logger.warn('actor', 'date outfit call failed, using a generic default', {
      character: character.username,
      error: String(err),
    });
  }
  return fallbackOutfit(character);
}

/** The situation handed to the image assembler for the arrival photo - see images.ts's is_date. */
function arrivalSituation(character: Character, location: Location, outfit: string): string {
  return [
    `He has just arrived and is seeing ${character.real_name} for the first time tonight, at ${location.name}.`,
    `She is wearing: ${outfit}`,
    'This is the moment he first spots her, or she first comes into view - a full-length shot, ' +
      'framed from well above her head down to her shoes with real margin on both ends so nothing ' +
      'is cropped off, not a waist-up or three-quarter shot. The whole outfit is the point of this ' +
      'photo, so nothing about it may be cut off or guessed at.',
  ].join(' ');
}

/**
 * Decides the outfit and starts the arrival photo before the scene itself opens, so the very
 * first beat already knows what she is wearing rather than picking its own answer that the
 * stored outfit then has to disagree with. The photo generates in the background - it does
 * not block the opening beat, the same way an offered chat photo never blocks the reply that
 * came with it.
 */
async function openDate(character: Character, date: DateSession, location: Location): Promise<void> {
  const outfit = await decideDateOutfit(character, date, location);
  setDateOutfit(date.id, outfit);

  if (getSettings().images_enabled) {
    enqueueImage({
      characterId: character.id,
      dateId: date.id,
      kind: 'date',
      situation: arrivalSituation(character, location, outfit),
      aspect: 'portrait',
      showsFace: true,
    });
  }

  // She opens the scene, rather than the two of them staring at each other until he types.
  await takeDateTurn(date.id);
}

/**
 * He asks, they go. There is no acceptance roll: she agreed in the chat or she did not, and
 * pressing the button is him acting on that - a button that sometimes silently refuses would
 * read as a bug rather than as her having an opinion.
 */
export async function startDate(input: StartDateInput): Promise<DateSession> {
  const character = getCharacter(input.characterId);
  if (!character) throw new Error('character not found');
  if (character.state !== 'matched') throw new Error('you are not matched with her');
  const rel = getRelationship(character.id);
  if (!rel) throw new Error('relationship missing');
  if (activeDate(character.id)) throw new Error('you are already on a date with her');

  const location = getLocation(input.locationId);
  if (!location) throw new Error('location not found');

  const date = createDate({
    id: randomUUID(),
    character_id: character.id,
    when_at: input.when.trim(),
    where_at: location.name,
    location_id: location.id,
  });

  // She is out with him: nothing may wake her up to send a text mid-date.
  clearWakeup(character.id);

  // A marker in the TEXT chat as well, so the texting history shows the evening happening
  // rather than a silent gap, and the client has something to hang an "open date" link on.
  const marker = addMessage({
    character_id: character.id,
    sender: 'system',
    text: `You took ${character.real_name} to ${location.name}${date.when_at ? ` - ${date.when_at}` : ''}.`,
    meta: { type: 'date_started', date_id: date.id },
  });
  bus.emitEvent({ type: 'message', character_id: character.id, message: marker });
  bus.emitEvent({ type: 'date', character_id: character.id, date });
  logger.info('actor', `date started with ${character.username}`, { where: location.name, when: date.when_at });

  void openDate(character, date, location).catch((err) =>
    logger.error('actor', 'opening date beat failed', { error: String(err) }),
  );
  return date;
}

/** His half of a beat. Same shape as handleUserMessage, into the date transcript instead. */
export async function handleUserDateMessage(input: { dateId: string; text: string }): Promise<StoredMessage> {
  const date = getDate(input.dateId);
  if (!date) throw new Error('date not found');
  if (date.status !== 'active') throw new Error('that date has already ended');

  const stored = addMessage({
    character_id: date.character_id,
    sender: 'user',
    text: input.text,
    date_id: date.id,
  });
  bus.emitEvent({ type: 'message', character_id: date.character_id, message: stored });

  void takeDateTurn(date.id).catch((err) =>
    logger.error('actor', 'date turn failed', { error: String(err) }),
  );
  return stored;
}

/**
 * Reroll her most recent beat - the date-room equivalent of regenerateLastTurn in chat.ts,
 * for the same reason and with the same restriction: only the trailing run of her messages
 * can go, since there is no per-beat Director here to redo and anything older has already
 * played out. claimTurn/isRunning is the same shared lock a live beat uses, so this cannot
 * race one already in flight.
 */
export async function regenerateLastDateBeat(dateId: string, messageId: number): Promise<{ removed_ids: number[] }> {
  const date = getDate(dateId);
  if (!date) throw new Error('date not found');
  if (date.status !== 'active') throw new Error('that date has already ended');
  const character = getCharacter(date.character_id);
  if (!character) throw new Error('character not found');
  if (isRunning(character.id)) throw new Error('she is already in the middle of a beat');

  const all = dateMessages(dateId);
  const trailing: StoredMessage[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].sender !== 'character') break;
    trailing.unshift(all[i]);
  }
  if (trailing.length === 0) {
    throw new Error('the last beat is not hers - nothing to regenerate');
  }
  if (!trailing.some((m) => m.id === messageId)) {
    throw new Error('that beat has already been superseded');
  }

  const removedIds = trailing.map((m) => m.id);
  deleteMessages(removedIds);
  bus.emitEvent({ type: 'messages_removed', character_id: character.id, message_ids: removedIds });
  logger.info('actor', `regenerating last date beat for ${character.username}`, { removed: removedIds });

  void takeDateTurn(dateId).catch((err) =>
    logger.error('actor', 'regenerate date beat failed', { error: String(err) }),
  );

  return { removed_ids: removedIds };
}

/** A plain delete of one line from a date's own transcript - any position, either side. */
export function deleteDateMessage(dateId: string, messageId: number): void {
  const date = getDate(dateId);
  if (!date) throw new Error('date not found');
  const message = getMessage(messageId);
  if (!message || message.date_id !== dateId) throw new Error('message not found');
  deleteMessage(date.character_id, messageId);
}

function summaryPrompt(character: Character, rel: Relationship, date: DateSession): string {
  const user = getUserProfile();
  return render('director_date_summary', {
    user_block: userBlock(user, rel.flags),
    seed_block: seedBlock(character),
    location_block: locationBlock(date, date.location_id ? getLocation(date.location_id) : null),
    trust: rel.trust,
    spark: rel.spark,
    investment: rel.investment,
    arousal: rel.arousal,
    flags_block: flagsBlock(rel.flags),
    history_block: historyBlock(dateMessages(date.id), character, user),
    state_flags: STATE_FLAGS.join(', '),
    event_flags: EVENT_FLAGS.join(', '),
    negative_flags: Object.keys(NEGATIVE_FLAG_HOURS).join(', '),
  });
}

/**
 * The evening, compressed into the one paragraph she keeps.
 *
 * This is the whole reason the transcript is separate: the date is not in her texting
 * history and never will be, so without a summary written back into the chat she would
 * genuinely have no idea they had ever met. The summary is posted as a system line in the
 * text chat, which puts it in the Actor's context from the next message onwards.
 */
export async function endDate(dateId: string): Promise<DateSession> {
  const date = getDate(dateId);
  if (!date) throw new Error('date not found');
  if (date.status !== 'active') return date;
  const character = getCharacter(date.character_id);
  const rel = getRelationship(date.character_id);
  if (!character || !rel) throw new Error('character not found');

  const transcript = dateMessages(date.id);
  let summary = '';
  let update: DirectorUpdate = {};

  // A date with nothing in it is not worth an LLM call, and definitely not worth stat deltas.
  if (transcript.some((m) => m.sender === 'user')) {
    try {
      const out = await completeJson<{ summary?: string; highlights?: string[]; update?: DirectorUpdate }>({
        scope: 'director',
        label: `date_summary:${character.username}`,
        config: getSettings().models.director,
        require: ['summary'],
        messages: [{ role: 'user', content: summaryPrompt(character, rel, date) }],
      });
      summary = String(out.summary ?? '').trim();
      update = out.update ?? {};
      const highlights = (out.highlights ?? []).map((h) => String(h)).filter(Boolean);
      if (highlights.length) {
        update.ledger = { ...update.ledger, what_landed: [...(update.ledger?.what_landed ?? []), ...highlights] };
      }
    } catch (err) {
      // The date still ended. Losing the stat deltas is survivable; leaving her stuck on a
      // date because one call failed is not.
      logger.error('director', `date summary failed for ${character.username}`, { error: String(err) });
    }
  }

  if (!summary) {
    summary = `You met ${character.real_name} at ${date.where_at || 'the place you had agreed on'}${
      date.when_at ? ` (${date.when_at})` : ''
    }.`;
  }

  // Recorded as the evening itself, so it reads as a memory in the ledger rather than a note.
  update.ledger = {
    ...update.ledger,
    events: [...(update.ledger?.events ?? []), `Date at ${date.where_at || 'a place he chose'}: ${summary}`],
  };
  update.set_flags = [...new Set([...(update.set_flags ?? []), 'has_had_first_date'])];
  applyUpdate(character, rel, update);

  const ended = finishDate(date.id, summary)!;

  const marker = addMessage({
    character_id: character.id,
    sender: 'system',
    text: `The date at ${ended.where_at || 'the place you chose'} is over. ${summary}`,
    meta: { type: 'date_ended', date_id: ended.id },
  });
  bus.emitEvent({ type: 'message', character_id: character.id, message: marker });
  bus.emitEvent({ type: 'date', character_id: character.id, date: ended });
  logger.info('director', `date ended with ${character.username}`, { summary });

  return ended;
}

/** Everything the chat screen needs to render the invite menu and the past-dates list. */
export function dateHistory(characterId: string): { active: DateSession | null; past: DateSession[] } {
  const all = listDates(characterId);
  return {
    active: all.find((d) => d.status === 'active') ?? null,
    past: all.filter((d) => d.status === 'ended'),
  };
}
