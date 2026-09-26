import type { Relationship } from '../types.js';

/**
 * Her own clock - what day and time it is for THIS chat, entirely separate from the real one
 * and from every other chat's. Two matches have no bearing on each other, so each gets her own
 * clock rather than one shared for the whole cast: skipping ahead with one woman says nothing
 * about what has happened with anyone else.
 *
 * It never advances on its own, no matter how long the app sits idle or how long he takes to
 * reply: it only moves when he explicitly passes time in THIS chat (see engine/timepass.ts, the
 * "Pass time" control in the chat menu). Reply five seconds after her last message or come back
 * five real days later and, as far as she is concerned, nothing happened in between - which is
 * the point: nobody gets pinged for going quiet, and nothing quietly ages while he is just away.
 *
 * Stored on the relationship itself (mood.game_clock_ms, an epoch-ms number), seeded to the real
 * time the first time a chat's relationship row is ever read (repo.ts's backfillGameClock) and
 * from then on moved only by advanceGameClock(). Anything that describes *when something is
 * happening in this chat's story* reads this instead of the real clock: her sense of the current
 * day and time (moment.ts), her status's set_at/until (status.ts), the Director's "time now" and
 * "last contact" lines, last_contact_at, and how long an open thread has sat unaddressed before
 * it is dropped (state.ts). Real wall-clock time (Date.now()/nowIso()) stays in charge of
 * everything actually about the real world: message timestamps, image and log bookkeeping,
 * typing-delay pacing, and per-day cost budgets - none of that should freeze.
 */

type ClockBearer = Pick<Relationship, 'mood'>;

/** Assumes repo.ts's backfillGameClock has already run; Date.now() only covers a relationship this session created and has not yet reloaded. */
export function gameClockMs(rel: ClockBearer): number {
  const v = Number((rel.mood as any)?.game_clock_ms);
  return Number.isFinite(v) ? v : Date.now();
}

export function gameNow(rel: ClockBearer): Date {
  return new Date(gameClockMs(rel));
}

export function gameNowIso(rel: ClockBearer): string {
  return gameNow(rel).toISOString();
}

/**
 * Moves this chat's clock forward. Mutates rel.mood in place and returns the new value; saving
 * rel is the caller's job, same as every other mood change in engine/timepass.ts.
 */
export function advanceGameClock(rel: ClockBearer, hours: number): number {
  const next = gameClockMs(rel) + Math.round(hours * 3_600_000);
  rel.mood = { ...rel.mood, game_clock_ms: next };
  return next;
}
