import { getSettings } from '../config.js';
import { find } from '../db/attributes.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import { addMessage, firstDateStartedAt, getRelationship, getWakeup, saveRelationship, setWakeup } from '../repo.js';
import type { Character } from '../types.js';
import { advanceGameClock } from './clock.js';
import { contactableMatches } from './scheduler.js';
import { decayArousal } from './stage.js';
import { randInt } from './dice.js';
import { refreshStatus, statusDue } from './status.js';

/**
 * "Pass time": the one deliberate way the story's clock moves (engine/clock.ts). He picks a
 * number of hours or days and everything he has matched with lives through that stretch at
 * once - her arousal cools, her status and her life may move on, a milestone may land, a plan
 * the Director wrote for an earlier moment gets torn up in favour of a fresh one - and, if he
 * still wants the odd text out of nowhere (Settings -> unprompted messages), she may reach out
 * about whatever that gap actually means for her. Nothing here is a cost of going quiet: it
 * only ever runs because he pressed the button, never because he didn't reply fast enough.
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
  matches: number;
  /** Display names of anyone who is about to text out of nowhere because of the gap. */
  reaching_out: string[];
}

/** Days since some real, already-stored moment, seeded once and then only moved by passing time. */
function seedDays(anchorIso: string | null): number {
  return anchorIso ? Math.max(0, (Date.now() - Date.parse(anchorIso)) / 86_400_000) : 0;
}

/**
 * Whether, and why, she might text out of the blue about the gap that just happened. Scaled by
 * how much time passed (a short skip is unlikely to produce anything; a multi-day one almost
 * always does) and by how much of a texter she is anyway.
 */
function reachOutReason(character: Character, hours: number): string | null {
  const energy = Number(find('social_energy', character.seed.social_energy)?.extra?.pace ?? 1);
  const appetite = 0.5 + character.seed.libido / 5;
  const p = (1 - Math.exp(-hours / 18)) * Math.min(1, 0.55 * energy * appetite);
  if (Math.random() > p) return null;
  return (
    `Roughly ${formatDuration(hours)} has passed since you last spoke, with nothing said either way in ` +
    `between - no silence to read into, he just had not opened the app. If she would genuinely have ` +
    `something to say to him now, unprompted, out of what has actually been going on for her, she can ` +
    'reach out with it. Never framed as him having gone quiet, and never annoyed or hurt about the gap.'
  );
}

export async function passTime(hoursRequested: number): Promise<PassTimeResult> {
  const hours = Math.max(MIN_HOURS, Math.min(MAX_HOURS, Number(hoursRequested) || 0));
  advanceGameClock(hours);
  const settings = getSettings();
  const label = formatDuration(hours);
  const matches = contactableMatches();
  const reaching_out: string[] = [];

  for (const character of matches) {
    const rel = getRelationship(character.id);
    if (!rel) continue;

    rel.arousal = decayArousal(rel.arousal, hours);
    // A lot may have changed; let the Director actually look at the new moment next time,
    // rather than finishing out a plan written for one that is now hours or days behind them.
    rel.active_direction = null;

    const mood: Record<string, unknown> = { ...rel.mood };
    const celebrated = new Set<string>((mood.milestones_celebrated as string[] | undefined) ?? []);
    let milestoneReason: string | null = null;

    // Lazily seeded from how old the match really is the first time this ever runs, so an
    // existing conversation does not silently reset to "just matched" - after that it only
    // moves by what he actually passes.
    const daysSinceMatch = Number(mood.days_since_match ?? seedDays(character.matched_at)) + hours / 24;
    mood.days_since_match = daysSinceMatch;
    const matchLabel = milestoneLabel(Math.floor(daysSinceMatch));
    if (matchLabel) {
      const key = `matched:${Math.floor(daysSinceMatch)}`;
      if (!celebrated.has(key)) {
        celebrated.add(key);
        milestoneReason =
          `It has now been ${matchLabel} since you two matched - if it feels like her to bring it up, she ` +
          'can, in whatever way actually fits who she is: a big deal, a passing remark, teasing him for ' +
          'probably forgetting. Not mandatory, and never guilt-tripping if he does not react the way she ' +
          'might have hoped.';
      }
    }

    const firstDate = firstDateStartedAt(character.id);
    if (firstDate) {
      const daysSinceDate = Number(mood.days_since_first_date ?? seedDays(firstDate)) + hours / 24;
      mood.days_since_first_date = daysSinceDate;
      const dateLabel = !milestoneReason ? milestoneLabel(Math.floor(daysSinceDate)) : null;
      if (dateLabel) {
        const key = `first_date:${Math.floor(daysSinceDate)}`;
        if (!celebrated.has(key)) {
          celebrated.add(key);
          milestoneReason =
            `It has now been ${dateLabel} since your first date - if it feels like her to bring it up, she ` +
            'can, in whatever way actually fits who she is. Not mandatory, and never guilt-tripping if he ' +
            'does not react the way she might have hoped.';
        }
      }
    }
    mood.milestones_celebrated = [...celebrated];
    rel.mood = mood;
    saveRelationship(rel);

    // Her situation may have moved on - a fresh status, a new location, a different outfit,
    // one of her storylines nudged forward - but only once the (virtual) time she was due for
    // one has actually arrived; see statusDue() in status.ts.
    if (statusDue(rel)) {
      await refreshStatus(character).catch((err) =>
        logger.warn('scheduler', 'status refresh during a time skip failed', { character: character.username, error: String(err) }),
      );
    }

    const marker = addMessage({
      character_id: character.id,
      sender: 'system',
      text: `${label.charAt(0).toUpperCase()}${label.slice(1)} passed.`,
      meta: { type: 'time_passed', hours },
    });
    bus.emitEvent({ type: 'message', character_id: character.id, message: marker });

    if (settings.unprompted_messages && !getWakeup(character.id)) {
      const reason = milestoneReason ?? reachOutReason(character, hours);
      if (reason) {
        const at = new Date(Date.now() + randInt(1, 10) * 60_000);
        setWakeup({ character_id: character.id, scheduled_at: at.toISOString(), reason, cancel_if_user_writes: true });
        reaching_out.push(character.real_name);
      }
    }
  }

  logger.info('scheduler', `passed ${label}`, { matches: matches.length, reaching_out: reaching_out.length });
  return { hours, label, matches: matches.length, reaching_out };
}
