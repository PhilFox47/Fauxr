import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  addMessage, clearWakeup, deleteMessages, getCharacter, getRelationship, getWakeup,
  markUserMessagesRead, recentMessages, saveRelationship, setCharacterState, updateMessageMeta, type StoredMessage,
} from '../repo.js';
import type { Character, PendingExchange, PendingPhoto, Relationship } from '../types.js';
import { runActor, runActorVoice, wantsVoiceMessage, type ActorRun } from './actor.js';
import { detectEvents, directionExpired, runDirector } from './director.js';
import { computePressure, computeReciprocity } from './modifiers.js';
import { alwaysOnline, isOnline } from './presence.js';
import { randInt } from './dice.js';
import { clearExpiredNegativeFlags, hasActiveNegativeFlag, markThreadRaised } from './state.js';
import { buildCatalogue, detectMentions, learnAboutHim, recordDiscoveries, trackMessageForCredit } from './discovery.js';
import { enqueueImage, photoOfferEligible, hasProfileImageJob } from './images.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refreshModifiers(
  rel: Relationship,
  messages: StoredMessage[],
  boundaryTouched: boolean,
): void {
  const hoursElapsed = rel.last_contact_at
    ? (Date.now() - Date.parse(rel.last_contact_at)) / 3_600_000
    : 0;
  rel.reciprocity = computeReciprocity(messages);
  rel.pressure = computePressure({
    previous: rel.pressure,
    hoursElapsed,
    messages,
    boundaryTouched,
    negativeFlagActive: hasActiveNegativeFlag(rel),
  });
}

export interface UserMessageInput {
  characterId: string;
  text: string;
  kind?: 'text' | 'image';
  meta?: Record<string, any>;
}

export async function handleUserMessage(input: UserMessageInput): Promise<StoredMessage> {
  const character = getCharacter(input.characterId);
  if (!character) throw new Error('character not found');
  if (character.state !== 'matched') throw new Error(`cannot write to a character in state ${character.state}`);
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

  const messages = recentMessages(character.id, getSettings().chat.context_messages);
  refreshModifiers(rel, messages, false);
  clearExpiredNegativeFlags(rel);
  // She only knows what he likes because he said it, and only in this conversation - the
  // match he told last week knows, the one he matched this morning does not.
  const learned = learnAboutHim(rel, input.text);
  if (learned.length) logger.debug('actor', `${character.username} learned his stance on ${learned.join(', ')}`);

  // Showing up earns something concrete, independent of anything she chooses to reveal
  // herself - see discovery.ts's trackMessageForCredit().
  if (trackMessageForCredit(rel)) {
    logger.debug('actor', `${character.username}: earned a trait-uncover credit`, {
      messages_sent: rel.flags.state.messages_sent_count,
      trait_credits: rel.flags.state.trait_credits,
    });
  }
  saveRelationship(rel);

  if (!isOnline(character)) {
    // She is offline: the message waits, unread. This is the intended behaviour.
    logger.debug('actor', `${character.username} is offline, message queued`);
    return stored;
  }

  void takeTurn(character.id, { trigger: 'user_message' }).catch((err) =>
    logger.error('actor', 'turn failed', { error: String(err) }),
  );
  return stored;
}

export interface TurnOptions {
  trigger: 'user_message' | 'wakeup' | 'match_opener' | 'catch_up';
  reason?: string;
  /** Force a Director pass before the Actor runs. */
  forceDirector?: boolean;
}

export async function takeTurn(characterId: string, opts: TurnOptions): Promise<void> {
  if (running.has(characterId)) return;
  running.add(characterId);
  try {
    await runTurn(characterId, opts);
  } finally {
    running.delete(characterId);
  }
}

async function runTurn(characterId: string, opts: TurnOptions): Promise<void> {
  const startedIn = epoch;
  let character = getCharacter(characterId);
  let rel = getRelationship(characterId);
  if (!character || !rel) return;
  if (character.state !== 'matched') return;

  // She said she was going. She is actually gone, mid-conversation or not.
  if (isAway(rel) && opts.trigger === 'user_message') {
    logger.debug('actor', `${character.username} said she was leaving and is away`);
    return;
  }

  // She only reads once she is actually online.
  if (markUserMessagesRead(character.id) > 0) {
    bus.emitEvent({ type: 'read', character_id: character.id, at: nowIso() });
  }

  const messages = recentMessages(character.id, getSettings().chat.context_messages);
  const events = detectEvents(messages);
  const check = directionExpired(rel, null, events);
  const needsDirector =
    opts.forceDirector ||
    check.expired ||
    opts.trigger === 'wakeup' ||
    opts.trigger === 'match_opener' ||
    isStaleSession(rel);

  if (needsDirector) {
    const directed = await runDirector(character, rel, {
      reason: opts.reason ?? (check.expired ? check.reason : opts.trigger),
    });
    rel = getRelationship(characterId)!;
    character = getCharacter(characterId)!;
    if (directed.escalation === 'block') {
      bus.emitEvent({ type: 'character_state', character_id: character.id, state: 'blocked_by_char' });
      return;
    }
    if (directed.escalation === 'ghost') {
      logger.info('actor', `${character.username} is ghosting, no reply sent`);
      return;
    }
  }

  if (rel.ghosted_at && opts.trigger === 'user_message') {
    // Ghosting means she does not answer. A reactivation attempt is decided by the Director.
    logger.debug('actor', `${character.username} is ghosting, staying silent`);
    return;
  }

  await runActorPhase(character, rel, { startedIn, decrementValidFor: true });
}

