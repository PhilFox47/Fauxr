import { db } from '../db/index.js';
import type { Relationship } from '../types.js';

/** One fictional clock for the whole cast, anchored to elapsed real time rather than its date. */
export interface WorldClockState { base_ms: number; anchored_real_ms: number; paused: boolean }
const KEY = 'world_clock';

function write(state: WorldClockState): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(KEY, JSON.stringify(state));
}

function legacyClockSeed(): number {
  let latest = 0;
  for (const row of db.prepare('SELECT mood FROM relationships').all() as { mood: string }[]) {
    try {
      const value = Number(JSON.parse(row.mood)?.game_clock_ms);
      if (Number.isFinite(value)) latest = Math.max(latest, value);
    } catch { /* normal relationship hydration owns malformed mood repair */ }
  }
  return latest || Date.now();
}

function read(): WorldClockState {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (row) {
    try {
      const value = JSON.parse(row.value) as Partial<WorldClockState>;
      if (Number.isFinite(value.base_ms) && Number.isFinite(value.anchored_real_ms)) {
        return { base_ms: Number(value.base_ms), anchored_real_ms: Number(value.anchored_real_ms), paused: !!value.paused };
      }
    } catch { /* repaired below from the newest legacy clock */ }
  }
  const state = { base_ms: legacyClockSeed(), anchored_real_ms: Date.now(), paused: false };
  write(state);
  return state;
}

export function worldClockState(): WorldClockState & { time_ms: number; sampled_real_ms: number } {
  const state = read();
  const sampled_real_ms = Date.now();
  const time_ms = state.paused ? state.base_ms : state.base_ms + Math.max(0, sampled_real_ms - state.anchored_real_ms);
  return { ...state, time_ms, sampled_real_ms };
}

/** Optional bearer parameters keep existing save-compatible call sites simple. */
export function gameClockMs(_rel?: Pick<Relationship, 'mood'>): number { return worldClockState().time_ms; }
export function gameNow(_rel?: Pick<Relationship, 'mood'>): Date { return new Date(gameClockMs()); }
export function gameNowIso(_rel?: Pick<Relationship, 'mood'>): string { return gameNow().toISOString(); }

export function setWorldClockPaused(paused: boolean): WorldClockState & { time_ms: number; sampled_real_ms: number } {
  const current = worldClockState();
  const state = { base_ms: current.time_ms, anchored_real_ms: Date.now(), paused };
  write(state);
  return worldClockState();
}

export function setWorldClock(targetMs: number): WorldClockState & { time_ms: number; sampled_real_ms: number } {
  const current = worldClockState();
  if (!Number.isFinite(targetMs) || targetMs < current.time_ms) throw new Error('world time can only move forward');
  const state = { base_ms: Math.round(targetMs), anchored_real_ms: Date.now(), paused: current.paused };
  write(state);
  return worldClockState();
}

/** The relationship argument remains for callers; time itself is global now. */
export function advanceGameClock(_rel: Pick<Relationship, 'mood'> | null, hours: number): number {
  const current = worldClockState();
  const next = current.time_ms + Math.round(hours * 3_600_000);
  write({ base_ms: next, anchored_real_ms: Date.now(), paused: current.paused });
  return next;
}

/** Running time needs no artificial tick; paused ordinary chat gets one minute per bubble. */
export function messageClockMs(): number {
  const current = worldClockState();
  return current.paused ? advanceGameClock(null, 1 / 60) : current.time_ms;
}
