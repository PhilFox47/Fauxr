import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', 'data', 'attributes');

/**
 * How often an attribute should turn up. Weight is a manual nudge on top; rarity is the
 * coarse dial, so a table of two hundred entries can be tuned by tagging rather than by
 * hand-picking two hundred numbers.
 */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'very_rare';

export const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 1,
  uncommon: 0.45,
  rare: 0.16,
  very_rare: 0.05,
};

export interface Attribute {
  id: string;
  category: string;
  label: string;
  weight: number;
  rarity: Rarity;
  prompt_hint: string;
  image_prompt: string | null;
  affinities: string[];
  conflicts: string[];
  modifies: Record<string, unknown>;
  extra: Record<string, any>;
  enabled: boolean;
}

interface Row {
  id: string; category: string; label: string; weight: number; rarity: string;
  prompt_hint: string; image_prompt: string | null;
  affinities: string; conflicts: string; modifies: string; extra: string;
  enabled: number;
}

function hydrate(r: Row): Attribute {
  return {
    id: r.id,
    category: r.category,
    label: r.label,
    weight: r.weight,
    rarity: (r.rarity ?? 'common') as Rarity,
    prompt_hint: r.prompt_hint,
    image_prompt: r.image_prompt,
    affinities: JSON.parse(r.affinities),
    conflicts: JSON.parse(r.conflicts),
    modifies: JSON.parse(r.modifies),
    extra: JSON.parse(r.extra),
    enabled: !!r.enabled,
  };
}

/**
 * Insert shipped attribute rows that are not in the database yet. Existing rows are
 * left untouched so that edits made through the (V2) table editor survive an upgrade.
 */
/**
 * Load the shipped attribute tables.
 *
 * New rows are always inserted. Existing rows are only rewritten when the shipped content
 * actually changes, tracked by a hash: without that, an upgrade that adds a field - rarity,
 * say - or rewrites a prompt hint would silently apply to new installs only, because
 * INSERT OR IGNORE leaves existing rows alone. A row's `enabled` flag is carried across a
 * refresh, since that is the one thing a user is likely to have turned off deliberately.
 */
export function seedAttributes(): number {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  const payloads = files.map((f) => readFileSync(join(DATA_DIR, f), 'utf8'));
  const contentHash = createHash('sha256').update(payloads.join('\n')).digest('hex').slice(0, 16);

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'attribute_content_hash'").get() as
    | { value: string }
    | undefined;
  const changed = stored?.value !== contentHash;

  const insert = db.prepare(`
    INSERT INTO attribute_db
      (id, category, label, weight, rarity, prompt_hint, image_prompt, affinities, conflicts, modifies, extra, enabled)
    VALUES (@id, @category, @label, @weight, @rarity, @prompt_hint, @image_prompt, @affinities, @conflicts, @modifies, @extra, @enabled)
    ON CONFLICT(category, id) DO UPDATE SET
      label = excluded.label, weight = excluded.weight, rarity = excluded.rarity,
      prompt_hint = excluded.prompt_hint, image_prompt = excluded.image_prompt,
      affinities = excluded.affinities, conflicts = excluded.conflicts,
      modifies = excluded.modifies, extra = excluded.extra
  `);
  const insertOnly = db.prepare(`
    INSERT OR IGNORE INTO attribute_db
      (id, category, label, weight, rarity, prompt_hint, image_prompt, affinities, conflicts, modifies, extra, enabled)
    VALUES (@id, @category, @label, @weight, @rarity, @prompt_hint, @image_prompt, @affinities, @conflicts, @modifies, @extra, @enabled)
  `);

  let touched = 0;
  const statement = changed ? insert : insertOnly;
  const run = db.transaction((rows: any[]) => {
    for (const row of rows) touched += statement.run(row).changes;
  });

  // Every id the shipped tables currently define, per category - used below to remove
  // rows for anything that was renamed or deleted, e.g. "dirty_talk" splitting into
  // "dirty_talk_receiving" / "dirty_talk_giving". Without this an upgrade only ever adds
  // rows: a renamed attribute leaves its old id behind as a permanent orphan that keeps
  // getting rolled into new characters alongside its replacement.
  const liveIdsByCategory = new Map<string, Set<string>>();

  for (const payload of payloads) {
    const entries = JSON.parse(payload) as Attribute[];
    for (const a of entries) {
      const set = liveIdsByCategory.get(a.category) ?? new Set<string>();
      set.add(a.id);
      liveIdsByCategory.set(a.category, set);
    }
    run(
      entries.map((a) => ({
        id: a.id,
        category: a.category,
        label: a.label,
        weight: a.weight ?? 1,
        rarity: a.rarity ?? 'common',
        prompt_hint: a.prompt_hint ?? '',
        image_prompt: a.image_prompt ?? null,
        affinities: JSON.stringify(a.affinities ?? []),
        conflicts: JSON.stringify(a.conflicts ?? []),
        modifies: JSON.stringify(a.modifies ?? {}),
        extra: JSON.stringify(a.extra ?? {}),
        enabled: a.enabled === false ? 0 : 1,
      })),
    );
  }

  let removed = 0;
  if (changed) {
    const deleteStale = db.prepare('DELETE FROM attribute_db WHERE category = ? AND id NOT IN (SELECT value FROM json_each(?))');
    const pruneRun = db.transaction(() => {
      for (const [category, ids] of liveIdsByCategory) {
        removed += deleteStale.run(category, JSON.stringify([...ids])).changes;
      }
    });
    pruneRun();
    if (removed) console.log(`[db] removed ${removed} attribute row(s) no longer shipped`);

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('attribute_content_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(contentHash);
    invalidateAttributeCache();
  }
  return touched;
}

let cache: Map<string, Attribute[]> | null = null;

export function invalidateAttributeCache(): void {
  cache = null;
}

function loadAll(): Map<string, Attribute[]> {
  if (cache) return cache;
  const rows = db.prepare('SELECT * FROM attribute_db WHERE enabled = 1').all() as Row[];
  const map = new Map<string, Attribute[]>();
  for (const r of rows) {
    const a = hydrate(r);
    const list = map.get(a.category) ?? [];
    list.push(a);
    map.set(a.category, list);
  }
  cache = map;
  return map;
}

export function byCategory(category: string): Attribute[] {
  return loadAll().get(category) ?? [];
}

export function allCategories(): string[] {
  const rows = db
    .prepare('SELECT DISTINCT category FROM attribute_db ORDER BY category')
    .all() as { category: string }[];
  return rows.map((r) => r.category);
}

export function find(category: string, id: string): Attribute | undefined {
  return byCategory(category).find((a) => a.id === id);
}

/** Flat lookup across every category, used for affinity and weight-override matching. */
export function findAnywhere(id: string): Attribute | undefined {
  for (const list of loadAll().values()) {
    const hit = list.find((a) => a.id === id);
    if (hit) return hit;
  }
  return undefined;
}