/** What she'd be offering, in plain terms, for the consent card the user actually sees. */
function photoOfferText(name: string, kind: 'profile' | 'chat' | 'spicy'): string {
  switch (kind) {
    case 'profile':
      return `${name} wants to swap profile pictures. Accepting shows her yours too.`;
    case 'spicy':
      return `${name} wants to send you a photo. It might be explicit.`;
    default:
      return `${name} wants to send you a photo.`;
  }
}

/**
 * The Actor call, delivery and post-turn bookkeeping, shared between a normal turn and a
 * regenerate. `decrementValidFor` is false for a regenerate: the original turn already
 * spent one use of the direction, and a reroll of its text should not spend a second.
 */
async function runActorPhase(
  character: Character,
  rel: Relationship,
  opts: { startedIn: number; decrementValidFor: boolean },
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

  let result: ActorRun;
  try {
    showTyping();

    const useVoice = wantsVoiceMessage(character);
    const ctx = { character, relationship: rel, direction: rel.active_direction };
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

  // A thread she was told to raise is now spent, whether or not he engaged with it.
  if (result.raisedThreadId) markThreadRaised(rel, result.raisedThreadId);

  /**
   * She decided to send a photo - but deciding is not sending. This only raises the
   * consent card; generation does not start until he accepts it (see images.ts).
   * Re-verified here rather than trusted from the model: the direction's unlock has to
   * actually match the tier she is offering, one is not already pending, images have to be
   * turned on, and a profile picture cannot be offered twice.
   */
  /**
   * She has been asked to swap profile pictures and this turn carries her answer. It is
   * genuinely her decision: a refusal resolves the card and nothing is revealed, which is
   * why the request is worth making rather than being a button that always works.
   */
  const pendingExchange: PendingExchange | null = (rel.mood as any)?.pending_exchange ?? null;
  let exchangeLeft: PendingExchange | null = pendingExchange;
  if (pendingExchange && result.hidden.exchange_response) {
    const accepted = result.hidden.exchange_response === 'accept';
    exchangeLeft = null;
    const updated = updateMessageMeta(pendingExchange.message_id, {
      status: accepted ? 'accepted' : 'declined',
    });
    if (updated) bus.emitEvent({ type: 'message_updated', character_id: character.id, message: updated });

    if (accepted) {
      // The agreement is what counts, and it is symmetrical: from here she can see his
      // picture whether or not her own image generates successfully afterwards.
      rel.flags.state.photos_exchanged = true;
      // Checked against the images table, not profile_picture_sent - that flag only flips
      // once generation finishes, well after a same-turn photo_offer could otherwise slip a
      // second, redundant profile job past it.
      if (getSettings().images_enabled && !hasProfileImageJob(character.id)) {
        enqueueImage({ characterId: character.id, kind: 'profile', situation: '' });
      }
    }
    logger.debug('actor', `${character.username} ${accepted ? 'accepted' : 'declined'} the picture swap`);
  }

  let pendingPhoto: PendingPhoto | null = (rel.mood as any)?.pending_photo ?? null;
  const offerKind = result.hidden.photo_offer;
  if (offerKind && !pendingPhoto) {
    // Re-verified here rather than trusted from the model: actor.ts already rejects a turn
    // whose offer cannot actually be sent, so this should normally never fire, but it stays
    // as the actual enforcement point in case the retry budget was spent on something else
    // first. Which tier to offer is otherwise entirely her call - this only catches images
    // being off, or a profile picture already on its way.
    if (photoOfferEligible(rel, offerKind)) {
      const offerId = randomUUID();
      const offerMsg = addMessage({
        character_id: character.id,
        sender: 'system',
        text: photoOfferText(character.real_name, offerKind),
        kind: 'text',
        meta: { type: 'photo_offer', offer_id: offerId, photo_kind: offerKind, status: 'pending' },
        read_at: null,
      });
      bus.emitEvent({ type: 'message', character_id: character.id, message: offerMsg });
      pendingPhoto = {
        offer_id: offerId,
        kind: offerKind,
        situation: result.hidden.photo_situation ?? '',
        // Her own choice of orientation for a chat/spicy shot; a profile picture ignores
        // it and is always square. Default to portrait if she offered one without picking
        // an aspect - the common case for a phone photo of herself.
        aspect: offerKind === 'profile' ? null : result.hidden.photo_aspect ?? 'portrait',
        // A profile picture always shows her face, by dating-app convention - that is the
        // one photo real profiles never lead with a from-behind or cropped shot for.
        // Otherwise trust what she actually said; omitted means face-in-frame as normal.
        showsFace: offerKind === 'profile' ? true : result.hidden.photo_shows_face ?? true,
        message_id: offerMsg.id,
        offered_at: nowIso(),
      };
      logger.debug('actor', `${character.username} offered a ${offerKind} photo`, { offer_id: offerId });
    } else {
      logger.debug('actor', `${character.username}'s photo offer was not honoured`, {
        offerKind,
        imagesEnabled: getSettings().images_enabled,
        unlock: rel.active_direction?.unlock,
      });
    }
  }

  rel.mood = {
    ...rel.mood,
    actor_mood: result.hidden.mood,
    thoughts: result.hidden.thoughts,
    // Carried to the next turn so nothing opens a second topic on top of a live one.
    unresolved: result.hidden.unresolved,
    pending_photo: pendingPhoto,
    pending_exchange: exchangeLeft,
  };
  refreshModifiers(rel, recentMessages(character.id, 40), result.hidden.boundary_touched);
  saveRelationship(rel);

  if (result.hidden.going_offline_in !== null) {
    // She leaves when she said she would, and stays gone for a while afterwards.
    const leavesAt = Date.now() + result.hidden.going_offline_in * 60_000;
    const awayUntil = new Date(leavesAt + randInt(25, 180) * 60_000).toISOString();
    logger.debug('actor', `${character.username} is leaving in ${result.hidden.going_offline_in}min`, { away_until: awayUntil });
    rel.mood = { ...rel.mood, leaves_at: new Date(leavesAt).toISOString(), away_until: awayUntil };
    saveRelationship(rel);
  }

  // Boundary crossings get a Director pass immediately, not on the next turn.
  if (result.hidden.boundary_touched || result.hidden.director_needed) {
    const res = await runDirector(character, getRelationship(characterId)!, {
      reason: result.hidden.boundary_touched ? 'boundary_touched' : 'actor_requested',
      actorReport: result.hidden,
    });
    if (res.escalation === 'block') {
      bus.emitEvent({ type: 'character_state', character_id: character.id, state: 'blocked_by_char' });
    }
  }
}

/**
 * Reroll her most recent reply - the small redo button next to the timestamp. Only the
 * trailing run of her messages (the last turn) can be regenerated: anything older has
 * already had its stat and ledger effects folded into the relationship, and undoing those
 * cleanly is not something this can do safely. If the user has replied since, that turn is
 * done and there is nothing left to reroll.
 *
 * The Director is not re-run - the original turn already scored and directed this moment,
 * and running it twice would double-apply trust/spark/investment/arousal deltas. This only
 * asks the Actor to write different words for the same direction.
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
  if (rel.ghosted_at) {
    throw new Error('she is ghosting - there is nothing to regenerate into');
  }

  const removedIds = trailing.map((m) => m.id);
  deleteMessages(removedIds);
  bus.emitEvent({ type: 'messages_removed', character_id: characterId, message_ids: removedIds });
  logger.info('actor', `regenerating last turn for ${character.username}`, { removed: removedIds });

  running.add(characterId);
  const startedIn = epoch;
  void runActorPhase(character, rel, { startedIn, decrementValidFor: false })
    .catch((err) => logger.error('actor', 'regenerate failed', { error: String(err) }))
    .finally(() => running.delete(characterId));

  return { removed_ids: removedIds };
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

/**
 * She goes offline mid-conversation when the Actor said she would, and is genuinely
 * unreachable until the absence window closes.
 */
export function isAway(rel: Relationship): boolean {
  if (alwaysOnline()) return false;
  const mood = rel.mood as any;
  const leavesAt = mood?.leaves_at ? Date.parse(mood.leaves_at) : null;
  const awayUntil = mood?.away_until ? Date.parse(mood.away_until) : null;
  if (!leavesAt || !awayUntil) return false;
  const now = Date.now();
  return now >= leavesAt && now < awayUntil;
}

export async function blockCharacterByUser(characterId: string): Promise<void> {
  setCharacterState(characterId, 'blocked_by_user');
  clearWakeup(characterId);
  bus.emitEvent({ type: 'character_state', character_id: characterId, state: 'blocked_by_user' });
}
