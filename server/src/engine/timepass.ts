import { bus } from '../events.js';
import { logger } from '../log.js';
import { addMessage, activeDate, firstDateStartedAt, getCharacter, getRelationship, saveRelationship } from '../repo.js';
import { advanceGameClock, gameClockMs } from './clock.js';
import { decayArousal } from './stage.js';
import { refreshStatus, statusDue } from './status.js';

/**
 * "Pass time": the one deliberate way a chat's clock moves (engine/clock.ts). Two matches have
 * no bearing on each other, so this always acts on exactly one chat, never the whole cast: he
 * picks a number of hours or days for her specifically and she lives through that stretch on
 * her own - her arousal cools, her status and her life may move on, a milestone may land, a
 * plan the Director wrote for an earlier moment gets torn up in favour of a fresh one. It never
 * creates a first text: only a character's own soft-close timer may do that.
 */

const MIN_HOURS = 0.25;
const MAX_HOURS = 24 * 90; // 90 days in one press is already a lot

const MILESTONE_DAYS: [number, string][] = [
  [7, 'one week'], [30, 'one month'], [90, 'three months'], [180, 'six months'], [365, 'one year'],
];

function milestoneLabel(days: number): string | null {
  const exact = MILESTONE_DAYS.find(([d]) => d === days);
  if (exact) return exact[1];
  if (days > 365 && days % 365 === 0) return `${days / 365} years`;
  return null;
}

/** "45 minutes" / "6 hours" / "3 days" / "2 weeks" - whichever unit actually reads best. */
export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 36) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = hours / 24;
  if (days < 13) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'}`;
}

export interface PassTimeResult {
  hours: number;
  label: string;
  /** True if she is about to text out of nowhere because of the gap. */
  reaching_out: boolean;
}

/** Days since some real, already-stored moment, seeded once and then only moved by passing time. */
function seedDays(anchorIso: string | null): number {
  return anchorIso ? Math.max(0, (Date.now() - Date.parse(anchorIso)) / 86_400_000) : 0;
}

export async function passTime(characterId: string, hoursRequested: number): Promise<PassTimeResult> {
  const character = getCharacter(characterId);
  if (!character) throw new Error('character not found');
  if (character.state !== 'matched') throw new Error('you are not matched with her');
  const live = activeDate(characterId);
  if (live) throw new Error(`she is on a ${live.kind} with you right now`);
  const rel = getRelationship(characterId);
  if (!rel) throw new Error('relationship missing');

  const hours = Math.max(MIN_HOURS, Math.min(MAX_HOURS, Number(hoursRequested) || 0));
  advanceGameClock(rel, hours);
  const label = formatDuration(hours);

  rel.arousal = decayArousal(rel.arousal, hours);
  // A lot may have changed; let the Director actually look at the new moment next time,
  // rather than finishing out a plan written for one that is now hours or days behind them.
  rel.active_direction = null;

  const mood: Record<string, unknown> = { ...rel.mood };
  const celebrated = new Set<string>((mood.milestones_celebrated as string[] | undefined) ?? []);

  // Lazily seeded from how old the match really is the first time this ever runs, so an
  // existing conversation does not silently reset to "just matched" - after that it only
  // moves by what he actually passes in this chat.
  const daysSinceMatch = Number(mood.days_since_match ?? seedDays(character.matched_at)) + hours / 24;
  mood.days_since_match = daysSinceMatch;
  const matchLabel = milestoneLabel(Math.floor(daysSinceMatch));
  if (matchLabel) {
    const key = `matched:${Math.floor(daysSinceMatch)}`;
    if (!celebrated.has(key)) {
      celebrated.add(key);
    }
  }

  const firstDate = firstDateStartedAt(characterId);
  if (firstDate) {
    const daysSinceDate = Number(mood.days_since_first_date ?? seedDays(firstDate)) + hours / 24;
    mood.days_since_first_date = daysSinceDate;
    const dateLabel = milestoneLabel(Math.floor(daysSinceDate));
    if (dateLabel) {
      const key = `first_date:${Math.floor(daysSinceDate)}`;
      if (!celebrated.has(key)) {
        celebrated.add(key);
      }
    }
  }
  mood.milestones_celebrated = [...celebrated];
  rel.mood = mood;
  saveRelationship(rel);

  // Store the clock marker before any model-backed status refresh. Otherwise he can send a
  // message while that slow call is running and the older "20 hours passed" marker is then
  // inserted after his newer message, giving every later prompt time in the wrong order.
  const marker = addMessage({
    character_id: characterId,
    sender: 'system',
    text: `${label.charAt(0).toUpperCase()}${label.slice(1)} passed.`,
    meta: { type: 'time_passed', hours },
    game_clock_ms: gameClockMs(rel),
  });
  bus.emitEvent({ type: 'message', character_id: characterId, message: marker });

  // Her situation may have moved on - a fresh status, a new location, a different outfit,
  // one of her storylines nudged forward - but only once the (virtual) time she was due for
  // one has actually arrived; see statusDue() in status.ts.
  if (statusDue(rel)) {
    await refreshStatus(character).catch((err) =>
      logger.warn('scheduler', 'status refresh during a time skip failed', { character: character.username, error: String(err) }),
    );
  }

  logger.info('scheduler', `${character.username}: passed ${label}`, { reaching_out: false });
  return { hours, label, reaching_out: false };
}
