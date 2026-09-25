import { getSettings } from '../config.js';
import { find } from '../db/attributes.js';
import { complete, extractJson } from '../llm/client.js';
import { isObj, pick } from '../llm/shape.js';
import { logger } from '../log.js';
import { getUserProfile, recentMessages } from '../repo.js';
import { render } from '../prompts/render.js';
import type { ActorHidden, ActorMessage, ActorOutput, Character, Direction, Relationship } from '../types.js';
import {
  appearanceBlock, communicationBlock, continuityBlock, directionBlock, fantasiesBlock, historyBlock,
  coreBlock, identityBlock, interestsBlock, languageBlock, ledgerBlock, lifeBlock, moodBlock, quirksBlock,
  sexualBlock, spiceBlock, userBlock,
} from './blocks.js';
import { describeHim } from './discovery.js';
import { userCardBlock } from './usercard.js';
import { describePace } from './stage.js';
import { describeHerMoment } from './moment.js';
import { initiativeNudge } from './nudge.js';
import { releaseBlock } from './release.js';
import { detectQuizzingHim, detectRoleplay, findVoiceProblem, isRelentlesslyWitty, verbatimRepeats } from './voice.js';
import { canSendPhotos } from './images.js';
import { fantasyLog } from './fantasies.js';
import { ACTOR_CHAT, VOICE_NOTE } from '../llm/schemas.js';

export { detectRoleplay };

/** The retry names the exact tic, which works far better than asking for "something better". */
function retryHint(problem: string, fix: string): string {
  return `Your last answer will not do: ${problem}.

${fix}

Write it again from scratch - do not patch the old version, it is the wrong shape. Same JSON structure, nothing else.`;
}

/**
 * Used only once both attempts have genuinely failed. A pool rather than one fixed line,
 * so a provider outage spanning a couple of turns does not repeat the exact same sentence
 * back to back - which reads far more obviously broken than any one of these does alone,
 * especially if the user resends thinking their message did not go through.
 */
const FALLBACK_LINES = [
  'sorry got distracted, what were u saying',
  'hang on, phone did something weird',
  'wait sorry, one sec',
  'ugh my signal is awful rn',
];

function fallbackOutput(): ActorOutput {
  return {
    messages: [{
      text: FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)],
      delay: 0,
      // Flagged through to the client so it can mark the bubble as a failed generation
      // rather than a real line she typed - the flavor text alone reads as an in-character
      // beat, and he cannot tell the difference without this.
      failed: true,
    }],
    hidden: {
      thoughts: 'fallback message, the model failed',
      unresolved: null,
      mood: 'neutral',
      location: '',
      outfit: '',
      activity: '',
      goal_fulfilled: false,
      new_fact: null,
      open_thread: null,
      director_needed: true,
      photo_offer: null,
      photo_situation: null,
      photo_aspect: null,
      photo_shows_face: null,
      fantasy_pitched: null,
      new_fantasy: null,
      react: null,
      photo_options: null,
      in_the_act: false,
    },
  };
}

const PHOTO_OFFER_KINDS = new Set(['chat', 'spicy']);
const PHOTO_ASPECTS = new Set(['square', 'portrait', 'landscape']);

/**
 * The names this app's models actually use for the hidden fields, collected from logs. The
 * Actor runs warm and bends the schema more than anything else: "hidden_thoughts" and
 * "reflection" for thoughts, "current_activity", a "meta" block instead of "hidden", fields
 * hoisted to the top level next to "messages".
 */
const HIDDEN_ALIASES: Record<string, string[]> = {
  thoughts: ['thoughts', 'hidden_thoughts', 'reflection', 'inner_thoughts', 'thought', 'inner_monologue'],
  unresolved: ['unresolved', 'waiting_on', 'open_loop'],
  mood: ['mood', 'current_mood', 'feeling'],
  location: ['location', 'current_location', 'where'],
  outfit: ['outfit', 'current_outfit', 'wearing'],
  activity: ['activity', 'current_activity', 'doing'],
  new_fact: ['new_fact', 'new_information', 'last_fact_learned', 'fact_learned'],
  open_thread: ['open_thread', 'open_loops'],
  director_needed: ['director_needed', 'needs_director'],
  photo_shows_face: ['photo_shows_face', 'show_face', 'shows_face'],
  react: ['react', 'reaction'],
};

