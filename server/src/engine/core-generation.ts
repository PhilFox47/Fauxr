import { randomUUID } from 'node:crypto';
import { byCategory, type Attribute } from '../db/attributes.js';
import type { CoreEntry, Joiners } from '../types.js';
import { roll, type DiceContext } from './dice.js';
import { coreCount } from './profilecard.js';
import { herLayers, layerVisible } from './layers.js';
import { fitsHer, speciesCaption, speciesRow, speciesVisibility, transRow } from './species.js';
import { joinerFits } from './npcs.js';
import { getSettings } from '../config.js';

export interface CorePlan {
  entries: CoreEntry[];
  /** Values rolled as Core now and reused instead of being rolled again in their old stage. */
  chosen: Record<string, Attribute>;
}

const CAPTION: Record<string, string> = {
  archetype: 'Personality', clothing_style: 'Style', humor_type: 'Humour',
  texting_persona: 'Texts like', speech_style: 'Speaks like', occupation: 'Job',
  living_situation: 'Lives', relationship_status: 'Relationship',
  hobby: 'Lives for', interest: 'Into', sexual_persona: 'In bed',
  search_motive: 'Looking for', fetish: 'Into', quirk: 'Known for',
};

const GROUPS: Array<{ key: string; categories: string[] }> = [
  { key: 'life', categories: ['occupation', 'living_situation', 'relationship_status'] },
  { key: 'pastime', categories: ['hobby', 'interest'] },
  { key: 'expression', categories: ['clothing_style'] },
  { key: 'voice', categories: ['humor_type', 'texting_persona', 'speech_style'] },
  { key: 'detail', categories: ['quirk'] },
  { key: 'intimacy', categories: ['sexual_persona', 'search_motive', 'fetish'] },
];

function coreLikelihood(category: string): number {
  return Math.max(0, byCategory('core_category').find((row) => row.id === category)?.weight ?? 0);
}

function weightedTake<T>(items: T[], weight: (item: T) => number): T | undefined {
  const viable = items.map((item) => ({ item, weight: Math.max(0, weight(item)) })).filter((x) => x.weight > 0);
  if (!viable.length) return undefined;
  let draw = Math.random() * viable.reduce((sum, x) => sum + x.weight, 0);
  for (const candidate of viable) {
    draw -= candidate.weight;
    if (draw <= 0) return candidate.item;
  }
  return viable.at(-1)?.item;
}

function identityAxes(row: Attribute): Set<string> {
  return new Set(Array.isArray(row.extra?.identity_axes) ? row.extra.identity_axes.map(String) : []);
}

/**
 * Roll the load-bearing identity before its supporting fields. Every draw here pays its normal
 * rarity cost; the caller disables rarity immediately afterwards. Affinities from each selected
 * row enter the shared context, so later Core draws and all supporting rolls build on the whole.
 */
export function rollCorePlan(
  ctx: DiceContext,
  base: { species: string; archetype: Attribute; transgender?: string; layers: Record<string, string>; joiners: Joiners },
): CorePlan {
  const entries: CoreEntry[] = [];
  const chosen: Record<string, Attribute> = { archetype: base.archetype };
  const usedAxes = identityAxes(base.archetype);
  const add = (category: string, row: Attribute, key = category) => {
    if (entries.some((entry) => entry.key === key)) return;
    entries.push({ category, id: row.id, key, caption: CAPTION[category] ?? row.category });
    for (const axis of identityAxes(row)) usedAxes.add(axis);
  };

  const species = speciesRow(base as any);
  if (species && speciesVisibility(base as any) === 'profile') {
    entries.push({ category: 'species', id: species.id, key: 'species', caption: speciesCaption(base as any) });
  }
  for (const { def, row } of herLayers(base.layers as any)) {
    if (layerVisible(row)) entries.push({ category: def.field, id: row.id, key: def.field, caption: def.caption });
  }
  const trans = transRow(base as any);
  if (trans) entries.push({ category: 'transgender', id: trans.id, key: 'transgender', caption: 'Gender' });
  add('archetype', base.archetype);

  const target = Math.max(entries.length, coreCount(randomUUID()));
  const unused = GROUPS.filter((group) => group.categories.some((category) => coreLikelihood(category) > 0));
  while (entries.length < target && unused.length) {
    const group = weightedTake(unused, (candidate) => candidate.categories.reduce((sum, category) => sum + coreLikelihood(category), 0));
    if (!group) break;
    unused.splice(unused.indexOf(group), 1);
    const categories = [...group.categories];
    while (categories.length) {
      const category = weightedTake(categories, coreLikelihood);
      if (!category) break;
      categories.splice(categories.indexOf(category), 1);
      let only: Set<string> | undefined;
      if (category === 'fetish') {
        const forbidden = new Set(byCategory('kink_domain')
          .filter((domain) => getSettings().taste?.[`kink_domain/${domain.id}`] === 0)
          .flatMap((domain) => (domain.extra?.fetishes as string[] | undefined) ?? []));
        only = new Set(byCategory('fetish')
          .filter((row) => fitsHer(row, { species: base.species, transgender: base.transgender, ...base.layers }))
          .filter((row) => joinerFits(row.extra?.joiner, base.joiners))
          .filter((row) => !forbidden.has(row.id))
          .map((row) => row.id));
      }
      // Different database categories can still describe the same identity beat (for
      // example an instigating archetype plus sarcastic humour). Core slots are scarce;
      // rows may declare semantic axes so two labels cannot masquerade as two dimensions.
      const axisCompatible = new Set(byCategory(category)
        .filter((candidate) => ![...identityAxes(candidate)].some((axis) => usedAxes.has(axis)))
        .map((candidate) => candidate.id));
      only = only
        ? new Set([...only].filter((id) => axisCompatible.has(id)))
        : axisCompatible;
      let lean: Record<string, number> | undefined;
      if (category === 'sexual_persona') {
        const taste = Math.max(-1, Math.min(1, Number(getSettings().taste?.['lean/dom_sub'] ?? 0)));
        if (taste) {
          lean = {};
          for (const row of byCategory('sexual_persona')) {
            const range = (row.extra?.ranges?.dom_sub_leaning as number[] | undefined) ?? [0, 0];
            lean[row.id] = Math.exp(0.5 * taste * ((range[0] + range[1]) / 2));
          }
        }
      }
      const row = roll(category, ctx, { only, lean });
      if (!row) continue;
      chosen[category] = row;
      add(category, row);
      break;
    }
  }
  // If mandatory public identity consumed most slots, that is the character rather than a
  // reason to silently exceed five. Otherwise fill an occasional spare from any unused group.
  return { entries: entries.slice(0, 5), chosen };
}
