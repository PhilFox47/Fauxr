import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  { table: 'user_profile', column: 'age_min', definition: 'INTEGER NOT NULL DEFAULT 18' },
  { table: 'user_profile', column: 'age_max', definition: 'INTEGER NOT NULL DEFAULT 42' },
  { table: 'user_profile', column: 'kink_map', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'user_profile', column: 'kink_sides', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'user_profile', column: 'joiners', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'dates', column: 'npcs', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'dates', column: 'company', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'relationships', column: 'circle', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'user_profile', column: 'avatar_emoji', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'user_profile', column: 'card', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'images', column: 'aspect', definition: 'TEXT' },
  { table: 'images', column: 'shows_face', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'images', column: 'situation', definition: 'TEXT' },
  // The date mechanic. `dates` existed as an empty stub table long before anything used
  // it, so an old install has the stub's columns and none of these.
  { table: 'messages', column: 'date_id', definition: 'TEXT' },
  { table: 'dates', column: 'location_id', definition: 'TEXT' },
  { table: 'dates', column: 'ended_at', definition: 'TEXT' },
  // The date arrival photo: what she decided to wear, and which date's transcript a
  // 'date'-kind image job posts its result into.
  { table: 'dates', column: 'outfit', definition: 'TEXT' },
  { table: 'images', column: 'date_id', definition: 'TEXT' },
  { table: 'images', column: 'negative_prompt', definition: 'TEXT' },
  { table: 'images', column: 'caption', definition: 'TEXT' },
];

function addMissingColumns(): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!existing.length || existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] added ${table}.${column}`);
  }
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
}

export function nowIso(): string {
  return new Date().toISOString();
}
