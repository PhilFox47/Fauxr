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
  { table: 'user_profile', column: 'avatar_emoji', definition: "TEXT NOT NULL DEFAULT ''" },
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
}

export function nowIso(): string {
  return new Date().toISOString();
}
