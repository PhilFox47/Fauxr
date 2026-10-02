import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { byCategory, find } from '../db/attributes.js';
import { db, nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { getCharacter, listActiveMatches } from '../repo.js';
import { render } from '../prompts/render.js';
import type { Character } from '../types.js';
import { SCHEDULE } from '../llm/schemas.js';
import { gameClockMs } from './clock.js';

export type Availability = 'green' | 'yellow' | 'red';
export interface ScheduleEntry {
  id: string;
  character_id: string;
  starts_at_ms: number;
  ends_at_ms: number;
  activity_id: string;
  title: string;
  detail: string;
  availability: Availability;
  created_at: string;
}

const running = new Set<string>();
export const DAY_MS = 86_400_000;

function pad(n: number): string { return String(n).padStart(2, '0'); }
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function atMinute(key: string, minute: number): number {
  const [y, m, d] = key.split('-').map(Number);
  // Calendar minutes, not midnight + milliseconds: this keeps local appointments at their
  // intended wall time across daylight-saving transitions.
  return new Date(y, m - 1, d, 0, minute, 0, 0).getTime();
}
function targetDays(now = gameClockMs()): string[] {
  const first = new Date(dayStart(dayKey(now)));
  return Array.from({ length: 14 }, (_, i) => {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    return dayKey(day.getTime());
  });
}
function minuteOf(raw: unknown, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!match) return fallback;
  const h = Number(match[1]); const m = Number(match[2]);
  if (h === 24 && m === 0) return 1440;
  return h >= 0 && h < 24 && m >= 0 && m < 60 ? h * 60 + m : fallback;
}
function activity(id: string) {
  return find('schedule_activity', id) ?? find('schedule_activity', 'free_time_home')!;
}
function availability(id: string): Availability {
  const value = String(activity(id)?.extra?.availability ?? 'green');
  return value === 'red' || value === 'yellow' ? value : 'green';
}

function existingDays(characterId: string): Set<string> {
  const rows = db.prepare('SELECT starts_at_ms FROM schedule_entries WHERE character_id = ?').all(characterId) as { starts_at_ms: number }[];
  return new Set(rows.map((row) => dayKey(row.starts_at_ms)));
}

function recentSchedule(characterId: string): string {
  const rows = db.prepare(`SELECT starts_at_ms, ends_at_ms, title, detail FROM schedule_entries
    WHERE character_id = ? ORDER BY starts_at_ms DESC LIMIT 60`).all(characterId) as ScheduleEntry[];
  return rows.reverse().map((e) => `${new Date(e.starts_at_ms).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}-${new Date(e.ends_at_ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: ${e.title}${e.detail ? ` (${e.detail})` : ''}`).join('\n');
}

function characterBrief(character: Character): string {
  const seed = character.seed;
  const label = (category: string, id: string) => find(category, id)?.label ?? id;
  return [
    `${character.real_name}, ${seed.age}. ${seed.hints.dossier_source === 'generated' ? seed.hints.dossier : ''}`,
    `Occupation: ${label('occupation', seed.occupation)}. Living situation: ${label('living_situation', seed.living_situation)}.`,
    `Species: ${label('species', seed.species)}. Social energy: ${label('social_energy', seed.social_energy)}.`,
    `Hobbies: ${(seed.hobbies ?? []).map((id) => label('hobby', id)).join(', ')}. Interests: ${(seed.interests ?? []).map((id) => label('interest', id)).join(', ')}.`,
  ].filter(Boolean).join('\n');
}

