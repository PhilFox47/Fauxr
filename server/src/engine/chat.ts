import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  activeDate, addMessage, clearWakeup, deleteMessages, getCharacter, getMessage, getRelationship, getWakeup,
  markUserMessagesRead, recentMessages, saveRelationship, setCharacterState, type StoredMessage, updateMessageMeta,
} from '../repo.js';
import type { Character, Relationship } from '../types.js';
import { runActor, runActorVoice, wantsVoiceMessage, type ActorRun } from './actor.js';
import { detectEvents, directionExpired, directionOutdatedBy, runDirector } from './director.js';
import { markThreadRaised } from './state.js';
import { buildCatalogue, detectMentions, learnAboutHim, recordDiscoveries } from './discovery.js';
import { canSendPhotos, sendPhoto, sendPhotoChoice } from './images.js';
import { advanceRelease, releaseOf } from './release.js';
import { addInventedFantasy, markPitched } from './fantasies.js';
import { fantasyList } from './blocks.js';

/** One turn at a time per character, so a wakeup and a user message cannot interleave. */
const running = new Set<string>();

/**
 * Bumped by a reset. A turn can sit in an API call or in a delivery delay for a minute or
 * more, so rather than waiting for those to finish, they check the epoch they started in
 * and abandon their work if the world has been wiped underneath them.
 */
let epoch = 0;

export function currentEpoch(): number {
  return epoch;
}

/**
 * Whether she is mid-turn right now. Backs a REST fallback for the typing indicator: the
 * indicator's primary path is the WebSocket 'typing' event, but a reverse proxy that does
 * not forward the Upgrade handshake silently breaks that with no error the app can detect,
 * so the chat screen also polls this instead of relying on push alone.
 */
export function isRunning(characterId: string): boolean {
  return running.has(characterId);
}

export function abandonRunningTurns(): void {
  epoch++;
  running.clear();
}

/**
 * The turn lock, shared with engine/dates.ts so a date beat and a texting turn can never run
 * for the same character at once. Returns false if she is already busy.
 */
export function claimTurn(characterId: string): boolean {
  if (running.has(characterId)) return false;
  running.add(characterId);
  return true;
}

