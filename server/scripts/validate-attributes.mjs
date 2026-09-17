import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sanity-checks server/src/data/attributes/*.json before it ever reaches seedAttributes().
 * Nothing here is enforced at runtime - a duplicate id silently overwrites (ON CONFLICT),
 * a dangling reference just makes find() return undefined - so this is the only thing that
 * actually catches either before it ships. Run with `node server/scripts/validate-attributes.mjs`.
 */

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(serverRoot, 'src', 'data', 'attributes');

const VALID_RARITY = new Set(['common', 'uncommon', 'rare', 'very_rare', 'extremely_rare']);
const REQUIRED_FIELDS = {
  id: 'string', category: 'string', label: 'string', weight: 'number', rarity: 'string',
  prompt_hint: 'string', affinities: 'object', conflicts: 'object', modifies: 'object',
  extra: 'object', enabled: 'boolean',
};

const files = readdirSync(dataDir).filter((f) => f.endsWith('.json'));
const all = [];
for (const file of files) {
  const entries = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
  for (const e of entries) all.push({ ...e, _file: file });
}

const byCategory = new Map();
for (const e of all) {
  if (!byCategory.has(e.category)) byCategory.set(e.category, []);
  byCategory.get(e.category).push(e);
}
const allIds = new Set(all.map((e) => e.id));

const errors = [];

// Unique id within its own category - a duplicate silently overwrites at seed time.
for (const [cat, entries] of byCategory) {
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.id)) errors.push(`duplicate id '${e.id}' in category '${cat}' (${seen.get(e.id)} and ${e._file})`);
    seen.set(e.id, e._file);
  }
}

// Required fields, correct types, valid rarity.
for (const e of all) {
  for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in e)) errors.push(`${e.id ?? '?'} (${e._file}): missing field '${field}'`);
    else if (typeof e[field] !== type) errors.push(`${e.id} (${e._file}): field '${field}' is ${typeof e[field]}, expected ${type}`);
  }
  if (!VALID_RARITY.has(e.rarity)) errors.push(`${e.id} (${e._file}): invalid rarity '${e.rarity}'`);
}

// Dangling references. dice.ts's ctx.drawn accumulates ids across every category rolled in
// one generation cascade, so affinities/conflicts are valid cross-category references, not
// scoped to the entry's own category.
for (const e of all) {
  for (const ref of e.affinities ?? []) {
    if (!allIds.has(ref)) errors.push(`${e.id} (${e._file}): dangling affinity '${ref}'`);
  }
  for (const ref of e.conflicts ?? []) {
    if (!allIds.has(ref)) errors.push(`${e.id} (${e._file}): dangling conflict '${ref}'`);
  }
  const weights = e.extra?.weights;
  if (weights && typeof weights === 'object') {
    for (const ref of Object.keys(weights)) {
      if (!allIds.has(ref)) errors.push(`${e.id} (${e._file}): dangling extra.weights key '${ref}'`);
    }
  }
  if (e.category === 'kink_domain') {
    const fetishIds = new Set((byCategory.get('fetish') ?? []).map((f) => f.id));
    const limitIds = new Set((byCategory.get('hard_limit') ?? []).map((f) => f.id));
    for (const ref of e.extra?.fetishes ?? []) {
      if (!fetishIds.has(ref)) errors.push(`${e.id} (${e._file}): kink_domain.extra.fetishes references unknown fetish '${ref}'`);
    }
    for (const ref of e.extra?.limits ?? []) {
      if (!limitIds.has(ref)) errors.push(`${e.id} (${e._file}): kink_domain.extra.limits references unknown hard_limit '${ref}'`);
    }
  }
}

console.log(`${all.length} entries across ${byCategory.size} categories in ${files.length} files.`);
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const err of errors) console.log(' -', err);
  process.exit(1);
}
console.log('\nAll checks passed.');
