import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const attributesDir = join(serverRoot, 'src', 'data', 'attributes');
const promptsDir = join(serverRoot, 'src', 'prompts', 'templates');

function inside(parent, child) {
  const root = resolve(parent) + sep;
  return resolve(child).startsWith(root);
}

function endingAware(name, source) {
  if (source.includes('hidden.ending')) return source;
  if (name === 'actor_chat') {
    return source
      .replace('Return exactly one JSON object:', 'A conversation is allowed to arrive somewhere and stop. When her reply genuinely completes the exchange for now, give it a clean final line with no upkeep question or new hook and set hidden.ending to "soft_close". This is a resting point, not rejection or ghosting; otherwise use null.\n\nReturn exactly one JSON object:')
      .replace('    "in_the_act": false\n', '    "in_the_act": false,\n    "ending": null\n');
  }
  if (name === 'actor_date') {
    return source
      .replace('Return exactly one JSON object:', 'A date can finish. If this visible beat completes a real goodbye or departure and needs no answer inside the date, set hidden.ending to "end_session". The app delivers this beat and then ends and summarizes the date. Otherwise use null.\n\nReturn exactly one JSON object:')
      .replace('"outfit_changes": [] } }', '"outfit_changes": [], "ending": null } }');
  }
  if (name === 'actor_call') {
    return source
      .replace('Return exactly one JSON object:', 'Calls may end without manufacturing another topic. If she audibly says goodbye or hangs up in this turn and needs no answer on the call, set hidden.ending to "end_session". The app delivers her words and then ends and summarizes the call. Otherwise use null.\n\nReturn exactly one JSON object:')
      .replace('"in_the_act": false } }', '"in_the_act": false, "ending": null } }');
  }
  return source;
}

const exports = process.argv.slice(2).map((path) => {
  if (!existsSync(path)) throw new Error(`export not found: ${path}`);
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
});
if (!exports.length) throw new Error('pass one or more Fauxr attribute or prompt exports');

const attributeExports = new Map();
const promptExports = new Map();
for (const { path, value } of exports) {
  if (value?.format === 'fauxr-attributes' && value.version === 1) {
    const category = String(value.category ?? '').trim();
    if (!category || !Array.isArray(value.attributes)) throw new Error(`invalid attribute export: ${path}`);
    if (attributeExports.has(category)) throw new Error(`category supplied twice: ${category}`);
    const ids = new Set();
    for (const row of value.attributes) {
      if (!row || row.category !== category || typeof row.id !== 'string') throw new Error(`${path}: row does not belong to ${category}`);
      if (ids.has(row.id)) throw new Error(`${path}: duplicate ${category}/${row.id}`);
      ids.add(row.id);
    }
    attributeExports.set(category, value.attributes);
  } else if (value?.format === 'fauxr-prompt' && value.version === 1) {
    const name = String(value.name ?? '').trim();
    if (!name || typeof value.content !== 'string' || !value.content.trim()) throw new Error(`invalid prompt export: ${path}`);
    if (promptExports.has(name)) throw new Error(`prompt supplied twice: ${name}`);
    promptExports.set(name, value.content.replace(/\r\n/g, '\n').trim() + '\n');
  } else {
    throw new Error(`unsupported Fauxr export: ${path}`);
  }
}

// Category exports are complete snapshots. Remove those categories from every old aggregate
// file first, then write one clearly named table per category. This avoids duplicate IDs and
// makes the checked-in source line up with the WebUI's per-type import/export model.
if (attributeExports.size) {
  for (const filename of readdirSync(attributesDir).filter((name) => name.endsWith('.json'))) {
    const path = join(attributesDir, filename);
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`shipped attribute file is not an array: ${filename}`);
    const kept = rows.filter((row) => !attributeExports.has(row.category));
    if (kept.length === rows.length) continue;
    if (!inside(attributesDir, path)) throw new Error(`refusing to alter path outside attributes: ${path}`);
    if (kept.length) writeFileSync(path, JSON.stringify(kept, null, 2) + '\n');
    else unlinkSync(path);
  }
  for (const [category, rows] of attributeExports) {
    const path = join(attributesDir, `${category}.json`);
    if (!inside(attributesDir, path)) throw new Error(`invalid category path: ${category}`);
    writeFileSync(path, JSON.stringify(rows, null, 2) + '\n');
    console.log(`attributes ${category}: ${rows.length}`);
  }

  // A per-category production export can legitimately rename/delete rows without having
  // access to all the other categories that point at them. Reconcile those secondary hints
  // against the final combined library: stale leans must not survive as silent dead IDs.
  const files = readdirSync(attributesDir).filter((name) => name.endsWith('.json'));
  const tables = files.map((filename) => ({
    filename,
    rows: JSON.parse(readFileSync(join(attributesDir, filename), 'utf8')),
  }));
  const all = tables.flatMap((table) => table.rows);
  const allIds = new Set(all.map((row) => row.id));
  const fetishIds = new Set(all.filter((row) => row.category === 'fetish').map((row) => row.id));
  const limitIds = new Set(all.filter((row) => row.category === 'hard_limit').map((row) => row.id));
  let droppedReferences = 0;
  for (const table of tables) {
    for (const row of table.rows) {
      for (const key of ['affinities', 'conflicts']) {
        const before = row[key]?.length ?? 0;
        row[key] = (row[key] ?? []).filter((id) => allIds.has(id));
        droppedReferences += before - row[key].length;
      }
      if (row.extra?.weights && typeof row.extra.weights === 'object') {
        for (const id of Object.keys(row.extra.weights)) {
          if (!allIds.has(id)) {
            delete row.extra.weights[id];
            droppedReferences++;
          }
        }
      }
      if (row.category === 'kink_domain') {
        for (const [key, valid] of [['fetishes', fetishIds], ['limits', limitIds]]) {
          const before = row.extra?.[key]?.length ?? 0;
          if (row.extra?.[key]) row.extra[key] = row.extra[key].filter((id) => valid.has(id));
          droppedReferences += before - (row.extra?.[key]?.length ?? 0);
        }
      }
      if (row.category === 'wardrobe_item' && row.extra?.slot === 'swim' && !row.extra.pieces) {
        const label = String(row.label ?? row.prompt_hint ?? row.id).toLowerCase();
        if (/bikini|tankini/.test(label)) {
          row.extra.pieces = { bra: `${label} top`, panties: `${label} bottoms` };
          if (label.includes('sarong')) row.extra.pieces.bottom = 'matching sarong';
        } else if (/rash guard/.test(label)) {
          row.extra.pieces = { top: label, panties: 'matching swim bottoms' };
        } else {
          row.extra.pieces = { lingerie: label };
        }
      }
    }
    writeFileSync(join(attributesDir, table.filename), JSON.stringify(table.rows, null, 2) + '\n');
  }
  if (droppedReferences) console.log(`removed ${droppedReferences} references to deleted attribute IDs`);
}

for (const [name, source] of promptExports) {
  const path = join(promptsDir, `${name}.md`);
  if (!inside(promptsDir, path) || !existsSync(path)) throw new Error(`unknown prompt template: ${name}`);
  writeFileSync(path, endingAware(name, source));
  console.log(`prompt ${name}: installed`);
}