export function releaseTurn(characterId: string): void {
  running.delete(characterId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UserMessageInput {
  characterId: string;
  text: string;
  kind?: 'text' | 'image';
  meta?: Record<string, any>;
  /**
   * Store the message but do not start her turn. The image upload uses this so the vision
   * pass can describe the photo before she replies to it; it starts the turn itself.
   */
  deferTurn?: boolean;
}

export async function handleUserMessage(input: UserMessageInput): Promise<StoredMessage> {
  const character = getCharacter(input.characterId);
  if (!character) throw new Error('character not found');
  if (character.state !== 'matched') throw new Error(`cannot write to a character in state ${character.state}`);
  // She is sitting across from him. Texting her from the same table is the one thing the
  // date mechanic exists to prevent - the text chat stays readable, but it is frozen.
  if (activeDate(character.id)) throw new Error('you are on a date with her - end it to go back to texting');
  const rel = getRelationship(character.id);
  if (!rel) throw new Error('relationship missing');

  const stored = addMessage({
    character_id: character.id,
    sender: 'user',
    text: input.text,
    kind: input.kind ?? 'text',
    meta: input.meta,
  });
  bus.emitEvent({ type: 'message', character_id: character.id, message: stored });

  // Writing to her cancels the one scheduled wakeup, if it was set to be cancellable.
  const wakeup = getWakeup(character.id);
  if (wakeup?.cancel_if_user_writes) clearWakeup(character.id);

  // He replied - the silence that may have earned an unanswered follow-up (a double-text or
  // a proactive check-in) is over, so a future one is fair game again. See maybeDoubleText()
  // and maybeBeProactive() in scheduler.ts - both share this one flag so at most one
  // unprompted follow-up ever goes out while he has not replied, not one of each.
  if ((rel.mood as any)?.followed_up_unanswered) {
    rel.mood = { ...rel.mood, followed_up_unanswered: false };
  }

  // She only knows what he likes because he said it, and only in this conversation - the
  // match he told last week knows, the one he matched this morning does not.
  const learned = learnAboutHim(rel, input.text);
  if (learned.length) logger.debug('actor', `${character.username} learned his stance on ${learned.join(', ')}`);

  saveRelationship(rel);
  if (input.deferTurn) return stored;

  void takeTurn(character.id, { trigger: 'user_message' }).catch((err) =>
    logger.error('actor', 'turn failed', { error: String(err) }),
  );
  return stored;
}

export interface TurnOptions {
  /** 'initiative' is the "your move" button: she texts first, on her own impulse. */
  trigger: 'user_message' | 'wakeup' | 'match_opener' | 'catch_up' | 'initiative';
  reason?: string;
  /** Force a Director pass before the Actor runs. */
  forceDirector?: boolean;
}

export async function takeTurn(characterId: string, opts: TurnOptions): Promise<void> {
  if (!claimTurn(characterId)) return;
  try {
    await runTurn(characterId, opts);
  } finally {
    releaseTurn(characterId);
  }
}

async function runTurn(characterId: string, opts: TurnOptions): Promise<void> {
  const startedIn = epoch;
  let character = getCharacter(characterId);
  let rel = getRelationship(characterId);
  if (!character || !rel) return;
  if (character.state !== 'matched') return;

  // She is out with him in person. Whatever queued this turn - a wakeup that survived the
  // start of the date, a catch-up sweep - she is not going to text him from the table.
  if (activeDate(characterId)) {
    logger.debug('actor', `${character.username} is on a date, no text messages`);
    return;
  }

  if (markUserMessagesRead(character.id) > 0) {
    bus.emitEvent({ type: 'read', character_id: character.id, at: nowIso() });
  }

  const messages = recentMessages(character.id, getSettings().chat.context_messages);
  const events = detectEvents(messages);
  const check = directionExpired(rel, null, events);
  const lastUser = [...messages].reverse().find((m) => m.sender === 'user');
  const outdated = opts.trigger === 'user_message' && !!lastUser && directionOutdatedBy(rel, Date.parse(lastUser.sent_at));
  const needsDirector =
    opts.forceDirector ||
    check.expired ||
    outdated ||
    opts.trigger === 'wakeup' ||
    opts.trigger === 'match_opener' ||
    opts.trigger === 'initiative' ||
    isStaleSession(rel);

  if (needsDirector) {
    await runDirector(character, rel, {
      reason: opts.reason ?? (check.expired ? check.reason : outdated ? 'he replied - direction outdated' : opts.trigger),
      origin: opts.trigger === 'user_message' ? 'user' : 'unprompted',
    });
    rel = getRelationship(characterId)!;
    character = getCharacter(characterId)!;
  }

  await runActorPhase(character, rel, { startedIn, decrementValidFor: true, initiative: opts.trigger === 'initiative' });
}

/**
 * The Actor call, delivery and post-turn bookkeeping, shared between a normal turn and a
 * regenerate. `decrementValidFor` is false for a regenerate: the original turn already
 * spent one use of the direction, and a reroll of its text should not spend a second.
 */
async function runActorPhase(
  character: Character,
  rel: Relationship,
  opts: { startedIn: number; decrementValidFor: boolean; initiative?: boolean },
): Promise<void> {
  const characterId = character.id;
  const { startedIn } = opts;

  /**
   * The typing indicator covers the whole time she is composing, not only the pauses
   * between her messages. Writing a reply means an actor call, which takes seconds, and
   * the first message is sent with no delay of its own - so without this the chat just
   * sits there silently until her first bubble appears out of nowhere.
   */
  let typingShown = false;
  const showTyping = () => {
    if (typingShown) return;
    typingShown = true;
    bus.emitEvent({ type: 'typing', character_id: characterId, on: true });
  };
  const stopTyping = () => {
    if (!typingShown) return;
    typingShown = false;
    bus.emitEvent({ type: 'typing', character_id: characterId, on: false });
  };

  // Where the climax tracker stood when her prompt was built - see engine/release.ts.
  const releaseBefore = releaseOf(rel);
  // The message she is answering, if the last word was his - the only thing a reaction can land on.
  const answering = recentMessages(characterId, 1)[0];
  const replyTo = answering?.sender === 'user' ? answering : null;

  let result: ActorRun;
  try {
    showTyping();

    // The initiative nudge is written for a text turn; a voice note would drop it.
    const useVoice = !opts.initiative && wantsVoiceMessage(character);
    const ctx = { character, relationship: rel, direction: rel.active_direction, initiative: opts.initiative };
    const output = useVoice
      ? await runActorVoice(ctx).then((v) => (v ? { messages: [v.message], hidden: v.hidden } : null))
      : null;
    result = output ?? (await runActor(ctx));
    if (epoch !== startedIn) return;

    await deliver(character, result.messages, startedIn);
  } finally {
    // Every exit path clears it, including a thrown call or an abandoned turn. A stuck
    // indicator is worse than none.
    stopTyping();
  }

  const fresh = getRelationship(characterId);
  if (!fresh || epoch !== startedIn) return;
  rel = fresh;
  if (opts.decrementValidFor && rel.active_direction) {
    rel.active_direction.valid_for = Math.max(0, rel.active_direction.valid_for - 1);
  }
  rel.last_contact_at = nowIso();
  if (result.hidden.new_fact) {
    rel.ledger.facts.about_user = [
      ...new Set([...(rel.ledger.facts.about_user ?? []), result.hidden.new_fact]),
    ].slice(-60);
  }
  if (result.hidden.open_thread && !rel.ledger.open_threads.some((t) => t.text === result.hidden.open_thread)) {
    rel.ledger.open_threads = [
      ...rel.ledger.open_threads,
      {
        id: `${Date.now()}-a`,
        text: result.hidden.open_thread,
        expires_when: 'when it comes up',
        created_at: nowIso(),
      },
    ].slice(-8);
  }
  // Deterministic backstop for the obvious reveals - if she named her job, he knows it,
  // whether or not the director thought to report it.
  const said = result.messages.map((m) => m.text).join(' ');
  const spotted = detectMentions(character, rel, said);
  if (spotted.length) {
    const valid = new Set(buildCatalogue(character).map((f) => f.key));
    const added = recordDiscoveries(rel, spotted, valid);
    if (added.length) logger.debug('actor', `revealed in passing: ${added.join(', ')}`);
  }

  applyReaction(characterId, replyTo, result.hidden.react);
  // A regenerate rewrites the same moment, so it does not move the tracker a second time.
  if (opts.decrementValidFor) advanceRelease(character, rel, releaseBefore, result.hidden.in_the_act);

  // She started one of her games: log it, so the cooldown and the no-repeat rule hold.
  if (result.nudgedGame) {
    const games = ((rel.mood as any)?.games ?? {}) as { last_at?: string; played?: Record<string, string> };
    const at = nowIso();
    rel.mood = { ...rel.mood, games: { last_at: at, played: { ...(games.played ?? {}), [result.nudgedGame]: at } } };
  }

  // A thread she was told to raise is now spent, whether or not he engaged with it.
  if (result.raisedThreadId) markThreadRaised(rel, result.raisedThreadId);

  // She pitched a fantasy: log it, so it shows on her profile and she knows he has heard it. A
  // brand-new one she made up joins her list. Playing it out happens in the conversation itself
  // (or on a date) - there is no separate mode for it.
  const pitched = pitchedFantasy(character, result);
  if (pitched) {
    const firstTime = markPitched(rel, pitched);
    logger.debug('actor', `${character.username} pitched a fantasy`, { fantasy: pitched, firstTime });
  }

  // She decided to send a photo, so it is sent: prepared in the background (her idea, the
  // prompt, a caption) and posted as a placeholder he can choose to open - see sendPhoto.
  const photoKind = result.hidden.photo_offer;
  const options = result.hidden.photo_options ?? [];
  if (photoKind && canSendPhotos(rel) && options.length === 2) {
    // "Which one?" - two placeholders, he picks the one he sees.
    void sendPhotoChoice({
      characterId: character.id,
      kind: photoKind,
      options,
      aspect: result.hidden.photo_aspect ?? 'portrait',
      showsFace: result.hidden.photo_shows_face ?? true,
    }).catch((err) => logger.error('image', 'photo choice failed', { error: String(err) }));
    logger.debug('actor', `${character.username} is offering a choice of two ${photoKind} photos`);
  } else if (photoKind && canSendPhotos(rel)) {
    void sendPhoto({
      characterId: character.id,
      kind: photoKind,
      situation: result.hidden.photo_situation ?? '',
      aspect: result.hidden.photo_aspect ?? 'portrait',
      showsFace: result.hidden.photo_shows_face ?? true,
    }).catch((err) => logger.error('image', 'photo failed', { error: String(err) }));
    logger.debug('actor', `${character.username} is sending a ${photoKind} photo`);
  }

  rel.mood = {
    ...rel.mood,
    actor_mood: result.hidden.mood,
    thoughts: result.hidden.thoughts,
    // Carried to the next turn so nothing opens a second topic on top of a live one.
    unresolved: result.hidden.unresolved,
    // Real continuity, read back by continuityBlock() next turn - an empty string means she
    // reported no change, not that she has nowhere/nothing/no plans, so it falls back to
    // whatever was already stored rather than wiping it.
    location: result.hidden.location || (rel.mood as any)?.location || '',
    outfit: result.hidden.outfit || (rel.mood as any)?.outfit || '',
    activity: result.hidden.activity || (rel.mood as any)?.activity || '',
    // Left over from the old consent cards; cleared so nothing reads them again.
    pending_photo: null,
    pending_exchange: null,
  };
  saveRelationship(rel);

  if (result.hidden.director_needed) {
    await runDirector(character, getRelationship(characterId)!, {
      reason: 'actor_requested',
      actorReport: result.hidden,
      origin: 'user',
    });
  }
}

/**
 * She taps an emoji on his message. Off by default - the Actor is told to leave it null unless
 * the message really landed - and capped here as well, because "only when it matters" in a
 * prompt drifts towards "most turns": if any of his last four messages already carries one,
 * this one does not get another.
 */
function applyReaction(characterId: string, replyTo: StoredMessage | null, react: string | null): void {
  if (!react || !replyTo || replyTo.meta?.reaction) return;
  const hisRecent = recentMessages(characterId, 16).filter((m) => m.sender === 'user').slice(-4);
  if (hisRecent.some((m) => m.meta?.reaction)) return;
  const updated = updateMessageMeta(replyTo.id, { reaction: react });
  if (updated) bus.emitEvent({ type: 'message_updated', character_id: characterId, message: updated });
}

/**
 * Which fantasy, if any, she pitched this turn. Her own report wins; a brand-new one is added
 * to her list first. The nudge that told her to pitch one is the fallback when she did not say.
 */
function pitchedFantasy(character: Character, result: ActorRun): string | null {
  if (result.hidden.new_fantasy) {
    const added = addInventedFantasy(character, result.hidden.new_fantasy);
    if (added) return added;
  }
  const list = fantasyList(character.seed);
  const n = result.hidden.fantasy_pitched;
  if (n && list[n - 1]) return list[n - 1];
  if (result.nudgedFantasy && list.includes(result.nudgedFantasy)) return result.nudgedFantasy;
  return null;
}

/**
 * Reroll her most recent reply - the small redo button next to the timestamp. Only the
 * trailing run of her messages (the last turn) can be regenerated: anything older has
 * already had its arousal and ledger effects folded into the relationship, and undoing those
 * cleanly is not something this can do safely. If the user has replied since, that turn is
 * done and there is nothing left to reroll.
 *
 * The Director is not re-run - the original turn already directed this moment, and running
 * it twice would double-apply the arousal delta. This only asks the Actor to write different
 * words for the same direction.
 */
export async function regenerateLastTurn(characterId: string, messageId: number): Promise<{ removed_ids: number[] }> {
  if (running.has(characterId)) {
    throw new Error('she is already in the middle of replying');
  }
  const character = getCharacter(characterId);
  const rel = getRelationship(characterId);
  if (!character || !rel) throw new Error('character not found');
  if (character.state !== 'matched') throw new Error('cannot regenerate for an unmatched character');

  const recent = recentMessages(characterId, 20);
  const trailing: StoredMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].sender !== 'character') break;
    trailing.unshift(recent[i]);
  }
  if (trailing.length === 0) {
    throw new Error('the last message is not hers - nothing to regenerate');
  }
  if (!trailing.some((m) => m.id === messageId)) {
    throw new Error('that reply has already been superseded');
  }

  const removedIds = trailing.map((m) => m.id);
  deleteMessages(removedIds);
  bus.emitEvent({ type: 'messages_removed', character_id: characterId, message_ids: removedIds });
  logger.info('actor', `regenerating last turn for ${character.username}`, { removed: removedIds });

  running.add(characterId);
  const startedIn = epoch;
  // A reroll normally keeps the direction - but not one that was already out of date when
  // his message came in, or every reroll just repeats the same wrong reply in new words.
  const lastUser = [...recent].reverse().find((m) => m.sender === 'user');
  const refresh = !!lastUser && directionOutdatedBy(rel, Date.parse(lastUser.sent_at));
  void (async () => {
    let current = rel;
    if (refresh) {
      await runDirector(character, rel, { reason: 'regenerate - direction outdated', origin: 'user' });
      current = getRelationship(characterId) ?? rel;
    }
    await runActorPhase(character, current, { startedIn, decrementValidFor: false });
  })()
    .catch((err) => logger.error('actor', 'regenerate failed', { error: String(err) }))
    .finally(() => running.delete(characterId));

  return { removed_ids: removedIds };
}