/** Everything that is not a message, from "hidden", "meta" or the top level, under our names. */
export function collectHidden(parsed: any): any {
  if (!parsed || typeof parsed !== 'object') return {};
  const { messages: _m, message: _m1, reply: _r, text: _t, ...top } = parsed;
  const pool = { ...top, ...(isObj(parsed.meta) ? parsed.meta : {}), ...(isObj(parsed.state) ? parsed.state : {}), ...(isObj(parsed.hidden) ? parsed.hidden : {}) };
  const out: any = { ...pool };
  for (const [key, aliases] of Object.entries(HIDDEN_ALIASES)) {
    const v = pick(pool, aliases);
    if (v !== undefined) out[key] = Array.isArray(v) && key !== 'photo_options' ? v.join('; ') : v;
  }
  // A photo she clearly meant to send, filed under a name of its own ("photo_spice": "the open
  // bottle of red on her counter") - without this it was silently dropped.
  if (!out.photo_offer) {
    const photoKey = Object.keys(pool).find((k) => /^photo_(spic|chat|desc|idea|situation)/.test(k) && typeof pool[k] === 'string' && pool[k].trim());
    if (photoKey) {
      out.photo_offer = /spic/.test(photoKey) ? 'spicy' : 'chat';
      out.photo_situation = out.photo_situation ?? pool[photoKey];
    }
  }
  return out;
}

function normalizeHidden(raw: any): ActorHidden {
  return {
    thoughts: String(raw?.thoughts ?? ''),
    unresolved: raw?.unresolved ? String(raw.unresolved) : null,
    mood: String(raw?.mood ?? ''),
    location: String(raw?.location ?? '').trim().slice(0, 200),
    outfit: String(raw?.outfit ?? '').trim().slice(0, 200),
    activity: String(raw?.activity ?? '').trim().slice(0, 200),
    goal_fulfilled: !!raw?.goal_fulfilled,
    new_fact: raw?.new_fact ? String(raw.new_fact) : null,
    open_thread: raw?.open_thread ? String(raw.open_thread) : null,
    director_needed: !!raw?.director_needed,
    // An old-style "profile" offer is read as an ordinary photo: her profile picture already
    // exists (or is made first), so what she means is "here's a pic of me".
    photo_offer: raw?.photo_offer === 'profile' ? 'chat' : PHOTO_OFFER_KINDS.has(raw?.photo_offer) ? raw.photo_offer : null,
    photo_situation: raw?.photo_situation ? String(raw.photo_situation).slice(0, 300) : null,
    photo_aspect: PHOTO_ASPECTS.has(raw?.photo_aspect) ? raw.photo_aspect : null,
    photo_shows_face: typeof raw?.photo_shows_face === 'boolean' ? raw.photo_shows_face : null,
    fantasy_pitched: Number.isInteger(raw?.fantasy_pitched) && raw.fantasy_pitched > 0 ? raw.fantasy_pitched : null,
    new_fantasy: raw?.new_fantasy ? String(raw.new_fantasy).slice(0, 400) : null,
    react: singleEmoji(raw?.react),
    photo_options: Array.isArray(raw?.photo_options)
      ? raw.photo_options.map((o: unknown) => String(o ?? '').trim().slice(0, 300)).filter(Boolean).slice(0, 2)
      : null,
    in_the_act: raw?.in_the_act === true,
  };
}

/** The first emoji of whatever came back, or null - a reaction is one emoji, never text. */
export function singleEmoji(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (!text || text === 'null') return null;
  const first = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)][0]?.segment ?? '';
  return /\p{Extended_Pictographic}/u.test(first) ? first : null;
}

