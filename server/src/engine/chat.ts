import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  activeDate, addMessage, clearWakeup, deleteMessages, getCharacter, getMessage, getRelationship, getWakeup,
  markUserMessagesRead, recentMessages, saveRelationship, setCharacterState, type StoredMessage, updateMessageMeta,
  hasRealChatMessages, hasUserMessageAfter,
} from '../repo.js';
import type { Character, Relationship } from '../types.js';
import { runActor, runActorVoice, wantsVoiceMessage, type ActorRun } from './actor.js';
import { detectEvents, directionExpired, directionOutdatedBy, runDirector } from './director.js';
import { buildCatalogue, detectMentions, learnAboutHim, recordDiscoveries } from './discovery.js';
import { canSendPhotos, sendPhoto, sendPhotoChoice } from './images.js';
import { advanceRelease, releaseOf } from './release.js';
import { clearSteering, consumeCallback, normalizeScene, steeringToken } from './roleplay.js';
import { addInventedFantasy, markPitched } from './fantasies.js';
import { fantasyList } from './blocks.js';
import { applyOutfitChanges, currentOutfit, outfitMood } from './wardrobe.js';
import { gameClockMs, gameNowIso, messageClockMs } from './clock.js';
import { armConversationReopen, cancelConversationReopen } from './conversation-close.js';

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
  // A live date or call owns her attention. The text history stays readable, but is frozen.
  const live = activeDate(character.id);
  if (live) throw new Error(`you are on a ${live.kind} with her - end it to go back to texting`);
  const rel = getRelationship(character.id);
  if (!rel) throw new Error('relationship missing');

  // Only her own soft close can arm an automatic first text. If he writes first, the
  // conversation is already open again and both the world-time marker and any due wakeup go.
  cancelConversationReopen(rel);

  // A first message from him expires the generated opening plan, even if her opener is
  // already in flight. It must never be injected into the normal reply that follows.
  if (!hasRealChatMessages(character.id) && rel.ledger.director_notes?.plans.length) {
    rel.ledger.director_notes.plans = [];
  }

  // The world clock runs continuously. Only a user-paused clock needs the documented
  // one-minute fallback per visible bubble.
  const sentAtGameMs = messageClockMs();
  const stored = addMessage({
    character_id: character.id,
    sender: 'user',
    text: input.text,
    kind: input.kind ?? 'text',
    meta: input.meta,
    game_clock_ms: sentAtGameMs,
  });
  bus.emitEvent({ type: 'message', character_id: character.id, message: stored });

  // Writing to her cancels the one scheduled wakeup, if it was set to be cancellable.
  const wakeup = getWakeup(character.id);
  if (wakeup?.cancel_if_user_writes) clearWakeup(character.id);

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
  const receipt: ActorReceipt = { epoch };
  try {
    await runTurn(characterId, opts, receipt);
  } finally {
    releaseTurn(characterId);
    await answerAfterSnapshot(characterId, receipt);
  }
}

interface ActorReceipt { epoch: number; historyThroughId?: number }

async function answerAfterSnapshot(characterId: string, receipt: ActorReceipt): Promise<void> {
  // A second send used to lose claimTurn() while the first request was in flight. Queueing
  // every failed claim would instead double-answer messages the Actor had already seen.
  // Only IDs beyond its frozen snapshot require one coalesced turn, after releasing the
  // lock. Failures cannot retry themselves: a follow-up needs a strictly newer user ID.
  if (epoch !== receipt.epoch || receipt.historyThroughId === undefined ||
      !hasUserMessageAfter(characterId, receipt.historyThroughId)) return;
  await takeTurn(characterId, { trigger: 'user_message' });
}