/**
 * A plain delete, for either side of the conversation - typing something and wanting it gone
 * again, not a reroll. Unlike regenerateLastTurn this carries no restriction on position: an
 * older message can be deleted too, since nothing here tries to undo whatever it already fed
 * into arousal or the ledger - it just stops being shown, and stops being read as context
 * from here on. Blocked only while a turn for her is actually in flight, so it cannot delete
 * a message out from under the context that turn is using.
 */
export function deleteMessage(characterId: string, messageId: number): void {
  if (running.has(characterId)) {
    throw new Error('she is already in the middle of replying');
  }
  const message = getMessage(messageId);
  if (!message || message.character_id !== characterId) {
    throw new Error('message not found');
  }
  deleteMessages([messageId]);
  bus.emitEvent({ type: 'messages_removed', character_id: characterId, message_ids: [messageId] });
}

function isStaleSession(rel: Relationship): boolean {
  if (!rel.last_contact_at) return true;
  return Date.now() - Date.parse(rel.last_contact_at) > 6 * 3_600_000;
}

/** Play the messages out over time with a typing indicator, the way a person types. */
async function deliver(
  character: Character,
  messages: { text: string; delay: number; kind?: string; duration_seconds?: number; failed?: boolean }[],
  startedIn: number,
): Promise<void> {
  for (const m of messages) {
    // The indicator is held on by the caller for the whole turn, so this only paces.
    if (m.delay > 0) {
      await sleep(m.delay * 1000);
      if (epoch !== startedIn) return;
    }

    const stored = addMessage({
      character_id: character.id,
      sender: 'character',
      text: m.text,
      kind: m.kind === 'voice' ? 'voice' : 'text',
      // `failed` marks the canned line sent when generation genuinely failed twice, so the
      // client can flag it instead of letting it pass as a real message she typed.
      meta: {
        ...(m.duration_seconds ? { duration_seconds: m.duration_seconds } : {}),
        ...(m.failed ? { failed: true } : {}),
      },
      read_at: null,
    });
    bus.emitEvent({ type: 'message', character_id: character.id, message: stored });
  }
}

export async function blockCharacterByUser(characterId: string): Promise<void> {
  setCharacterState(characterId, 'blocked_by_user');
  clearWakeup(characterId);
  bus.emitEvent({ type: 'character_state', character_id: characterId, state: 'blocked_by_user' });
}