/**
 * How long she appears to spend typing one message, from its length alone.
 * Roughly fourteen characters a second plus a moment to start, which reads as a fast
 * thumb-typist without ever becoming a wait.
 */
export function typingDelay(text: string, maxSeconds: number): number {
  const seconds = 0.6 + text.length / 14;
  return Math.max(1, Math.min(maxSeconds, Math.round(seconds)));
}

/**
 * Delays and message counts are software limits, never left to the model.
 *
 * The first message of a turn is sent immediately: the wait for it is already real,
 * because the model had to generate it. Adding an invented delay on top only makes her
 * look slow. Every message after it is paced by its own length, since those arrive
 * together and would otherwise land in the same instant.
 */
/**
 * Her messages, whichever shape they came in: `[{"text": ...}]` as asked, a list of plain
 * strings (what the model sent every time in the log this was fixed from), a single string,
 * or a "message"/"reply" key instead of "messages".
 */
export function collectMessages(parsed: any): unknown[] {
  const raw = pick(parsed, ['messages', 'message', 'reply', 'replies', 'text']);
  if (typeof raw === 'string') return [raw];
  return Array.isArray(raw) ? raw : [];
}

function normalizeMessages(raw: any): ActorMessage[] {
  const { max_messages_per_turn, max_delay_seconds } = getSettings().chat;
  const list = Array.isArray(raw) ? raw : [];
  const out: ActorMessage[] = [];
  for (const m of list.slice(0, max_messages_per_turn)) {
    const text = String(typeof m === 'string' ? m : pick(m, ['text', 'message', 'content', 'body']) ?? '').trim();
    if (!text) continue;
    out.push({
      text,
      delay: out.length === 0 ? 0 : typingDelay(text, max_delay_seconds),
      kind: 'text',
    });
  }
  return out;
}

export interface ActorContext {
  character: Character;
  relationship: Relationship;
  direction: Direction | null;
  /** She is texting first, on her own impulse ("your move") - not answering anything. */
  initiative?: boolean;
}

export type ActorRun = ActorOutput;

function buildPrompt(
  ctx: ActorContext,
  template: 'actor_chat' | 'actor_voice',
  nudge: string,
  somethingLive = false,
): string {
  const { character, relationship, direction } = ctx;
  const settings = getSettings();
  const user = getUserProfile();
  const seed = character.seed;
  const flags = relationship.flags;

  const messages = recentMessages(character.id, settings.chat.context_messages);

  return render(template, {
    char_display_name: character.real_name,
    user_name: user?.display_name ?? 'him',
    user_block: [
      userBlock(user),
      user ? userCardBlock(user) : '',
      describeHim(relationship),
    ].filter(Boolean).join('\n\n'),
    // Not a fiction she lives in: her picture simply has not been generated, which is his call
    // and costs money. She is not told why, so there is nothing for her to comment on.
    photo_status: canSendPhotos(relationship)
      ? ''
      : 'You cannot send photos in this chat for now: leave "photo_offer" null. If he asks for ' +
        'one, put it off in your own way or describe it in words instead. Do not make a thing of it.',
    identity_block: identityBlock(character, flags),
    core_block: coreBlock(character),
    communication_block: communicationBlock(seed),
    quirks_block: quirksBlock(seed),
    // She always knows all of herself. Nothing here is gated on how far things have got.
    appearance_block: appearanceBlock(seed),
    life_block: lifeBlock(seed),
    interests_block: interestsBlock(seed),
    sexual_block: sexualBlock(seed),
    fantasies_block: fantasiesBlock(seed, fantasyLog(relationship)),
    pace: describePace(character),
    spice_block: spiceBlock(seed, relationship.arousal),
    language_block: seed.languages.length > 1 ? languageBlock(seed) : '',
    ledger_block: ledgerBlock(relationship.ledger),
    direction_block: directionBlock(direction, somethingLive),
    mood_block: moodBlock(relationship.arousal, seed.hints.arousal_tell),
    release_block: releaseBlock(character, relationship),
    moment_block: describeHerMoment(character),
    continuity_block: continuityBlock(relationship.mood),
    turn_nudge: nudge,
    history_block: historyBlock(messages, character, user),
    max_messages: settings.chat.max_messages_per_turn,
    voice_target: messageBucket(seed.message_length) === 'long' ? '40 to 90 seconds of speech' : '12 to 40 seconds of speech',
    text_target: textTarget(seed.message_length),
  });
}

