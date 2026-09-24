import { byCategory, type Attribute } from '../db/attributes.js';
import { getSettings } from '../config.js';
import type { KinkStance } from '../types.js';
import { newContext, rollMany } from './dice.js';

/**
 * Her standing position on one kink domain, decided before any specific fetish is drawn.
 *
 * The point is that the general view comes first and the specifics live inside it. Fetishes
 * used to be drawn from all 183 rows independently of the 22 hard limits, so a character
 * could genuinely come out loving spanking and refusing all impact - the two tables never
 * consulted each other. Now a domain gets a stance, and both the fetishes and the limits are
 * drawn from that.
 *
 * `freak` decides how generous the stances are, and intensity gates the far end: a domain
 * marked intense is mostly off the table for someone who is not built for it, rather than
 * being impossible for anyone. Lives here rather than in generator.ts so the backfill in
 * repo.ts can give an existing character a stance on a domain added after she was made.
 */
export function rollDomainStance(freak: number, domain: Attribute, bias = 0): KinkStance {
  const intensity = Number(domain.extra?.intensity ?? 0);
  // His taste (Settings -> Taste) leans the domain like a persona does: "more" is about a
  // point and a half of reach, "less" about as much the other way, "never" keeps her off it.
  const taste = getSettings().taste?.[`kink_domain/${domain.id}`];
  if (taste === 0) return 'soft_no';
  const tasteBias = typeof taste === 'number' && taste > 0 ? Math.log2(taste) : 0;
  // Roughly: freak 0 says yes to almost nothing, freak 5 says yes to most of the
  // mainstream and a fair bit of the rest. Her persona leans specific domains on top -
  // a rope bunny is far more likely to be into bondage than her freak alone would make her.
  const reach = freak - intensity * 1.7 + bias + tasteBias;
  const intoChance = Math.max(0.02, Math.min(0.6, 0.05 + reach * 0.115));
  const curiousChance = Math.max(0.05, Math.min(0.4, 0.12 + reach * 0.07));
  const r = Math.random();
  if (r < intoChance) return 'into';
  if (r < intoChance + curiousChance) return 'curious';
  // A hard no is a real position, not just absence of interest, and it is much more likely
  // on the things she is furthest from.
  return Math.random() < 0.25 + intensity * 0.16 - freak * 0.04 ? 'hard_no' : 'soft_no';
}

export function rollKinkMap(freak: number, domains: Attribute[], bias: Record<string, number> = {}): Record<string, KinkStance> {
  const map: Record<string, KinkStance> = {};
  for (const d of domains) map[d.id] = rollDomainStance(freak, d, Number(bias[d.id] ?? 0));
  return map;
}

/**
 * How much a row that is coded dominant (extra.dom_sub > 0) or submissive (< 0) suits her,
 * as per-id multipliers for roll()'s `lean`. A strong domme almost never draws "being
 * pinned" as a turn-on, a strong sub almost never "a man on his knees"; a switch gets both.
 * Rows without the tag are untouched.
 */
export function domSubLean(rows: Attribute[], leaning: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of rows) {
    const coded = Number(a.extra?.dom_sub ?? 0);
    if (!coded || !leaning) continue;
    out[a.id] = Math.sign(coded) === Math.sign(leaning)
      ? 1 + 0.5 * Math.abs(leaning)
      : Math.max(0.08, 1 - 0.3 * Math.abs(leaning));
  }
  return out;
}

/**
 * Two or three scenario ideas for her fantasies, from the fantasy_scenario table. They are
 * starting points the character pass adapts to her, alongside ones she invents herself -
 * left to invent all of them from one prompt, the whole cast drifts to the same hotel-bar
 * stranger. A scenario leans towards domains she is into (x3) or curious about (x1.5), never
 * touches one she is a hard no on, and follows her dom/sub leaning like her kinks do.
 */
export function rollFantasySeeds(
  seed: { kink_map: Record<string, KinkStance>; dom_sub_leaning: number },
  count = 3,
): string[] {
  const all = byCategory('fantasy_scenario');
  const lean = domSubLean(all, seed.dom_sub_leaning);
  const allowed = new Set<string>();
  for (const s of all) {
    const domains = (s.extra?.domains as string[] | undefined) ?? [];
    const stances = domains.map((d) => seed.kink_map?.[d]);
    if (stances.includes('hard_no')) continue;
    allowed.add(s.id);
    let m = lean[s.id] ?? 1;
    for (const st of stances) m *= st === 'into' ? 3 : st === 'curious' ? 1.5 : st === 'soft_no' ? 0.4 : 1;
    lean[s.id] = m;
  }
  return rollMany('fantasy_scenario', newContext(), count, { only: allowed, lean, transient: true }).map((a) => a.id);
}

/**
 * What Settings -> Taste offers, grouped the way he would think about it. Every category here
 * is rolled through roll(), so a "category/id" multiplier in settings.taste reaches it; kink
 * domains are read by rollDomainStance() instead, and "lean/dom_sub" by the persona roll.
 */
export const TASTE_SECTIONS: { title: string; categories: { category: string; label: string }[] }[] = [
  {
    title: 'Looks',
    categories: [
      { category: 'clothing_style', label: 'Style' },
      { category: 'ethnicity', label: 'Ethnicity' },
      { category: 'body_type', label: 'Build' },
      { category: 'breast_size', label: 'Breasts' },
      { category: 'butt_size', label: 'Butt' },
      { category: 'height', label: 'Height' },
      { category: 'hair_color', label: 'Hair colour' },
      { category: 'hair_style', label: 'Hairstyle' },
      { category: 'makeup_style', label: 'Makeup' },
      { category: 'accessory', label: 'Accessories' },
    ],
  },
  {
    title: 'In bed',
    categories: [
      { category: 'sexual_persona', label: 'Who she is in bed' },
      { category: 'kink_domain', label: 'Kinks' },
      { category: 'lingerie_style', label: 'Underneath' },
      { category: 'dirty_talk', label: 'Dirty talk' },
      { category: 'fantasy_scenario', label: 'Fantasy ideas' },
    ],
  },
  {
    title: 'Who she is',
    categories: [
      { category: 'archetype', label: 'Personality' },
      { category: 'texting_persona', label: 'How she texts' },
      { category: 'occupation', label: 'Job' },
      { category: 'relationship_status', label: 'Relationship status' },
    ],
  },
];
