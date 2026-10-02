import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings } from '../config.js';
import { DATA_DIR, db, nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { STATUS_POST } from '../llm/schemas.js';
import { logger } from '../log.js';
import { bus } from '../events.js';
import { render } from '../prompts/render.js';
import { characterIdsOnDate, getCharacter, listActiveMatches } from '../repo.js';
import type { Character } from '../types.js';
import { describeSeed } from './generator.js';
import { gameClockMs } from './clock.js';
import { getImageJob, photoSelfBlock, profilePictureState, renderStandaloneImage, type ImageJob } from './images.js';
import { ensureSchedule, scheduleAt, schedulePostWeight } from './schedule.js';
import { communicationBlock } from './blocks.js';

export interface StatusPost {
  id: string;
  character_id: string;
  image_id: string;
  caption: string;
  created_at_ms: number;
  expires_at_ms: number;
  liked: number;
  viewed_at_ms: number | null;
  created_at: string;
  image_path: string;
  image_updated_at: string;
  aspect: string | null;
}

const RATE_KEY = 'next_status_post_ms';
let creating = false;

function isVisibleMatch(character: Character): boolean {
  return character.state === 'matched' && (!character.matched_at || Date.parse(character.matched_at) <= Date.now());
}

function readDue(): number | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(RATE_KEY) as { value: string } | undefined;
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : null;
}

function writeDue(value: number): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(RATE_KEY, String(Math.round(value)));
}

function nextIntervalMs(rate: number): number {
  // Exponential spacing feels organic while preserving the requested cast-wide average.
  const hours = -Math.log(Math.max(0.0001, 1 - Math.random())) / rate;
  return Math.max(5 * 60_000, hours * 3_600_000);
}

function eligible(): { character: Character; weight: number }[] {
  if (!getSettings().images_enabled) return [];
  const onDate = characterIdsOnDate();
  const now = gameClockMs();
  return listActiveMatches().filter((character) =>
    isVisibleMatch(character) && !onDate.has(character.id) && profilePictureState(character.id) === 'done'
  ).map((character) => {
    const latest = db.prepare('SELECT MAX(created_at_ms) AS at FROM status_posts WHERE character_id = ?')
      .get(character.id) as { at: number | null };
    const ageHours = latest.at == null ? 24 : Math.max(0, (now - latest.at) / 3_600_000);
    // Current activity dominates; recency prevents one lively character monopolising the feed.
    return { character, weight: schedulePostWeight(character.id) * Math.min(1, 0.12 + ageHours / 8) };
  }).filter((candidate) => candidate.weight > 0);
}

function weightedCharacter(): Character | null {
  const candidates = eligible();
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (total <= 0) return null;
  let pick = Math.random() * total;
  for (const candidate of candidates) {
    pick -= candidate.weight;
    if (pick <= 0) return candidate.character;
  }
  return candidates.at(-1)?.character ?? null;
}

function backstageCharacter(character: Character): string {
  const dossier = character.seed.hints.dossier_source === 'generated'
    ? character.seed.hints.dossier
    : describeSeed(character.seed);
  return dossier || describeSeed(character.seed);
}

interface StatusMemoryRow {
  caption: string;
  created_at_ms: number;
  situation: string | null;
}

function recentStatusRows(characterId: string, now = gameClockMs()): StatusMemoryRow[] {
  return db.prepare(`SELECT sp.caption, sp.created_at_ms, i.situation
    FROM status_posts sp JOIN images i ON i.id = sp.image_id
    WHERE sp.character_id = ? AND sp.created_at_ms <= ? AND sp.created_at_ms > ?
    ORDER BY sp.created_at_ms DESC LIMIT 4`).all(characterId, now, now - 24 * 3_600_000) as StatusMemoryRow[];
}

/**
 * Temporary stories are still things she chose to share and things she really did. Keeping a
 * compact recent window in Actor context lets him ask "what were you painting?" without turning
 * every Status into permanent ledger memory or making her bring old posts up unprompted.
 */
