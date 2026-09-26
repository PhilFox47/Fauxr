import { db } from '../db/index.js';

/**
 * The story's own clock - what day and time it is inside the fiction, entirely separate from
 * the real one. It never advances on its own, no matter how long the app sits idle or how long
 * he takes to reply: it only moves when he explicitly asks time to pass (see engine/timepass.ts,
 * the "Pass time" control in the app). Reply five seconds after her last message or come back
 * five real days later and, as far as she is concerned, nothing happened in between - which is
 * the point: nobody gets pinged for going quiet, and nothing quietly ages while he is just away.
 *
 * Anything that describes *when something is happening in the story* reads this instead of the
 * real clock: her sense of the current day and time (moment.ts, status.ts), how turned on she
 * still is, when her status or a milestone next comes due, whether a plan the Director wrote
 * still covers the moment. Real wall-clock time (Date.now()/nowIso()) stays in charge of
 * everything actually about the real world: message timestamps, image and log bookkeeping,
 * typing-delay pacing, and per-day cost budgets - none of that should freeze.
 *
 * Stored in the same key-value `settings` table as everything else in config.ts, under its own
 * key so a config reset does not also rewind the story clock.
 */

const KEY = 'game_clock_ms';

let cachedMs: number | null = null;

function load(): number {
  if (cachedMs !== null) return cachedMs;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  cachedMs = row ? Number(row.value) : Date.now();
  if (!row) persist(cachedMs);
  return cachedMs;
}

function persist(ms: number): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(KEY, String(Math.round(ms)));
}

export function gameNowMs(): number {
  return load();
}

export function gameNow(): Date {
  return new Date(load());
}

export function gameNowIso(): string {
  return gameNow().toISOString();
}

/** Only engine/timepass.ts's passTime() should ever call this. */
export function advanceGameClock(hours: number): number {
  cachedMs = load() + Math.round(hours * 3_600_000);
  persist(cachedMs);
  return cachedMs;
}