function insertDay(characterId: string, key: string, rawEntries: any[]): void {
  const start = dayStart(key);
  const tomorrow = new Date(start);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const end = tomorrow.getTime();
  const proposed = (Array.isArray(rawEntries) ? rawEntries : []).map((raw) => ({
    start: minuteOf(raw?.start, -1), end: minuteOf(raw?.end, -1),
    activity_id: find('schedule_activity', String(raw?.activity_id ?? '')) ? String(raw.activity_id) : 'free_time_home',
    detail: String(raw?.detail ?? '').trim().slice(0, 240),
  })).filter((e) => e.start >= 0 && e.end > e.start).sort((a, b) => a.start - b.start);
  const normalized: typeof proposed = [];
  let cursor = 0;
  for (const entry of proposed) {
    const from = Math.max(cursor, entry.start);
    const to = Math.min(1440, entry.end);
    if (from > cursor) normalized.push({ start: cursor, end: from, activity_id: 'free_time_home', detail: 'Unstructured time.' });
    if (to > from) normalized.push({ ...entry, start: from, end: to });
    cursor = Math.max(cursor, to);
    if (cursor >= 1440) break;
  }
  if (cursor < 1440) normalized.push({ start: cursor, end: 1440, activity_id: 'free_time_home', detail: 'Unstructured time.' });
  if (!normalized.length) normalized.push({ start: 0, end: 1440, activity_id: 'free_time_home', detail: 'A completely open day.' });
  const insert = db.prepare(`INSERT INTO schedule_entries
    (id, character_id, starts_at_ms, ends_at_ms, activity_id, title, detail, availability, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM schedule_entries WHERE character_id = ? AND starts_at_ms >= ? AND starts_at_ms < ?').run(characterId, start, end);
    for (const entry of normalized) {
      const row = activity(entry.activity_id);
      insert.run(randomUUID(), characterId, atMinute(key, entry.start), atMinute(key, entry.end),
        entry.activity_id, row.label, entry.detail, availability(entry.activity_id), nowIso());
    }
  })();
}

function fallbackDay(character: Character, key: string): void {
  const nocturnal = /vampire|nocturnal/i.test(`${find('species', character.seed.species)?.label ?? ''} ${find('species', character.seed.species)?.prompt_hint ?? ''}`);
  insertDay(character.id, key, nocturnal
    ? [{ start: '00:00', end: '06:00', activity_id: 'free_time_home', detail: 'Her night is open.' }, { start: '06:00', end: '14:00', activity_id: 'sleeping', detail: 'Her main sleep.' }, { start: '14:00', end: '24:00', activity_id: 'free_time_home', detail: 'An open afternoon and evening.' }]
    : [{ start: '00:00', end: '08:00', activity_id: 'sleeping', detail: 'Her main sleep.' }, { start: '08:00', end: '24:00', activity_id: 'free_time_home', detail: 'An open day.' }]);
}

export async function ensureSchedule(characterId: string): Promise<void> {
  if (running.has(characterId)) return;
  const character = getCharacter(characterId);
  if (!character || character.state !== 'matched') return;
  const targets = targetDays();
  const have = existingDays(characterId);
  const missing = targets.filter((day) => !have.has(day));
  if (!missing.length) return;
  // The first calendar is one coherent fortnight. Once it exists, extend one day at a time.
  // A deliberate jump beyond the entire old horizon is another coherent fortnight rather
  // than fourteen once-a-minute repairs of dates which have already become current.
  const requested = targets.some((day) => have.has(day)) ? missing.slice(0, 1) : missing;
  running.add(characterId);
  try {
    const activities = byCategory('schedule_activity').map((row) =>
      `- ${row.id}: ${row.label} — ${row.prompt_hint}`).join('\n');
    const out = await completeJson<{ days?: { date?: string; entries?: any[] }[] }>({
      scope: 'director', label: `schedule:${character.username}`, schema: SCHEDULE,
      config: { ...getSettings().models.director, max_tokens: getSettings().token_limits.schedule },
      reasoningEffort: 'low', priority: 'background', require: ['days'], timeoutMs: 300_000,
      messages: [{ role: 'user', content: render('director_schedule', {
        character: characterBrief(character), activities,
        target_days: requested.join('\n'), previous_schedule: recentSchedule(character.id),
      }) }],
    });
    const byDay = new Map((out.days ?? []).map((day) => [String(day.date), day.entries ?? []]));
    for (const key of requested) insertDay(character.id, key, byDay.get(key) ?? []);
    logger.info('director', `scheduled ${character.username}`, { days: requested.length });
  } catch (err) {
    logger.warn('director', `schedule for ${character.username} failed; using open-day fallback`, { error: String(err) });
    for (const key of requested) fallbackDay(character, key);
  } finally { running.delete(characterId); }
}

/** One character per scheduler tick keeps rolling extensions cheap and avoids a model burst. */
export async function extendOneSchedule(): Promise<void> {
  for (const character of listActiveMatches()) {
    const missing = targetDays().some((day) => !existingDays(character.id).has(day));
    if (missing) { await ensureSchedule(character.id); return; }
  }
}

export function scheduleAt(characterId: string, at = gameClockMs()): ScheduleEntry | null {
  return (db.prepare(`SELECT * FROM schedule_entries WHERE character_id = ? AND starts_at_ms <= ? AND ends_at_ms > ?
    ORDER BY starts_at_ms DESC LIMIT 1`).get(characterId, at, at) as ScheduleEntry | undefined) ?? null;
}

export function scheduleContext(characterId: string, full = false, omitCurrent = false): string {
  const now = gameClockMs();
  const until = now + 14 * DAY_MS;
  const detailedUntil = now + 48 * 3_600_000;
  const entries = db.prepare(`SELECT * FROM schedule_entries WHERE character_id = ? AND ends_at_ms > ? AND starts_at_ms < ?
    ORDER BY starts_at_ms LIMIT ?`).all(characterId, now, until, full ? 140 : 120) as ScheduleEntry[];
  if (!entries.length) return '';
  const current = omitCurrent ? null : scheduleAt(characterId, now);
  const visibleEntries = omitCurrent
    ? entries.filter((entry) => entry.starts_at_ms > now || entry.ends_at_ms <= now)
    : entries;
  return [
    current ? `Current schedule: ${current.title}${current.detail ? ` — ${current.detail}` : ''}. Availability: ${current.availability}.` : '',
    'Upcoming private calendar:',
    ...visibleEntries.map((e) => `- ${new Date(e.starts_at_ms).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}-${new Date(e.ends_at_ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: ${e.title}${e.detail && (full || e.starts_at_ms < detailedUntil) ? ` — ${e.detail}` : ''}`),
    'This calendar is private context, not something to recite. Availability changes how present she is, never whether she replies: green is open and engaged; yellow is busy and may keep it brief or ask for later; red is occupied/asleep and usually moves toward a natural close, but still answers in character.',
  ].filter(Boolean).join('\n');
}

export function schedulePostWeight(characterId: string): number {
  const entry = scheduleAt(characterId);
  if (!entry) return 0.2;
  return Math.max(0, Number(activity(entry.activity_id)?.extra?.post_weight ?? (entry.availability === 'green' ? 1 : entry.availability === 'yellow' ? 0.6 : 0.05)));
}
