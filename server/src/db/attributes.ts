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
export type Rarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'extremely_rare';

export const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 1,
  uncommon: 0.4,
  rare: 0.14,
  very_rare: 0.045,
  extremely_rare: 0.012,
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
  origin?: string; user_modified?: number; user_deleted?: number;
}

export interface EditableAttribute extends Attribute {
  origin: 'shipped' | 'user';
  user_modified: boolean;
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
    WHERE attribute_db.user_modified = 0
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
    const pruneRun = db.transaction(() => {
      for (const [category, ids] of liveIdsByCategory) {
        removed += db.prepare(
          'DELETE FROM attribute_db WHERE category = ? AND origin = ? AND user_modified = 0 AND id NOT IN (SELECT value FROM json_each(?))',
        ).run(category, 'shipped', JSON.stringify([...ids])).changes;
      }
    });
    pruneRun();
    // Whole categories that are no longer shipped at all (touchstone, dealbreaker and the rest
    // of the old game tables) have no live ids to compare against above, so they go here.
    removed += db
      .prepare("DELETE FROM attribute_db WHERE origin = 'shipped' AND user_modified = 0 AND category NOT IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify([...liveIdsByCategory.keys()])).changes;
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

const RARITIES = new Set<Rarity>(['common', 'uncommon', 'rare', 'very_rare', 'extremely_rare']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value.map((v) => v.trim()).filter(Boolean);
}

/** Validate the intentionally flexible row shape without letting malformed JSON reach generation. */
export function normalizeAttribute(value: unknown, forcedCategory?: string): Attribute {
  const raw = object(value, 'attribute');
  const category = String(forcedCategory ?? raw.category ?? '').trim();
  const id = String(raw.id ?? '').trim();
  const label = String(raw.label ?? '').trim();
  if (!CATEGORY_PATTERN.test(category)) throw new Error('category must use lowercase letters, numbers, underscores or hyphens');
  if (!ID_PATTERN.test(id)) throw new Error('id must use lowercase letters, numbers, underscores or hyphens');
  if (!label || label.length > 160) throw new Error('label is required and must be at most 160 characters');
  const weight = Number(raw.weight ?? 1);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1000) throw new Error('weight must be between 0 and 1000');
  const rarity = String(raw.rarity ?? 'common') as Rarity;
  if (!RARITIES.has(rarity)) throw new Error('rarity is not valid');
  const promptHint = String(raw.prompt_hint ?? '').trim();
  const imagePrompt = raw.image_prompt == null || raw.image_prompt === '' ? null : String(raw.image_prompt).trim();
  if (promptHint.length > 10_000 || (imagePrompt?.length ?? 0) > 10_000) throw new Error('prompt text is too long');
  return {
    id, category, label, weight, rarity, prompt_hint: promptHint, image_prompt: imagePrompt,
    affinities: strings(raw.affinities ?? [], 'affinities'),
    conflicts: strings(raw.conflicts ?? [], 'conflicts'),
    modifies: object(raw.modifies ?? {}, 'modifies'),
    extra: object(raw.extra ?? {}, 'extra'),
    enabled: raw.enabled !== false,
  };
}

function writeAttribute(a: Attribute, origin: 'shipped' | 'user' = 'user'): void {
  db.prepare(`
    INSERT INTO attribute_db
      (id, category, label, weight, rarity, prompt_hint, image_prompt, affinities, conflicts, modifies, extra, enabled, origin, user_modified, user_deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT(category, id) DO UPDATE SET
      label=excluded.label, weight=excluded.weight, rarity=excluded.rarity,
      prompt_hint=excluded.prompt_hint, image_prompt=excluded.image_prompt,
      affinities=excluded.affinities, conflicts=excluded.conflicts,
      modifies=excluded.modifies, extra=excluded.extra, enabled=excluded.enabled,
      user_modified=1, user_deleted=0
  `).run(
    a.id, a.category, a.label, a.weight, a.rarity, a.prompt_hint, a.image_prompt,
    JSON.stringify(a.affinities), JSON.stringify(a.conflicts), JSON.stringify(a.modifies),
    JSON.stringify(a.extra), a.enabled ? 1 : 0, origin,
  );
}

export function editableCategories(): { category: string; count: number }[] {
  return db.prepare(`
    SELECT category, sum(CASE WHEN user_deleted = 0 THEN 1 ELSE 0 END) AS count
    FROM attribute_db GROUP BY category ORDER BY category
  `).all() as { category: string; count: number }[];
}

export function editableAttributes(category: string): EditableAttribute[] {
  if (!CATEGORY_PATTERN.test(category)) return [];
  const rows = db.prepare(`
    SELECT * FROM attribute_db WHERE category = ? AND user_deleted = 0 ORDER BY label COLLATE NOCASE, id
  `).all(category) as Row[];
  return rows.map((row) => ({
    ...hydrate(row),
    origin: row.origin === 'user' ? 'user' : 'shipped',
    user_modified: !!row.user_modified,
  }));
}

export function saveEditableAttribute(value: unknown, originalId?: string): Attribute {
  const attribute = normalizeAttribute(value);
  const oldId = String(originalId ?? '').trim();
  db.transaction(() => {
    if (oldId && oldId !== attribute.id) {
      db.prepare('UPDATE attribute_db SET user_deleted = 1, user_modified = 1, enabled = 0 WHERE category = ? AND id = ?')
        .run(attribute.category, oldId);
    }
    const existing = db.prepare('SELECT origin FROM attribute_db WHERE category = ? AND id = ?').get(attribute.category, attribute.id) as { origin: string } | undefined;
    writeAttribute(attribute, existing?.origin === 'shipped' ? 'shipped' : 'user');
  })();
  invalidateAttributeCache();
  return attribute;
}

export function deleteEditableAttribute(category: string, id: string): boolean {
  if (!CATEGORY_PATTERN.test(category) || !ID_PATTERN.test(id)) return false;
  const result = db.prepare(`
    UPDATE attribute_db SET user_deleted = 1, user_modified = 1, enabled = 0 WHERE category = ? AND id = ?
  `).run(category, id);
  invalidateAttributeCache();
  return result.changes > 0;
}

export function replaceEditableCategory(category: string, values: unknown[]): number {
  if (!CATEGORY_PATTERN.test(category)) throw new Error('invalid category');
  if (!Array.isArray(values) || values.length > 20_000) throw new Error('attributes must be an array of at most 20,000 rows');
  const normalized = values.map((value) => normalizeAttribute(value, category));
  const ids = new Set<string>();
  for (const row of normalized) {
    if (ids.has(row.id)) throw new Error(`duplicate id: ${row.id}`);
    ids.add(row.id);
  }
  db.transaction(() => {
    db.prepare('UPDATE attribute_db SET user_deleted = 1, user_modified = 1, enabled = 0 WHERE category = ?').run(category);
    for (const row of normalized) {
      const existing = db.prepare('SELECT origin FROM attribute_db WHERE category = ? AND id = ?').get(category, row.id) as { origin: string } | undefined;
      writeAttribute(row, existing?.origin === 'shipped' ? 'shipped' : 'user');
    }
  })();
  invalidateAttributeCache();
  return normalized.length;
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