/**
 * Every `message_length` entry declares which of three buckets it behaves like via
 * `extra.bucket` - not the id itself, so a new nuanced entry ("clipped", "rambling_when_into_it")
 * still gets a real, concrete length target instead of silently falling through to "medium".
 */
function messageBucket(messageLength: string): string {
  return String(find('message_length', messageLength)?.extra?.bucket ?? 'medium');
}

/**
 * A concrete target, the same job voice_target does for voice notes. Without one, "obey
 * your message length setting" only ever names the one_liner floor, and a model with no
 * other anchor defaults to the shortest thing that technically satisfies every rule -
 * which reads as terse even for characters whose setting allows much more.
 */
function textTarget(messageLength: string): string {
  switch (messageBucket(messageLength)) {
    case 'short':
      return 'One short line, rarely more than a handful of words. That is the whole reply, not a first message with more to follow.';
    case 'long':
      return 'Real substance when there is something to say - two to four sentences, often split across two or three messages rather than one block. Still allowed to send just "same" when that is genuinely the whole reply.';
    default:
      return 'A sentence or two of actual content, not just a reaction word. Split it across a second message rather than cramming everything into one.';
  }
}

/**
 * A character who really does write in full sentences, so the register check exempts her.
 * Either attribute can carry the flag - `typing_style` for how she types day to day,
 * `slang_register` for how formal her vocabulary is - and a new entry earns the exemption by
 * setting `extra.formal` rather than by being named "proper" or "formal" specifically.
 */
function writesFormally(character: { seed: { typing_style: string; slang_register: string } }): boolean {
  return (
    !!find('typing_style', character.seed.typing_style)?.extra?.formal ||
    !!find('slang_register', character.seed.slang_register)?.extra?.formal
  );
}

