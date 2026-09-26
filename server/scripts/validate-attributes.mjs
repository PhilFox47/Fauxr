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
    // A domain with sides needs both of them, each with a label she and the profile can show.
    const sides = e.extra?.sides;
    if (sides !== undefined) {
      for (const side of ['her', 'his']) {
        if (!sides?.[side]?.label) errors.push(`${e.id} (${e._file}): kink_domain.extra.sides.${side} needs a label`);
      }
    }
  }
  if (e.category === 'fetish' && e.extra?.side !== undefined && !['her', 'his'].includes(e.extra.side)) {
    errors.push(`${e.id} (${e._file}): fetish.extra.side must be 'her' or 'his', not '${e.extra.side}'`);
  }
  if (e.category === 'sexual_persona' && e.extra?.side_bias) {
    for (const [dom, side] of Object.entries(e.extra.side_bias)) {
      const d = (byCategory.get('kink_domain') ?? []).find((k) => k.id === dom);
      if (!d?.extra?.sides) errors.push(`${e.id} (${e._file}): side_bias names '${dom}', which is not a kink domain with sides`);
      if (!['her', 'his', 'both'].includes(side)) errors.push(`${e.id} (${e._file}): side_bias.${dom} must be her, his or both`);
    }
  }
}

// Every ethnicity must leave at least one option in each of the looks rolled after it.
// generator.ts rolls these with `!` - an ethnicity every skin tone conflicts with crashes
// generation instead of just skewing it.
for (const eth of byCategory.get('ethnicity') ?? []) {
  for (const cat of ['skin_tone', 'hair_color', 'eye_color', 'hair_style']) {
    const open = (byCategory.get(cat) ?? []).filter(
      (e) => e.enabled && !e.conflicts.includes(eth.id) && !eth.conflicts.includes(e.id),
    );
    if (!open.length) errors.push(`ethnicity '${eth.id}' conflicts with every ${cat}`);
  }
}

// Wardrobes (engine/wardrobe.ts). Items hang off style families, so a new item only needs a
// slot and a family, and a new clothing style only needs its families - these checks catch a
// typo in either, and a style whose pool is too small to fill its own counts.
{
  const OWNED = ['top', 'bottom', 'dress', 'outer', 'legwear', 'shoes', 'extras', 'bra', 'panties', 'lingerie', 'swim', 'work'];
  const WORN = ['outer', 'top', 'bottom', 'dress', 'bra', 'panties', 'lingerie', 'legwear', 'shoes', 'extras'];
  const ids = (cat) => new Set((byCategory.get(cat) ?? []).map((r) => r.id));
  const families = ids('wardrobe_family');
  const lingerie = ids('lingerie_style');
  const occupations = ids('occupation');
  const items = byCategory.get('wardrobe_item') ?? [];
  if (!families.has('any')) errors.push("wardrobe_family 'any' is missing: every closet starts from it");
  for (const it of items) {
    const x = it.extra ?? {};
    const where = `${it.id} (${it._file})`;
    if (!OWNED.includes(x.slot)) errors.push(`${where}: wardrobe_item slot '${x.slot}' is not one of ${OWNED.join(', ')}`);
    for (const f of x.families ?? []) if (!families.has(f)) errors.push(`${where}: unknown wardrobe family '${f}'`);
    for (const l of x.lingerie ?? []) if (!lingerie.has(l)) errors.push(`${where}: unknown lingerie_style '${l}'`);
    for (const o of x.occupations ?? []) if (!occupations.has(o)) errors.push(`${where}: unknown occupation '${o}'`);
    if (!(x.families?.length || x.lingerie?.length || x.occupations?.length)) errors.push(`${where}: needs families, lingerie or occupations, or nobody can own it`);
    if ((x.slot === 'swim' || x.slot === 'work') && !x.pieces) errors.push(`${where}: a ${x.slot} set needs extra.pieces`);
    for (const k of Object.keys(x.pieces ?? {})) if (!WORN.includes(k)) errors.push(`${where}: piece slot '${k}' is not a worn slot`);
  }
  for (const r of byCategory.get('sleepwear') ?? []) {
    for (const k of Object.keys(r.extra?.pieces ?? {})) if (!WORN.includes(k)) errors.push(`${r.id} (${r._file}): sleepwear piece slot '${k}' is not a worn slot`);
  }
  const countsOf = (id) => (byCategory.get('wardrobe_family') ?? []).find((f) => f.id === id)?.extra?.counts ?? {};
  for (const st of byCategory.get('clothing_style') ?? []) {
    const fams = st.extra?.wardrobe_families ?? [];
    if (!fams.length) { errors.push(`clothing_style '${st.id}' has no wardrobe_families`); continue; }
    for (const f of fams) if (!families.has(f)) errors.push(`clothing_style '${st.id}': unknown wardrobe family '${f}'`);
    const counts = { ...countsOf('any'), ...countsOf(fams[0]), ...(st.extra?.wardrobe_counts ?? {}) };
    for (const slot of ['top', 'bottom', 'dress', 'outer', 'legwear', 'shoes', 'extras', 'swim']) {
      const max = counts[slot]?.[1] ?? 0;
      const pool = items.filter((i) => i.extra?.slot === slot && (i.extra?.families ?? []).some((f) => f === 'any' || fams.includes(f)));
      if (pool.length < max) errors.push(`clothing_style '${st.id}': only ${pool.length} ${slot} pieces for up to ${max}`);
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
