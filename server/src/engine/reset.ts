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

/** The cast and everything that happened with them. */
const WORLD_TABLES = ['messages', 'wakeups', 'dates', 'images', 'relationships', 'characters'];

/**
 * Which parts of the install to wipe, chosen independently. Nothing is reset unless it is
 * asked for: an omitted part is a part that survives, so a caller can never take out more
 * than it named.
 */
export interface ResetOptions {
  /** Characters, chats, relationships, wakeups, dates and their generated images. */
  world?: boolean;
  /** Your own profile, and the photos you uploaded with it. */
  profile?: boolean;
  /** API keys, model choices and the tuning sliders. */
  settings?: boolean;
  /** The debug log. */
  logs?: boolean;
}

export interface ResetResult {
  cleared: string[];
  kept: string[];
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
 * Wipe the parts the caller named and leave the rest standing. Resetting the world but
 * keeping your profile drops you straight back into a fresh swipe stack rather than into
 * onboarding; resetting everything comes back up as if the app had never been run.
 *
 * The database file is not deleted. SQLite has it open with a WAL beside it, and removing
 * it from under a live handle is how you get a half-open database rather than a clean one.
 * Emptying tables and re-seeding reaches the same state and cannot leave a broken file
 * behind.
 *
 * `usage_daily` deliberately survives everything: it is a record of money actually spent,
 * not game state, and resetting the game should not reset the daily budget guard.
 */
export async function resetParts(opts: ResetOptions = {}): Promise<ResetResult> {
  const { world = false, profile = false, settings = false, logs = false } = opts;
  logger.warn('app', 'RESET requested', { world, profile, settings, logs });

  const tables = [
    ...(world ? WORLD_TABLES : []),
    ...(profile ? ['user_profile'] : []),
    ...(settings ? ['settings'] : []),
    ...(logs ? ['logs'] : []),
  ];
  if (tables.length === 0) {
    return { cleared: [], kept: ['everything'], files_removed: 0, attribute_rows: 0 };
  }

  // Turns and the scheduler read the cast and the user profile as they run, so they only
  // need standing down when one of those is actually going away.
  const disruptive = world || profile;
  if (disruptive) {
    stopScheduler();
    resetGenerationQueue();
    abandonRunningTurns();
  }

  db.transaction(() => {
    // The attribute tables are re-seeded from the shipped JSON rather than preserved, so a
    // world reset also picks up any edits to those files.
    if (world) db.exec('DELETE FROM attribute_db');
    for (const table of tables) db.exec(`DELETE FROM ${table}`);
    const sequences = [...(world ? ['messages'] : []), ...(logs ? ['logs'] : [])];
    if (sequences.length) {
      db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${sequences.map((s) => `'${s}'`).join(',')})`);
    }
  })();

  db.exec('VACUUM');

  /**
   * The two media directories belong to different parts: `images` is generated for
   * characters, `uploads` is the photos on your own profile. Keeping your profile has to
   * keep the pictures on it, or it comes back with dead thumbnails.
   */
  let filesRemoved = 0;
  if (world) filesRemoved += emptyMediaDir('images');
  if (profile) filesRemoved += emptyMediaDir('uploads');

  if (world) invalidateAttributeCache();
  if (settings) clearSettingsCache();
  if (disruptive) clearPresenceCache();

  const attributeRows = world ? seedAttributes() : 0;

  bus.emitEvent({ type: 'reset' });
  if (disruptive) {
    startScheduler();
    if (world) void ensureStack();
  }

  const kept = [
    ...(world ? [] : ['world']),
    ...(profile ? [] : ['profile']),
    ...(settings ? [] : ['settings']),
    ...(logs ? [] : ['logs']),
    'usage',
  ];

  logger.warn('app', 'RESET complete', {
    cleared: tables,
    kept,
    files_removed: filesRemoved,
    attribute_rows: attributeRows,
  });

  return { cleared: tables, kept, files_removed: filesRemoved, attribute_rows: attributeRows };
}