export async function runActor(ctx: ActorContext): Promise<ActorRun> {
  const settings = getSettings();
  const recent = recentMessages(ctx.character.id, 12);
  const lastUserMessage = [...recent].reverse().find((m) => m.sender === 'user')?.text ?? '';
  const recentOwnMessages = recent.filter((m) => m.sender === 'character').map((m) => m.text);
  // A wider window for exact repeats only: a catchphrase can come back every few turns.
  const longOwnHistory = recentMessages(ctx.character.id, 60).filter((m) => m.sender === 'character').map((m) => m.text);

  /**
   * Two signals that the floor is not clear. The Actor's own report from last turn is the
   * better one - it knows whether a bit is running - and an unanswered question from him
   * is the obvious code-side case.
   */
  const somethingLive =
    !!(ctx.relationship.mood as any)?.unresolved ||
    (recent[recent.length - 1]?.sender === 'user' && lastUserMessage.includes('?'));

  // Only a turn she starts herself gets framing; what she says on any turn is hers.
  const nudge = ctx.initiative ? initiativeNudge() : null;
  const prompt = buildPrompt(ctx, 'actor_chat', nudge?.text ?? '', somethingLive);
  const base = [{ role: 'user' as const, content: prompt }];

  let correction: string | null = null;

  // Two attempts: the first is the ask, the second names whatever went wrong with it. A
  // reply that broke frame - the model declining or hedging rather than being her - buys one
  // extra, capped at three, for the same reason dates.ts does it: that correction is the one
  // most likely to work, and burning the last attempt on it lands the player on a canned
  // fallback line at exactly the wrong moment. Style problems still cost two.
  let budget = 2;
  for (let attempt = 0; attempt < budget; attempt++) {
    let text: string;
    try {
      text = await complete({
        scope: 'actor',
        label: `chat:${ctx.character.username}${attempt ? ':retry' : ''}`,
        schema: ACTOR_CHAT,
        config: settings.models.actor,
        json: true,
        messages: correction ? [...base, { role: 'user', content: correction }] : base,
      });
    } catch (err) {
      logger.error('actor', `actor call failed for ${ctx.character.username}`, { error: String(err) });
      // A thrown error here is a transport or provider problem (rate limit, timeout, a
      // non-2xx response), not a content problem - the one thing the retry budget should
      // absolutely not be skipped for. Retrying with the exact same request costs nothing
      // and silently swallowing a single flaky call is worth a lot: this used to send the
      // canned fallback on the very first hiccup, using neither of the two attempts.
      if (attempt === 0) continue;
      return fallbackOutput();
    }

    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      logger.warn('actor', 'actor returned unparseable JSON', { raw: text.slice(0, 500) });
      correction = retryHint(
        'it was not valid JSON',
        'Reply with a single JSON object and nothing else. No prose, no code fences.',
      );
      continue;
    }

    const out: ActorOutput = {
      messages: normalizeMessages(collectMessages(parsed)),
      hidden: normalizeHidden(collectHidden(parsed)),
    };
    if (out.messages.length === 0) {
      logger.warn('actor', 'actor produced no usable messages');
      correction = retryHint('it contained no usable message', 'Send at least one actual message.');
      continue;
    }

    // Word-for-word repeats of her own lines. First time round she rewrites; after that the
    // repeated lines are simply dropped rather than spending the last attempt on a fallback.
    const repeats = verbatimRepeats(out.messages.map((m) => m.text), longOwnHistory);
    if (repeats.length) {
      if (attempt === 0) {
        logger.warn('actor', 'rejected: repeated her own lines word for word', {
          character: ctx.character.username,
          messages: out.messages.map((m) => m.text),
        });
        correction = retryHint(
          'you repeated your own earlier lines word for word',
          `These are lines you already sent: ${repeats.map((i) => `"${out.messages[i].text}"`).join(', ')}. ` +
            'Never reuse a line. Say something new, in your own voice, that moves this forward.',
        );
        continue;
      }
      const kept = out.messages.filter((_, i) => !repeats.includes(i));
      if (kept.length) out.messages = kept.map((m, i) => (i === 0 ? { ...m, delay: 0 } : m));
    }

    // Handing him the work instead of bringing her own - see detectQuizzingHim.
    const quiz = attempt === 0 ? detectQuizzingHim(out.messages.map((m) => m.text)) : null;
    if (quiz) {
      logger.warn('actor', `rejected: quizzing him (${quiz})`, {
        character: ctx.character.username,
        messages: out.messages.map((m) => m.text),
      });
      correction = retryHint(
        `you handed the work to him (${quiz})`,
        'He is here to hear your fantasies and your side of things, not to guess at you or write the ' +
          'scene himself. Say it yourself instead: what you would do, what you have on, what you want, ' +
          'what happened - specific and yours. It is fine to end on a statement.',
      );
      continue;
    }

    const problem = out.messages
      .map((m, i) =>
        findVoiceProblem({
          text: m.text,
          isFirst: i === 0,
          lastUserMessage,
          writesFormally: writesFormally(ctx.character),
          recentOwnMessages,
          // Last attempt: two independently generated replies both reading as repetitive is
          // more likely a narrow-themed exchange than a model that is actually stuck, and
          // rejecting this one too would only spend the last retry on a fallback line.
          skipRepeatCheck: attempt > 0,
        }),
      )
      .find(Boolean);

    if (problem) {
      logger.warn('actor', `rejected: ${problem.what}`, {
        character: ctx.character.username,
        attempt,
        messages: out.messages.map((m) => m.text),
      });
      // See the budget note above the loop: only a break in frame earns the extra attempt.
      if (problem.what.startsWith('broke character')) budget = Math.min(3, budget + 1);
      correction = retryHint(problem.what, problem.fix);
      continue;
    }

    // Sending IS the move - her messages this turn already say a photo is coming. Before the
    // swap, or with images off, it would silently never arrive, so that becomes a normal
    // rewrite instead of a broken promise the player actually sees.
    if (out.hidden.photo_offer && !canSendPhotos(ctx.relationship)) {
      logger.warn('actor', 'rejected: offered a photo that cannot actually be sent right now', {
        character: ctx.character.username,
        attempt,
        offerKind: out.hidden.photo_offer,
        imagesEnabled: getSettings().images_enabled,
        messages: out.messages.map((m) => m.text),
      });
      correction = retryHint(
        'sending a photo while photos are not available in this chat',
        'You set photo_offer, but that would silently fail to reach him right now, leaving your ' +
          'messages promising a photo that never arrives. Write this turn again without offering one.',
      );
      continue;
    }

    if (attempt === 0 && isRelentlesslyWitty(out.messages.map((m) => m.text))) {
      logger.warn('actor', 'rejected: every message is a one-line quip', {
        character: ctx.character.username,
        messages: out.messages.map((m) => m.text),
      });
      correction = retryHint(
        'every message was the same polished one-liner',
        'Three quips in a row is a performance, not a conversation. Keep at most one good line. ' +
          'Let the others be ordinary, or say something real, or ask something you actually want to know.',
      );
      continue;
    }

    return out;
  }

  logger.error('actor', `actor failed twice for ${ctx.character.username}, using fallback`);
  return fallbackOutput();
}

