// Throwaway invariant check. Always uses an isolated database.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FAUXR_DATA_DIR = mkdtempSync(join(tmpdir(), 'fauxr-coherence-'));
const { migrate } = await import('../dist/db/index.js');
migrate();
const attributes = await import('../dist/db/attributes.js');
attributes.seedAttributes();
const { rollSeed } = await import('../dist/engine/generator.js');
const { newContext, roll } = await import('../dist/engine/dice.js');

const domains = attributes.byCategory('kink_domain');
const claimed = new Map();
for (const domain of domains) for (const id of domain.extra?.fetishes ?? []) {
  if (!claimed.has(id)) claimed.set(id, []);
  claimed.get(id).push(domain.id);
}
const fetishRows = new Map(attributes.byCategory('fetish').map((row) => [row.id, row]));
for (const row of fetishRows.values()) for (const domainId of row.extra?.domains ?? []) {
  if (!claimed.has(row.id)) claimed.set(row.id, []);
  if (!claimed.get(row.id).includes(domainId)) claimed.get(row.id).push(domainId);
}
const limitRows = new Map(attributes.byCategory('hard_limit').map((row) => [row.id, row]));

for (let i = 0; i < 2000; i++) {
  const { seed } = rollSeed();
  const height = attributes.find('height', seed.height);
  const short = height?.extra?.stature === 'short' || ['very_short', 'short', 'just_under_average'].includes(seed.height);
  const tall = height?.extra?.stature === 'tall' || ['tall', 'very_tall', 'just_over_average', 'statuesque', 'exceptionally_tall'].includes(seed.height);
  if (seed.body_pride === 'being_petite') assert.ok(short, `petite pride with ${seed.height}`);
  if (seed.body_pride === 'her_height') assert.ok(tall, `tall pride with ${seed.height}`);
  if (seed.body_pride === 'her_tattoos') assert.ok(seed.tattoos.length, 'tattoo pride without tattoos');
  if (seed.body_pride === 'her_piercings') assert.ok(seed.piercings.length, 'piercing pride without piercings');
  const persona = attributes.find('sexual_persona', seed.sexual_persona);
  for (const domain of persona?.extra?.requires_domains ?? []) {
    assert.equal(seed.kink_map[domain], 'into', `${persona.id} requires ${domain}`);
  }
  const any = persona?.extra?.requires_any_domains ?? [];
  if (any.length) assert.ok(any.some((domain) => ['into', 'curious'].includes(seed.kink_map[domain])), `${persona.id} requires one of ${any}`);
  for (const fetish of seed.fetishes) {
    for (const domain of claimed.get(fetish) ?? []) {
      assert.ok(['into', 'curious'].includes(seed.kink_map[domain]), `${fetish} under ${domain}=${seed.kink_map[domain]}`);
    }
  }
  for (const limit of seed.hard_limits) {
    const conflicts = new Set(limitRows.get(limit)?.conflicts ?? []);
    assert.ok(!seed.fetishes.some((id) => conflicts.has(id)), `${limit} conflicts with a rolled fetish`);
  }
}

// A prior row's one-way exclusion must block a later candidate even if that candidate does
// not repeat the reverse conflict itself.
const source = [...attributes.byCategory('hard_limit'), ...attributes.byCategory('body_type')]
  .find((row) => row.conflicts?.some((id) => fetishRows.has(id)));
assert.ok(source, 'fixture with a one-way conflict exists');
const target = source.conflicts.find((id) => fetishRows.has(id));
const ctx = newContext();
ctx.drawn.add(source.id);
for (const id of source.conflicts) ctx.forbidden.add(id);
assert.equal(roll('fetish', ctx, { only: new Set([target]) }), null);

console.log('Coherence invariants passed across 2,000 rolls.');
