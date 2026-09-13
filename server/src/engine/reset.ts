import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { clearSettingsCache } from '../config.js';
import { DATA_DIR, db } from '../db/index.js';
import { invalidateAttributeCache, seedAttributes } from '../db/attributes.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import { abandonRunningTurns } from './chat.js';
import { ensureStack, resetGenerationQueue } from './matching.js';
import { clearPresenceCache, startScheduler, stopScheduler } from './scheduler.js';

/** Everything that is game state. Wiped on any reset. */
const WORLD_TABLES = [
  'messages',
  'wakeups',
  'dates',
  'images',
  'relationships',
  'characters',
  'user_profile',
  'logs',
];

/** Configuration. Only wiped when the caller asks for it explicitly. */
const CONFIG_TABLES = ['settings'];

export interface ResetOptions {
  /** Also clear the API keys, model names and tuning. Off by default. */
  includeSettings?: boolean;
}

export interface ResetResult {
  cleared: string[];
  settings_kept: boolean;
  files_removed: number;
  attribute_rows: number;
}

function emptyMediaDir(name: string): number {
  const dir = join(DATA_DIR, name);
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    rmSync(join(dir, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Wipe the world and come back up as if the app had never been run: no profile, so the UI
 * lands on onboarding, and a freshly generated swipe stack.
 *
 * The database file is not deleted. SQLite has it open with a WAL beside it, and removing
 * it from under a live handle is how you get a half-open database rather than a clean one.
 * Emptying every table and re-seeding reaches the same state and cannot leave a broken
 * file behind.
 *
 * `usage_daily` deliberately survives everything: it is a record of money actually spent,
 * not game state, and resetting the game should not reset the daily budget guard.
 */
export async function resetEverything(opts: ResetOptions = {}): Promise<ResetResult> {
  logger.warn('app', 'RESET requested', { include_settings: !!opts.includeSettings });

  // Stop anything that could write while the tables are going away.
  stopScheduler();
  resetGenerationQueue();
  abandonRunningTurns();

  const tables = [...WORLD_TABLES, ...(opts.includeSettings ? CONFIG_TABLES : [])];

  db.transaction(() => {
    // The attribute tables are re-seeded from the shipped JSON rather than preserved, so
    // a reset also picks up any edits to those files.
    db.exec('DELETE FROM attribute_db');
    for (const table of tables) db.exec(`DELETE FROM ${table}`);
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages','logs')");
  })();

  db.exec('VACUUM');

  const filesRemoved = emptyMediaDir('uploads') + emptyMediaDir('images');

  invalidateAttributeCache();
  if (opts.includeSettings) clearSettingsCache();
  clearPresenceCache();

  const attributeRows = seedAttributes();

  bus.emitEvent({ type: 'reset' });
  startScheduler();
  void ensureStack();

  logger.warn('app', 'RESET complete', {
    cleared: tables,
    files_removed: filesRemoved,
    attribute_rows: attributeRows,
  });

  return {
    cleared: tables,
    settings_kept: !opts.includeSettings,
    files_removed: filesRemoved,
    attribute_rows: attributeRows,
  };
}
