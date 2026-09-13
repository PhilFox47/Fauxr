import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  addMessage, clearWakeup, getCharacter, getRelationship, getWakeup, markUserMessagesRead,
  recentMessages, saveRelationship, setCharacterState, type StoredMessage,
} from '../repo.js';
import type { ActorHidden, Character, Relationship } from '../types.js';
import { runActor, runActorVoice, wantsVoiceMessage } from './actor.js';
import { detectEvents, directionExpired, runDirector } from './director.js';
import { computePressure, computeReciprocity } from './modifiers.js';
import { isOnline } from './presence.js';
import { clearExpiredNegativeFlags, hasActiveNegativeFlag } from './state.js';

/** One turn at a time per character, so a wakeup and a user message cannot interleave. */
const running = new Set<string>();

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

  const messages = recentMessages(character.id, getSettings().chat.context_messages);
  refreshModifiers(rel, messages, false);
  clearExpiredNegativeFlags(rel);
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
  let character = getCharacter(characterId);
  let rel = getRelationship(characterId);
  if (!character || !rel) return;
  if (character.state !== 'matched') return;

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
    const result = await runDirector(character, rel, {
      reason: opts.reason ?? (check.expired ? check.reason : opts.trigger),
    });
    rel = getRelationship(characterId)!;
    character = getCharacter(characterId)!;
    if (result.escalation === 'block') {
      bus.emitEvent({ type: 'character_state', character_id: character.id, state: 'blocked_by_char' });
      return;
    }
    if (result.escalation === 'ghost') {
      logger.info('actor', `${character.username} is ghosting, no reply sent`);
      return;
    }
  }

  if (rel.ghosted_at && opts.trigger === 'user_message') {
    // Ghosting means she does not answer. A reactivation attempt is decided by the Director.
    logger.debug('actor', `${character.username} is ghosting, staying silent`);
    return;
  }

  const useVoice = wantsVoiceMessage(character);
  const ctx = { character, relationship: rel, direction: rel.active_direction };
  const output = useVoice
    ? await runActorVoice(ctx).then((v) => (v ? { messages: [v.message], hidden: v.hidden } : null))
    : null;
  const result = output ?? (await runActor(ctx));

  await deliver(character, result.messages, result.hidden);

  rel = getRelationship(characterId)!;
  if (rel.active_direction) {
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
  rel.mood = { ...rel.mood, actor_mood: result.hidden.mood, thoughts: result.hidden.thoughts };
  refreshModifiers(rel, recentMessages(character.id, 40), result.hidden.boundary_touched);
  saveRelationship(rel);

  if (result.hidden.going_offline_in !== null) {
    logger.debug('actor', `${character.username} announced going offline in ${result.hidden.going_offline_in}min`);
    rel.mood = { ...rel.mood, offline_after: new Date(Date.now() + result.hidden.going_offline_in * 60_000).toISOString() };
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

function isStaleSession(rel: Relationship): boolean {
  if (!rel.last_contact_at) return true;
  return Date.now() - Date.parse(rel.last_contact_at) > 6 * 3_600_000;
}

/** Play the messages out over time with a typing indicator, the way a person types. */
async function deliver(
  character: Character,
  messages: { text: string; delay: number; kind?: string; duration_seconds?: number }[],
  hidden: ActorHidden,
): Promise<void> {
  for (const m of messages) {
    bus.emitEvent({ type: 'typing', character_id: character.id, on: true });
    await sleep(m.delay * 1000);
    bus.emitEvent({ type: 'typing', character_id: character.id, on: false });

    const stored = addMessage({
      character_id: character.id,
      sender: 'character',
      text: m.text,
      kind: m.kind === 'voice' ? 'voice' : 'text',
      meta: m.duration_seconds ? { duration_seconds: m.duration_seconds } : {},
      read_at: null,
    });
    bus.emitEvent({ type: 'message', character_id: character.id, message: stored });
  }
  void hidden;
}

/** She goes offline mid-conversation when the Actor said she would. */
export function shouldBeOffline(rel: Relationship): boolean {
  const at = (rel.mood as any)?.offline_after;
  return !!at && Date.parse(at) <= Date.now();
}

export async function blockCharacterByUser(characterId: string): Promise<void> {
  setCharacterState(characterId, 'blocked_by_user');
  clearWakeup(characterId);
  bus.emitEvent({ type: 'character_state', character_id: characterId, state: 'blocked_by_user' });
}