export function recentStatusContext(characterId: string, now = gameClockMs()): string {
  const rows = recentStatusRows(characterId, now);
  if (!rows.length) return '';
  return [
    'Your recent Status stories (newest first):',
    ...rows.map((row) => {
      const when = new Date(row.created_at_ms).toLocaleString('en-GB', {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
      const caption = row.caption.trim() ? ` Caption: “${row.caption.trim()}”` : '';
      const situation = String(row.situation ?? '').trim();
      return `- ${when}.${caption}${situation ? ` What you posted showed: ${situation}` : ''}`;
    }),
    'These are real recent parts of your life, not messages to him. You remember them and can answer naturally if he refers to one. Do not mention a Status merely to prove you remember it, and do not assume he saw or liked it.',
  ].join('\n');
}

function recentStatusesForPosting(characterId: string): string {
  return recentStatusRows(characterId)
    .map((row) => `- ${row.caption || '(no caption)'}${row.situation ? ` — ${row.situation}` : ''}`)
    .join('\n');
}

function cleanAuthoredCaption(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 280) return text;
  const shortened = text.slice(0, 277);
  const boundary = shortened.lastIndexOf(' ');
  return `${boundary > 180 ? shortened.slice(0, boundary) : shortened}...`;
}

export function activeStatusPosts(characterId: string): StatusPost[] {
  return db.prepare(`SELECT sp.*, i.path AS image_path, i.updated_at AS image_updated_at, i.aspect
    FROM status_posts sp JOIN images i ON i.id = sp.image_id
    WHERE sp.character_id = ? AND sp.expires_at_ms > ? AND i.status = 'done' AND i.path IS NOT NULL
    ORDER BY sp.created_at_ms`).all(characterId, gameClockMs()) as StatusPost[];
}

export function hasActiveStatus(characterId: string): boolean {
  return activeStatusPosts(characterId).length > 0;
}

export function hasUnseenActiveStatus(characterId: string): boolean {
  return db.prepare(`SELECT 1 FROM status_posts sp JOIN images i ON i.id = sp.image_id
    WHERE sp.character_id = ? AND sp.expires_at_ms > ? AND sp.viewed_at_ms IS NULL
      AND i.status = 'done' AND i.path IS NOT NULL LIMIT 1`).get(characterId, gameClockMs()) != null;
}

/** Mark one slide watched only when the viewer actually presents it, not when it preloads the set. */
export function viewStatusPost(id: string): StatusPost | null {
  db.prepare('UPDATE status_posts SET viewed_at_ms = COALESCE(viewed_at_ms, ?) WHERE id = ?')
    .run(gameClockMs(), id);
  return (db.prepare(`SELECT sp.*, i.path AS image_path, i.updated_at AS image_updated_at, i.aspect
    FROM status_posts sp JOIN images i ON i.id = sp.image_id WHERE sp.id = ?`).get(id) as StatusPost | undefined) ?? null;
}

export function likeStatusPost(id: string): StatusPost | null {
  db.prepare('UPDATE status_posts SET liked = 1 WHERE id = ?').run(id);
  return (db.prepare(`SELECT sp.*, i.path AS image_path, i.updated_at AS image_updated_at, i.aspect
    FROM status_posts sp JOIN images i ON i.id = sp.image_id WHERE sp.id = ?`).get(id) as StatusPost | undefined) ?? null;
}

function publishRenderedStatus(image: ImageJob): StatusPost | null {
  if (image.kind !== 'status' || image.status !== 'done' || !image.path || !image.character_id) return null;
  const existing = db.prepare('SELECT id FROM status_posts WHERE image_id = ?').get(image.id) as { id: string } | undefined;
  if (existing) return activeStatusPosts(image.character_id).find((post) => post.id === existing.id) ?? null;
  const now = gameClockMs();
  const id = randomUUID();
  db.prepare(`INSERT INTO status_posts
    (id, character_id, image_id, caption, created_at_ms, expires_at_ms, liked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(
    id, image.character_id, image.id, image.caption ?? '', now, now + 24 * 3_600_000, nowIso(),
  );
  bus.emitEvent({ type: 'status_post', character_id: image.character_id });
  return activeStatusPosts(image.character_id).find((post) => post.id === id) ?? null;
}

/** Settings can retry a failed Status image; successful retry publishes it exactly once. */
export function publishRetriedStatusImage(imageId: string): StatusPost | null {
  const image = getImageJob(imageId);
  return image ? publishRenderedStatus(image) : null;
}

function cleanupExpiredStatuses(): void {
  const rows = db.prepare(`SELECT sp.image_id, i.path FROM status_posts sp
    JOIN images i ON i.id = sp.image_id
    WHERE sp.expires_at_ms <= ? AND sp.liked = 0`).all(gameClockMs()) as { image_id: string; path: string | null }[];
  if (!rows.length) return;
  db.transaction(() => {
    for (const row of rows) db.prepare('DELETE FROM images WHERE id = ?').run(row.image_id);
  })();
  for (const row of rows) {
    if (!row.path) continue;
    try { unlinkSync(join(DATA_DIR, row.path)); } catch { /* already absent */ }
  }
}

export async function createStatusPost(characterId?: string): Promise<StatusPost | null> {
  if (creating) return null;
  creating = true;
  try {
    let character = characterId ? getCharacter(characterId) : weightedCharacter();
    if (characterId && (!character || !isVisibleMatch(character) || profilePictureState(character.id) !== 'done')) return null;
    if (!character) return null;
    await ensureSchedule(character.id);
    const entry = scheduleAt(character.id);
    if (!entry) return null;
    const settings = getSettings();
    const output = await completeJson<{ situation?: string; caption?: string; aspect?: string; shows_face?: boolean }>({
      scope: 'actor', label: `status_post:${character.username}`, schema: STATUS_POST,
      config: { ...settings.models.actor, max_tokens: settings.token_limits.status_post },
      reasoningEffort: 'none', priority: 'background', require: ['situation', 'caption', 'aspect', 'shows_face'],
      messages: [{ role: 'user', content: render('actor_status_post', {
        real_name: character.real_name,
        character: backstageCharacter(character),
        voice: communicationBlock(character.seed),
        photo_self: photoSelfBlock(character.seed, { closet: true }),
        schedule: `${entry.title}${entry.detail ? ` — ${entry.detail}` : ''}. Availability: ${entry.availability}.`,
        world_time: new Date(gameClockMs()).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }),
        recent_statuses: recentStatusesForPosting(character.id),
      }) }],
    });
    const situation = String(output.situation ?? '').trim();
    const caption = cleanAuthoredCaption(output.caption);
    if (!situation || !caption) return null;
    const aspect = output.aspect === 'square' || output.aspect === 'landscape' ? output.aspect : 'portrait';
    let image = await renderStandaloneImage({
      characterId: character.id, kind: 'status', situation, aspect,
      showsFace: output.shows_face !== false, postToChat: false,
    });
    if (image.status !== 'done' || !image.path) return null;
    // The image assembler also produces utilitarian captions for chat-photo placeholders. A
    // Status is different: the text beneath it is authored by her in the Actor call above.
    db.prepare('UPDATE images SET caption = ? WHERE id = ?').run(caption, image.id);
    image = getImageJob(image.id)!;
    const post = publishRenderedStatus(image);
    if (post) logger.info('image', `${character.username} posted a Status story`, { character_id: character.id, status_id: post.id });
    return post;
  } finally { creating = false; }
}

/** One due event at most. A large time jump deliberately never creates a missed-story backlog. */
export async function maybeCreateScheduledStatus(): Promise<void> {
  cleanupExpiredStatuses();
  const rate = getSettings().status_posts_per_hour;
  const now = gameClockMs();
  if (rate <= 0) { writeDue(now); return; }
  const due = readDue();
  if (due == null) { writeDue(now + nextIntervalMs(rate)); return; }
  if (now < due || creating) return;
  await createStatusPost();
  writeDue(gameClockMs() + nextIntervalMs(rate));
}