async function runTurn(characterId: string, opts: TurnOptions, receipt: ActorReceipt): Promise<void> {
  const startedIn = epoch;
  let character = getCharacter(characterId);
  let rel = getRelationship(characterId);
  if (!character || !rel) return;
  if (character.state !== 'matched') return;

  // A live roleplay owns this channel. Whatever queued this turn is not also answered by text.
  const live = activeDate(characterId);
  if (live) {
    logger.debug('actor', `${character.username} is on a ${live.kind}, no text messages`);
    return;
  }

  const freshOpener = opts.trigger === 'match_opener' && !hasRealChatMessages(character.id);
  const trigger = opts.trigger === 'match_opener' && !freshOpener ? 'user_message' : opts.trigger;
  if (!freshOpener && rel.ledger.director_notes?.plans.length) {
    rel.ledger.director_notes.plans = [];
    saveRelationship(rel);
  }
  const messages = recentMessages(character.id, getSettings().chat.context_messages);
  const events = detectEvents(messages);
  const check = directionExpired(rel, events);
  const lastUser = [...messages].reverse().find((m) => m.sender === 'user');
  const outdated = trigger === 'user_message' && !!lastUser && directionOutdatedBy(rel, Date.parse(lastUser.sent_at));
  const needsDirector = !freshOpener && (
    opts.forceDirector ||
    check.expired ||
    outdated ||
    trigger === 'wakeup' ||
    trigger === 'initiative');

  if (needsDirector) {
    await runDirector(character, rel, {
      reason: opts.reason ?? (check.expired ? check.reason : outdated ? 'he replied - direction outdated' : opts.trigger),
      origin: trigger === 'user_message' ? 'user' : 'unprompted',
    });
    rel = getRelationship(characterId)!;
    character = getCharacter(characterId)!;
  }

  await runActorPhase(character, rel, {
    startedIn,
    decrementValidFor: true,
    initiative: trigger === 'initiative',
    opener: freshOpener,
    receipt,
  });
}

/**
 * The Actor call, delivery and post-turn bookkeeping, shared between a normal turn and a
 * regenerate. `decrementValidFor` is false for a regenerate: the original turn already
 * spent one use of the direction, and a reroll of its text should not spend a second.
 */
