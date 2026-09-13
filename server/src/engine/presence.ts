import { getSettings } from '../config.js';
import type { Character, OnlineWindow } from '../types.js';

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

/** True while the host machine is inside its configured uptime window. */
export function serverWindowOpen(now = new Date()): boolean {
  const { from, to } = getSettings().server_window;
  const start = parseHm(from);
  const end = parseHm(to);
  const t = minutesOfDay(now);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

function windowMatches(w: OnlineWindow, now: Date): boolean {
  if (w.weekday !== now.getDay()) return false;
  const t = minutesOfDay(now);
  const from = parseHm(w.from);
  const to = parseHm(w.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

export function isOnline(character: Character, now = new Date()): boolean {
  if (!serverWindowOpen(now)) return false;
  const windows = character.seed.online_times ?? [];
  if (windows.length === 0) return true;
  return windows.some((w) => windowMatches(w, now));
}

/**
 * Next moment at or after `from` where the character is online. Searches minute-coarse
 * over the next two weeks and gives up afterwards (a seed with no usable window).
 */
export function nextOnlineAt(character: Character, from = new Date()): Date | null {
  const windows = character.seed.online_times ?? [];
  if (windows.length === 0) return from;

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  for (let day = 0; day <= 14; day++) {
    const probe = new Date(cursor.getTime());
    probe.setDate(probe.getDate() + day);
    if (day > 0) probe.setHours(0, 0, 0, 0);
    const dayStart = day === 0 ? minutesOfDay(probe) : 0;

    const candidates = windows
      .filter((w) => w.weekday === probe.getDay())
      .map((w) => ({ from: parseHm(w.from), to: parseHm(w.to) }))
      .sort((a, b) => a.from - b.from);

    for (const w of candidates) {
      if (dayStart >= w.from && dayStart < w.to) return probe;
      if (w.from >= dayStart) {
        const at = new Date(probe.getTime());
        at.setHours(Math.floor(w.from / 60), w.from % 60, 0, 0);
        if (serverWindowOpen(at)) return at;
      }
    }
  }
  return null;
}

/** End of the current online window, used to tell the Director when she has to leave. */
export function onlineUntil(character: Character, now = new Date()): Date | null {
  const windows = (character.seed.online_times ?? []).filter((w) => windowMatches(w, now));
  if (windows.length === 0) return null;
  const end = Math.max(...windows.map((w) => parseHm(w.to)));
  const at = new Date(now.getTime());
  at.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

export function describeOnlineTimes(character: Character): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const windows = character.seed.online_times ?? [];
  if (windows.length === 0) return 'always available';
  return windows.map((w) => `${names[w.weekday] ?? '?'} ${w.from}-${w.to}`).join(', ');
}
