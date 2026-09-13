import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', 'data', 'attributes');

export interface Attribute {
  id: string;
  category: string;
  label: string;
  weight: number;
  prompt_hint: string;
  image_prompt: string | null;
  affinities: string[];
  conflicts: string[];
  modifies: Record<string, unknown>;
  extra: Record<string, any>;
  enabled: boolean;
}

interface Row {
  id: string; category: string; label: string; weight: number;
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
export function seedAttributes(): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO attribute_db
      (id, category, label, weight, prompt_hint, image_prompt, affinities, conflicts, modifies, extra, enabled)
    VALUES (@id, @category, @label, @weight, @prompt_hint, @image_prompt, @affinities, @conflicts, @modifies, @extra, @enabled)
  `);
  let inserted = 0;
  const run = db.transaction((rows: any[]) => {
    for (const row of rows) inserted += insert.run(row).changes;
  });

  for (const file of readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))) {
    const entries = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as Attribute[];
    run(
      entries.map((a) => ({
        id: a.id,
        category: a.category,
        label: a.label,
        weight: a.weight,
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
  return inserted;
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