async function runActorPhase(
  character: Character,
  rel: Relationship,
  opts: { startedIn: number; decrementValidFor: boolean; initiative?: boolean; opener?: boolean; receipt: ActorReceipt },
): Promise<void> {
  const characterId = character.id;
  const { startedIn } = opts;
  if (epoch !== startedIn || !getCharacter(characterId)) return;
  // Recheck at the snapshot boundary: a match notification is not proof of an empty chat.
  if (opts.opener && hasRealChatMessages(characterId)) {
    opts.opener = false;
    rel = getRelationship(characterId)!;
    rel.ledger.director_notes.plans = [];
    saveRelationship(rel);
    await runDirector(character, rel, { reason: 'he wrote before the opener', origin: 'user' });
    if (epoch !== startedIn) return;
    character = getCharacter(characterId)!;
    rel = getRelationship(characterId)!;
    if (!character || !rel) return;
  }
  // This is the one Actor history read: it happens after the Director, so anything sent
  // during that request is already seen. The larger window also serves repeat diagnostics.
  const history = recentMessages(characterId, Math.max(60, getSettings().chat.context_messages))
    .filter((message) => !message.meta?.failed);
  opts.receipt.historyThroughId = history.at(-1)?.id ?? 0;
  const opener = !!opts.opener && !hasRealChatMessages(characterId);
  const openingPlan = opener ? rel.ledger.director_notes?.plans[0]?.text : undefined;
  if (opener) rel.active_direction = null;
  if (markUserMessagesRead(characterId, opts.receipt.historyThroughId) > 0) {
    bus.emitEvent({ type: 'read', character_id: characterId, at: nowIso() });
  }

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
  const roleplaySteeringAt = steeringToken(rel, 'chat');
  // The message she is answering, if the last word was his - the only thing a reaction can land on.
  const answering = history.at(-1);
  const replyTo = answering?.sender === 'user' ? answering : null;

  let result: ActorRun;
  try {
    showTyping();

    // The initiative/opener nudges are written for a text turn; a voice note would drop them.
    const useVoice = !opts.initiative && !opener && wantsVoiceMessage(character);
    const ctx = {
      character, relationship: rel, direction: rel.active_direction,
      initiative: opts.initiative, opener, openingPlan, history,
    };
    const output = useVoice
      ? await runActorVoice(ctx).then((v) => (v ? { messages: [v.message], hidden: v.hidden } : null))
      : null;
    result = output ?? (await runActor(ctx));
    if (epoch !== startedIn) return;

    // Refetched before her reply is stored, not after: the actor call can take a while, and a
    // message he sent in the meantime (with its own clock tick already saved) must not be
    // clobbered by whatever `rel` looked like when this turn started.
    const fresh = getRelationship(characterId);
    if (!fresh || epoch !== startedIn) return;
    rel = fresh;
    saveRelationship(rel);

    await deliver(character, result.messages, startedIn, opts.decrementValidFor);
  } finally {
    // Every exit path clears it, including a thrown call or an abandoned turn. A stuck
    // indicator is worse than none.
    stopTyping();
  }

  // A canned recovery bubble is marked failed in the UI and is not something she actually
  // said. Do not let it spend a direction, alter her mood, advance sexual continuity, or
  // trigger another Director pass. The next real turn starts from the last real state.
  if (result.messages.every((message) => message.failed)) return;
  if (epoch !== startedIn) return;
  // Delivery can include a delay between bubbles. Preserve any user clock/plan updates
  // saved in that gap rather than writing the pre-delivery relationship back over them.
  rel = getRelationship(characterId)!;
  if (!rel) return;
  if (opener) {
    rel.ledger.director_notes.plans = [];
    rel.active_direction = null;
    rel.direction_set_at = null;
  }

  // What she has on after this turn: only her reported changes are applied (wardrobe.ts).
  // Before any photo from this turn is prepared, so a photo shows the outfit she just
  // described rather than the one before it.
  rel.mood = {
    ...rel.mood,
    ...outfitMood(applyOutfitChanges(character.seed, currentOutfit(rel, character.seed), result.hidden.outfit_changes)),
  };
  // Saved now: a photo from this turn starts preparing synchronously below and reads it.
  saveRelationship(rel);
  if (opts.decrementValidFor && rel.active_direction) {
    rel.active_direction.valid_for = Math.max(0, rel.active_direction.valid_for - 1);
  }
  // The story's own clock (engine/clock.ts), not the real one: this is what lets the
  // Director see "last contact" and "time now" line up until he actually passes time.
  rel.last_contact_at = gameNowIso(rel);
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
  const photoLocation = result.hidden.location || String((rel.mood as any)?.location ?? '');
  const situatedPhoto = (situation: string) => photoLocation && situation
    ? `Location: ${photoLocation}. Photo: ${situation}`
    : situation;
  if (photoKind && canSendPhotos(rel) && options.length === 2) {
    // "Which one?" - two placeholders, he picks the one he sees.
    void sendPhotoChoice({
      characterId: character.id,
      kind: photoKind,
      options: options.map(situatedPhoto),
      aspect: result.hidden.photo_aspect ?? 'portrait',
      showsFace: result.hidden.photo_shows_face ?? true,
    }).catch((err) => logger.error('image', 'photo choice failed', { error: String(err) }));
    logger.debug('actor', `${character.username} is offering a choice of two ${photoKind} photos`);
  } else if (photoKind && canSendPhotos(rel)) {
    void sendPhoto({
      characterId: character.id,
      kind: photoKind,
      situation: situatedPhoto(result.hidden.photo_situation ?? ''),
      aspect: result.hidden.photo_aspect ?? 'portrait',
      showsFace: result.hidden.photo_shows_face ?? true,
    }).catch((err) => logger.error('image', 'photo failed', { error: String(err) }));
    logger.debug('actor', `${character.username} is sending a ${photoKind} photo`);
  }

  rel.mood = {
    ...rel.mood,
    actor_mood: result.hidden.mood,
    thoughts: result.hidden.thoughts,
    // Old saves may contain this field. Null it rather than letting a model-authored
    // "unfinished" label turn a passing bit into a mandatory loop on every later turn.
    unresolved: null,
    // Real continuity, read back by continuityBlock() next turn - an empty string means she
    // reported no change, not that she has nowhere/nothing/no plans, so it falls back to
    // whatever was already stored rather than wiping it.
    location: result.hidden.location || (rel.mood as any)?.location || '',
    activity: result.hidden.activity || (rel.mood as any)?.activity || '',
    scene: normalizeScene(result.hidden.scene, (rel.mood as any)?.scene),
    // Left over from the old consent cards; cleared so nothing reads them again.
    pending_photo: null,
    pending_exchange: null,
  };
  clearSteering(rel, 'chat', roleplaySteeringAt);
  consumeCallback(rel, result.hidden.callback_used);
  if (result.hidden.ending === 'soft_close') {
    // Her explicit full stop creates the one legitimate route to a later first text. The
    // marker uses fictional world time, so pausing freezes it and a manual jump can mature it.
    clearWakeup(character.id);
    if (getSettings().unprompted_messages) {
      armConversationReopen(rel, getSettings().conversation_reopen_hours);
    } else {
      cancelConversationReopen(rel);
    }
    rel.active_direction = null;
    rel.direction_set_at = null;
  } else {
    cancelConversationReopen(rel);
  }
  saveRelationship(rel);
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
 * to her list first.
 */
function pitchedFantasy(character: Character, result: ActorRun): string | null {
  if (result.hidden.new_fantasy) {
    const added = addInventedFantasy(character, result.hidden.new_fantasy);
    if (added) return added;
  }
  const list = fantasyList(character.seed);
  const n = result.hidden.fantasy_pitched;
  if (n && list[n - 1]) return list[n - 1];
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

  // A reroll replaces the closing turn itself. Disarm its timer now; the replacement may
  // deliberately soft-close again and arm a fresh one after it has actually been delivered.
  cancelConversationReopen(rel);
  clearWakeup(characterId);
  saveRelationship(rel);

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
  const receipt: ActorReceipt = { epoch: startedIn };
  void (async () => {
    let current = rel;
    if (refresh) {
      await runDirector(character, rel, { reason: 'regenerate - direction outdated', origin: 'user' });
      current = getRelationship(characterId) ?? rel;
    }
    await runActorPhase(character, current, { startedIn, decrementValidFor: false, receipt });
  })()
    .catch((err) => logger.error('actor', 'regenerate failed', { error: String(err) }))
    .finally(async () => {
      releaseTurn(characterId);
      await answerAfterSnapshot(characterId, receipt);
    })
    .catch((err) => logger.error('actor', 'follow-up failed', { error: String(err) }));

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

/**
 * Play the messages out over time with a typing indicator, the way a person types. Every
 * bubble in this call is one reply block in the fiction, so they all carry the same in-game
 * timestamp (`gameClockMsAtDelivery`) even though they land seconds apart in real time.
 */
async function deliver(
  character: Character,
  messages: { text: string; delay: number; kind?: string; duration_seconds?: number; failed?: boolean; from?: string }[],
  startedIn: number,
  advancePausedClock: boolean,
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
        // Her duo partner wrote this one (duo.ts); the client labels the bubble with her name.
        ...(m.from ? { from: m.from } : {}),
      },
      read_at: null,
      game_clock_ms: advancePausedClock ? messageClockMs() : gameClockMs(),
    });
    bus.emitEvent({ type: 'message', character_id: character.id, message: stored });
  }
}

export async function blockCharacterByUser(characterId: string): Promise<void> {
  setCharacterState(characterId, 'blocked_by_user');
  clearWakeup(characterId);
  bus.emitEvent({ type: 'character_state', character_id: characterId, state: 'blocked_by_user' });
}
