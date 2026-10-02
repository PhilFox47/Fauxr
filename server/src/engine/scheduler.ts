import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  clearWakeup, dueWakeups, getCharacter, getWakeup,
  characterIdsOnDate, getRelationship, lastMessage, listActiveMatches, pendingUserMessageCount,
  saveRelationship, setWakeup,
} from '../repo.js';
import type { Character } from '../types.js';
import { takeTurn } from './chat.js';
import { randInt } from './dice.js';
import { ensureStack } from './matching.js';
import { extendOneSchedule } from './schedule.js';
import { maybeCreateScheduledStatus } from './status-posts.js';
import { syncWorldEffects } from './world.js';
import { syncScheduledDateReminders } from './scheduled-dates.js';
import { gameClockMs } from './clock.js';
import { CLOSED_REOPEN_REASON, cancelConversationReopen, conversationReopenAt } from './conversation-close.js';

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  void catchUp().catch((err) => logger.error('scheduler', 'catch-up failed', { error: String(err) }));
  timer = setInterval(() => {
    void tick().catch((err) => logger.error('scheduler', 'tick failed', { error: String(err) }));
  }, TICK_MS);
  logger.info('scheduler', 'scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Everyone the scheduler is allowed to make text him. A
 * character who is out on a date is not one of them - see engine/dates.ts - and leaving her in
 * the sweeps would have her double-texting him from across the table.
 */
export function contactableMatches(): Character[] {
  const onDate = characterIdsOnDate();
  return listActiveMatches().filter((c) => !onDate.has(c.id));
}

/** Reason used when a message of his somehow went unanswered - a reply, not an unprompted text. */
const PENDING_REPLY_REASON = 'she has unread messages from him';

/**
 * Wakeups that are allowed with unprompted messages switched off: her opening message after a
 * match, and answering something he actually wrote. Everything else is her texting first.
 */
function isReplyWakeup(reason: string): boolean {
  return reason === 'match_opener' || reason === PENDING_REPLY_REASON || reason === CLOSED_REOPEN_REASON;
}

function unpromptedAllowed(): boolean {
  return !!getSettings().unprompted_messages;
}

/**
 * The once-a-minute maintenance pass. Fictional elapsed time comes from the shared persisted
 * clock, not from counting ticks. Here we apply its elapsed effects, deliver due wakeups,
 * repair a user message missed by a crash, roll private schedule horizons forward and
 * consider one globally rate-limited Status story. A large clock jump still produces no
 * image backlog because the Status scheduler resets its next due time from "now".
 */
export async function tick(): Promise<void> {
  syncWorldEffects();
  syncScheduledDateReminders();
  queueClosedConversationReopens();
  const onDate = characterIdsOnDate();
  for (const w of dueWakeups()) {
    const character = getCharacter(w.character_id);
    if (!character || character.state !== 'matched') {
      clearWakeup(w.character_id);
      continue;
    }
    // Old Director/silence/milestone wakeups are no longer valid. Apart from opening a new
    // match or repairing an unanswered user message, she may initiate only after her own close.
    if (!isReplyWakeup(w.reason) || (w.reason === CLOSED_REOPEN_REASON && !unpromptedAllowed())) {
      clearWakeup(character.id);
      continue;
    }
    // Left due rather than cleared: whatever she meant to say is still worth saying once
    // the evening is over, so it simply fires on a tick after the date ends.
    if (onDate.has(character.id)) continue;
    clearWakeup(character.id);
    if (w.reason === 'match_opener') {
      bus.emitEvent({ type: 'match', character_id: character.id });
    }
    logger.info('scheduler', `wakeup fired for ${character.username}`, { reason: w.reason });
    void takeTurn(character.id, {
      trigger: w.reason === 'match_opener' ? 'match_opener' : w.reason === CLOSED_REOPEN_REASON ? 'initiative' : 'wakeup',
      reason: w.reason,
      forceDirector: w.reason !== 'match_opener',
    }).catch((err) => logger.error('scheduler', 'wakeup turn failed', { error: String(err) }));
  }

  answerPendingMessages();
  void maybeCreateScheduledStatus().catch((err) => logger.error('scheduler', 'Status story failed', { error: String(err) }));
  void extendOneSchedule().catch((err) => logger.error('scheduler', 'schedule extension failed', { error: String(err) }));
  void ensureStack();
}

/** Promote matured fictional-time close markers into one cancellable immediate wakeup. */
export function queueClosedConversationReopens(): void {
  if (!unpromptedAllowed()) return;
  const now = gameClockMs();
  for (const character of contactableMatches()) {
    const rel = getRelationship(character.id);
    if (!rel) continue;
    const due = conversationReopenAt(rel);
    if (due == null || due > now || getWakeup(character.id)) continue;
    cancelConversationReopen(rel);
    saveRelationship(rel);
    setWakeup({
      character_id: character.id,
      scheduled_at: nowIso(),
      reason: CLOSED_REOPEN_REASON,
      cancel_if_user_writes: true,
    });
  }
}

/**
 * A safety net: a message of his that somehow never got a reply (a failed turn, a restart
 * mid-turn) gets picked up a few minutes later instead of sitting there forever. This is a
 * server reliability fix, not a story-time mechanic, so it stays on the real clock.
 */
function answerPendingMessages(): void {
  for (const character of contactableMatches()) {
    if (getWakeup(character.id)) continue; // a wakeup is already going to wake her
    if (pendingUserMessageCount(character.id) === 0) continue;
    const last = lastMessage(character.id);
    // Give a normal turn time to finish before treating the message as missed.
    if (!last || last.sender !== 'user' || Date.now() - Date.parse(last.sent_at) < 3 * 60_000) continue;

    setWakeup({
      character_id: character.id,
      scheduled_at: new Date(Date.now() + randInt(0, 2) * 60_000).toISOString(),
      reason: PENDING_REPLY_REASON,
      cancel_if_user_writes: true,
    });
    logger.debug('scheduler', `${character.username} has unanswered messages`);
  }
}

/**
 * Runs on every server start: overdue wakeups get spread out instead of all firing at once.
 */
export async function catchUp(): Promise<void> {
  // World time may have crossed an appointment while the server was closed. Pause before
  // doing slower startup maintenance so reopening Fauxr immediately surfaces the date.
  syncScheduledDateReminders();
  const overdue = dueWakeups();
  logger.info('scheduler', `catch-up: ${overdue.length} overdue wakeup(s)`);

  for (const w of overdue) {
    const character = getCharacter(w.character_id);
    if (!character || character.state !== 'matched') {
      clearWakeup(w.character_id);
      continue;
    }
    // Never fire a backlog at once: stagger it over the next half hour.
    const base = new Date(Date.now() + randInt(1, 30) * 60_000);
    setWakeup({
      character_id: character.id,
      scheduled_at: base.toISOString(),
      reason: w.reason,
      cancel_if_user_writes: w.cancel_if_user_writes,
    });
  }

  await ensureStack();
  logger.info('scheduler', 'catch-up complete');
}
