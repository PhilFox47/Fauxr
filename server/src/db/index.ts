import Database from 'better-sqlite3';
import { existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved against this file, not the working directory: npm runs workspace scripts from
 * the workspace folder, so a cwd-relative default put the database in server/data when
 * started with `npm start` and in ./data when started by hand - two different worlds
 * depending on how you launched it. This always lands on <repo root>/data, and on /data
 * inside the container, which is where the volume is mounted anyway.
 */
export const DATA_DIR =
  process.env.FAUXR_DATA_DIR || join(here, '..', '..', '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
mkdirSync(join(DATA_DIR, 'uploads', 'profile'), { recursive: true });
mkdirSync(join(DATA_DIR, 'uploads', 'chat'), { recursive: true });
mkdirSync(join(DATA_DIR, 'images'), { recursive: true });

export const db = new Database(join(DATA_DIR, 'fauxr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Columns added after a database already exists. CREATE TABLE IF NOT EXISTS silently does
 * nothing for a table that is already there, so new columns need adding by hand or an
 * upgraded install keeps running on the old shape.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'relationships', column: 'arousal', definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: 'relationships', column: 'discovered', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'attribute_db', column: 'rarity', definition: "TEXT NOT NULL DEFAULT 'common'" },
  { table: 'attribute_db', column: 'origin', definition: "TEXT NOT NULL DEFAULT 'shipped'" },
  { table: 'attribute_db', column: 'user_modified', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'attribute_db', column: 'user_deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'user_profile', column: 'age_min', definition: 'INTEGER NOT NULL DEFAULT 18' },
  { table: 'user_profile', column: 'age_max', definition: 'INTEGER NOT NULL DEFAULT 42' },
  { table: 'user_profile', column: 'kink_map', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'user_profile', column: 'kink_sides', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'user_profile', column: 'joiners', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'dates', column: 'npcs', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'dates', column: 'company', definition: "TEXT NOT NULL DEFAULT ''" },
  // What she arrived in, slot by slot (wardrobe.ts). Her current outfit on a date is the
  // snapshot on her latest beat, falling back to this - so rerolling a beat undoes its clothes.
  { table: 'dates', column: 'outfit_state', definition: 'TEXT' },
  { table: 'dates', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'date'" },
  { table: 'dates', column: 'duration_minutes', definition: 'INTEGER' },
  { table: 'relationships', column: 'circle', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'relationships', column: 'life', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'user_profile', column: 'avatar_emoji', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'user_profile', column: 'card', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'images', column: 'aspect', definition: 'TEXT' },
  { table: 'images', column: 'shows_face', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'images', column: 'situation', definition: 'TEXT' },
  // The date mechanic. `dates` existed as an empty stub table long before anything used
  // it, so an old install has the stub's columns and none of these.
  { table: 'messages', column: 'date_id', definition: 'TEXT REFERENCES dates(id) ON DELETE CASCADE' },
  { table: 'dates', column: 'location_id', definition: 'TEXT REFERENCES locations(id) ON DELETE SET NULL' },
  { table: 'dates', column: 'ended_at', definition: 'TEXT' },
  // The date arrival photo: what she decided to wear, and which date's transcript a
  // 'date'-kind image job posts its result into.
  { table: 'dates', column: 'outfit', definition: 'TEXT' },
  { table: 'images', column: 'date_id', definition: 'TEXT REFERENCES dates(id) ON DELETE CASCADE' },
  { table: 'images', column: 'negative_prompt', definition: 'TEXT' },
  { table: 'images', column: 'caption', definition: 'TEXT' },
  // What she had on when the photo was prepared (wardrobe.ts), kept so "same idea" redraws it.
  { table: 'images', column: 'outfit', definition: 'TEXT' },
  // This chat's own clock (engine/clock.ts) when the message was sent - see repo.ts's addMessage.
  { table: 'messages', column: 'game_clock_ms', definition: 'INTEGER' },
  { table: 'locations', column: 'affordances', definition: `TEXT NOT NULL DEFAULT '{"sensory":[],"private_spaces":[],"background_people":[],"social_openings":[],"interruptions":[],"transitions":[],"constraints":[]}'` },
];

function addMissingColumns(): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!existing.length || existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] added ${table}.${column}`);
  }
}

/**
 * Older Windows builds stored relative media paths with backslashes, and profile photos and
 * chat uploads shared one directory. Normalize URL-facing paths and move unambiguous legacy
 * uploads into their owner-specific directory. Idempotent: already-normalized rows are skipped.
 */
function migrateMediaPaths(): void {
  const moveUpload = (raw: unknown, owner: 'profile' | 'chat'): string => {
    const normalized = String(raw ?? '').replace(/\\/g, '/');
    if (!/^uploads\/[^/]+$/.test(normalized)) return normalized;
    const next = posix.join('uploads', owner, basename(normalized));
    const from = join(DATA_DIR, normalized);
    const to = join(DATA_DIR, next);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    return next;
  };

  const profiles = db.prepare('SELECT id, photos FROM user_profile').all() as { id: number; photos: string }[];
  const messages = db
    .prepare("SELECT id, meta FROM messages WHERE sender = 'user' AND kind = 'image'")
    .all() as { id: number; meta: string }[];
  const migrateRows = db.transaction(() => {
    for (const row of profiles) {
      try {
        const before = JSON.parse(row.photos) as unknown[];
        const after = before.map((p) => moveUpload(p, 'profile'));
        if (JSON.stringify(after) !== row.photos) {
          db.prepare('UPDATE user_profile SET photos = ? WHERE id = ?').run(JSON.stringify(after), row.id);
        }
      } catch {
        // Profile validation will repair malformed data when it is next saved.
      }
    }
    for (const row of messages) {
      try {
        const meta = JSON.parse(row.meta) as Record<string, unknown>;
        if (!meta.path) continue;
        const next = moveUpload(meta.path, 'chat');
        if (next !== meta.path) {
          db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, path: next }), row.id);
        }
      } catch {
        // A malformed old message remains readable as text; do not make migration fatal.
      }
    }
  });
  migrateRows();
  db.exec("UPDATE images SET path = replace(path, '\\', '/') WHERE path LIKE '%\\%' ");
  db.exec("UPDATE locations SET image_path = replace(image_path, '\\', '/') WHERE image_path LIKE '%\\%' ");
}

export function migrate(): void {
  // schema.sql sits next to the compiled file (copied by the build) or next to the source in dev
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(sql);
  addMissingColumns();
  // Indexes on a column that ADDED_COLUMNS just introduced can't live in schema.sql itself:
  // on a fresh install CREATE TABLE IF NOT EXISTS brings the column in with the table, so an
  // index on it right there is fine, but on an existing install that CREATE TABLE is a no-op
  // and the column does not exist until addMissingColumns() runs above - so the index has to
  // be created down here, after that, not up in the schema script.
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_id, id)');
  // She can no longer block or ghost him. Anyone who did under the old rules comes back.
  // Idempotent: a no-op once nobody is left in either state.
  db.exec(`UPDATE characters SET state = 'matched' WHERE state = 'blocked_by_char'`);
  db.exec(`UPDATE relationships SET ghosted_at = NULL WHERE ghosted_at IS NOT NULL`);
  migrateMediaPaths();
}

export function nowIso(): string {
  return new Date().toISOString();
}
