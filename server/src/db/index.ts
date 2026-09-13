import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.FAUXR_DATA_DIR || join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
mkdirSync(join(DATA_DIR, 'images'), { recursive: true });

export const db = new Database(join(DATA_DIR, 'fauxr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate(): void {
  // schema.sql sits next to the compiled file (copied by the build) or next to the source in dev
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(sql);
}

export function nowIso(): string {
  return new Date().toISOString();
}