export interface VoiceOutput {
  message: ActorMessage;
  hidden: ActorHidden;
}

export async function runActorVoice(ctx: ActorContext): Promise<VoiceOutput | null> {
  const settings = getSettings();
  if (!settings.voice_enabled) return null;
  const prompt = buildPrompt(ctx, 'actor_voice', '');
  try {
    const text = await complete({
      scope: 'actor',
      label: `voice:${ctx.character.username}`,
      schema: VOICE_NOTE,
      config: settings.models.actor,
      json: true,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed: any = extractJson(text);
    // Same drift as a chat reply: {"message": "..."}, {"text": "..."} or a list, as well as the asked-for shape.
    const first = collectMessages(parsed)[0];
    const body = String((typeof first === 'string' ? first : pick(first as any, ['text', 'message', 'content'])) ?? '').trim();
    if (!body) return null;
    // Voice messages may be prose, but still never narration.
    if (detectRoleplay(body)) {
      logger.warn('actor', 'voice message contained narration, dropped');
      return null;
    }
    const words = body.split(/\s+/).length;
    const duration = Math.max(
      4,
      Math.min(120, Math.round(Number(parsed?.message?.duration_seconds) || words / 2.5)),
    );
    return {
      message: {
        text: body,
        // A voice note is the whole turn, so it is the first message: no invented delay.
        delay: 0,
        kind: 'voice',
        duration_seconds: duration,
      },
      hidden: normalizeHidden(parsed?.hidden),
    };
  } catch (err) {
    logger.warn('actor', 'voice message generation failed', { error: String(err) });
    return null;
  }
}

/** Should she reach for a voice note this turn? */
export function wantsVoiceMessage(character: Character): boolean {
  if (!getSettings().voice_enabled) return false;
  // Off the attribute row rather than a literal-id switch, so a new tendency between
  // "rare" and "often" gets its own real probability instead of defaulting to never.
  const chance = Number(find('voice_msg_tendency', character.seed.voice_msg_tendency)?.extra?.chance ?? 0);
  return Math.random() < chance;
}
