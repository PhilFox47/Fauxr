import { bus } from '../events.js';
import { logger } from '../log.js';
import { dueScheduledDates, markDateReminderSent, scheduledDate } from '../repo.js';
import { gameClockMs, setWorldClockPaused, worldClockState } from './clock.js';

const REMINDER_MS = 10 * 60_000;

/**
 * Pause the shared clock once when an agreed date enters its ten-minute arrival window.
 * The date remains scheduled until the player explicitly enters it; pausing is a reminder,
 * never an automatic scene transition, and several simultaneous reminders coalesce naturally.
 */
export function syncScheduledDateReminders(): number {
  const now = gameClockMs();
  const due = dueScheduledDates(now);
  if (!due.length) return 0;
  if (!worldClockState().paused) setWorldClockPaused(true);
  let marked = 0;
  for (const date of due) {
    const updated = markDateReminderSent(date.id);
    if (!updated) continue;
    marked++;
    bus.emitEvent({ type: 'date', character_id: updated.character_id, date: updated });
    logger.info('scheduler', 'scheduled date is ready', {
      character_id: updated.character_id,
      date_id: updated.id,
      scheduled_at_ms: updated.scheduled_at_ms,
    });
  }
  return marked;
}

/** Backstage plan context shared by Actor and Director without becoming ledger memory. */
export function scheduledDateContext(characterId: string, now = gameClockMs()): string {
  const date = scheduledDate(characterId);
  if (!date?.scheduled_at_ms) return '';
  const remaining = date.scheduled_at_ms - now;
  const when = new Date(date.scheduled_at_ms).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  const timing = remaining <= REMINDER_MS
    ? 'The arrival window is open now.'
    : remaining < 3_600_000
      ? `It starts in about ${Math.max(1, Math.round(remaining / 60_000))} minutes.`
      : `It starts in about ${Math.round(remaining / 3_600_000)} hours.`;
  return [
    `You and he already have a date firmly scheduled for ${when} at ${date.where_at || 'the agreed place'}${date.company ? `, with ${date.company}` : ''}.`,
    timing,
    'This is agreed calendar reality, not a suggestion or a topic you must mention. Continue texting normally until it begins. Do not ask him to arrange, confirm or prove interest in another date while this one is pending.',
  ].join(' ');
}
