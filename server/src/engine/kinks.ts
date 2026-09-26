import { byCategory, type Attribute } from '../db/attributes.js';
import { getSettings } from '../config.js';
import type { KinkSide, KinkStance } from '../types.js';
import { newContext, rollMany } from './dice.js';
import { getUserProfile } from '../repo.js';
import { joinerFits, joinersFor } from './npcs.js';
import { fitsHer } from './species.js';

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

/** The two ends of a domain, when it has them (`extra.sides` on kink_domain). */
export function domainSides(domain: Attribute | undefined): Record<'her' | 'his', { label: string; hint?: string; dom_sub?: number }> | null {
  const s = domain?.extra?.sides as any;
  return s?.her?.label && s?.his?.label ? s : null;
}

/**
 * Which end of one domain she wants. Each end is coded dominant or submissive like a fetish
 * row, so her leaning picks: a strong domme into bondage ties him up four times in five, a
 * strong sub is the one tied, and someone in the middle is as likely to want both. A persona
 * that is about one end (`extra.side_bias`: a pillow princess and oral) gets it three times
 * in four, since oral and watching are not dominant or submissive either way.
 */
export function rollDomainSide(domain: Attribute, leaning: number, bias?: KinkSide): KinkSide {
  if (bias && Math.random() < 0.75) return bias;
  const sides = domainSides(domain)!;
  const weight = (coded: number) =>
    !coded || !leaning ? 1
    : Math.sign(coded) === Math.sign(leaning) ? 1 + 0.5 * Math.abs(leaning)
    : Math.max(0.08, 1 - 0.3 * Math.abs(leaning));
  const w = { her: weight(Number(sides.her.dom_sub ?? 0)), his: weight(Number(sides.his.dom_sub ?? 0)), both: Math.abs(leaning) <= 1 ? 1 : 0.45 };
  let r = Math.random() * (w.her + w.his + w.both);
  if ((r -= w.her) < 0) return 'her';
  if ((r -= w.his) < 0) return 'his';
  return 'both';
}

/**
 * Her side of every domain with two ends that she is into or curious about. Keeps a side she
 * already has; an existing character without one takes it from her fetishes in that domain
 * (her own feet worshipped -> 'her', both kinds -> 'both') so nothing she has contradicts it,
 * and only rolls where they say nothing.
 */
export function rollKinkSides(seed: {
  kink_map: Record<string, KinkStance>;
  dom_sub_leaning: number;
  fetishes?: string[];
  kink_sides?: Record<string, KinkSide>;
  side_bias?: Record<string, KinkSide>;
}): Record<string, KinkSide> {
  const out: Record<string, KinkSide> = {};
  const fetishes = new Map(byCategory('fetish').map((f) => [f.id, f]));
  for (const d of byCategory('kink_domain')) {
    const st = seed.kink_map?.[d.id];
    if (!domainSides(d) || (st !== 'into' && st !== 'curious')) continue;
    const kept = seed.kink_sides?.[d.id];
    if (kept === 'her' || kept === 'his' || kept === 'both') {
      out[d.id] = kept;
      continue;
    }
    const own = new Set<string>();
    for (const f of (d.extra?.fetishes as string[]) ?? []) {
      const side = fetishes.get(f)?.extra?.side;
      if ((seed.fetishes ?? []).includes(f) && (side === 'her' || side === 'his')) own.add(side);
    }
    out[d.id] = own.size === 2 ? 'both' : own.size === 1 ? ([...own][0] as KinkSide) : rollDomainSide(d, seed.dom_sub_leaning, seed.side_bias?.[d.id]);
  }
  return out;
}

/**
 * A scenario or game that is about one end of a domain (`extra.sides`, e.g. "Over his knee"
 * is impact on her) that is not the end she wants. A domain she has no side on never clashes.
 */
export function wrongEnd(row: Attribute, sides: Record<string, KinkSide> | undefined): boolean {
  const rowSides = (row.extra?.sides ?? {}) as Record<string, string>;
  return Object.entries(rowSides).some(([d, side]) => {
    const hers = sides?.[d];
    return !!hers && hers !== 'both' && hers !== side;
  });
}

/** Whether a fetish row sits on the end of a domain she wants. Rows with no side fit either. */
export function fitsSide(fetish: Attribute | undefined, side: KinkSide | undefined): boolean {
  const own = fetish?.extra?.side;
  return !side || side === 'both' || (own !== 'her' && own !== 'his') || own === side;
}

/** "her feet", "both ways - her feet and his feet", or '' for a domain without ends. */
export function sideLabel(domain: Attribute | undefined, side: KinkSide | undefined): string {
  const s = domainSides(domain);
  if (!s || !side) return '';
  return side === 'both' ? `both ways - ${s.her.label} and ${s.his.label}` : s[side].label;
}

/** The same, with what each end means, for prompts. */
export function sideDetail(domain: Attribute | undefined, side: KinkSide | undefined): string {
  const s = domainSides(domain);
  if (!s || !side) return '';
  const one = (k: 'her' | 'his') => (s[k].hint ? `${s[k].label} (${s[k].hint})` : s[k].label);
  return side === 'both' ? `both ends - ${one('her')}, and ${one('his')}` : `${one(side)} - the other way round does little for her`;
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
  seed: {
    kink_map: Record<string, KinkStance>; dom_sub_leaning: number; kink_sides?: Record<string, KinkSide>;
    relationship_status?: string; species?: string; transgender?: string;
    double_life?: string; era?: string; curse?: string;
  },
  count = 3,
): string[] {
  // A scenario tagged for a power ("on a rooftop after her patrol") or for her body ("the first
  // night she tops him") only comes up for a woman it fits, the same rule fetishes follow.
  const all = byCategory('fantasy_scenario').filter((s) => fitsHer(s, seed));
  const lean = domSubLean(all, seed.dom_sub_leaning);
  const allowed = new Set<string>();
  for (const s of all) {
    const domains = (s.extra?.domains as string[] | undefined) ?? [];
    const stances = domains.map((d) => seed.kink_map?.[d]);
    if (stances.includes('hard_no') || wrongEnd(s, seed.kink_sides)) continue;
    if (!joinerFits(s.extra?.joiner, joinersFor(getUserProfile()))) continue;
    allowed.add(s.id);
    let m = lean[s.id] ?? 1;
    for (const st of stances) m *= st === 'into' ? 3 : st === 'curious' ? 1.5 : st === 'soft_no' ? 0.4 : 1;
    // Written for exactly her kind of woman, so more likely than a generic one: among ninety
    // scenarios, one of five hero scenarios would otherwise almost never reach a hero.
    if ((s.extra?.species as string[] | undefined)?.length || (s.extra?.body as string[] | undefined)?.length || s.extra?.requires) m *= 4;
    lean[s.id] = m;
  }
  // Her relationship status goes in as drawn, so "a night in with her polycule" needs her to
  // have one (the row conflicts with the single statuses).
  const ctx = newContext();
  if (seed.relationship_status) ctx.drawn.add(seed.relationship_status);
  return rollMany('fantasy_scenario', ctx, count, { only: allowed, lean, transient: true }).map((a) => a.id);
}

/**
 * What Settings -> Taste offers, grouped the way he would think about it. Every category here
 * is rolled through roll(), so a "category/id" multiplier in settings.taste reaches it; kink
 * domains are read by rollDomainStance() instead, and "lean/dom_sub" by the persona roll.
 */
export const TASTE_SECTIONS: { title: string; categories: { category: string; label: string; slot?: string }[] }[] = [
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
      { category: 'accessory', label: 'Always on her (glasses, nails, a ring)' },
      // Only matters for the women who cosplay at all; leans which characters they own.
      { category: 'cosplay_character', label: 'Cosplays' },
    ],
  },
  {
    // What is in their closets (wardrobe.ts). Split by slot, since one list of every piece of
    // clothing in the table is unusable; the keys are still wardrobe_item/<id>.
    title: 'Clothes',
    categories: [
      { category: 'wardrobe_item', slot: 'legwear', label: 'Socks, tights and stockings' },
      { category: 'wardrobe_item', slot: 'shoes', label: 'Shoes' },
      { category: 'wardrobe_item', slot: 'top', label: 'Tops' },
      { category: 'wardrobe_item', slot: 'bottom', label: 'Bottoms' },
      { category: 'wardrobe_item', slot: 'dress', label: 'Dresses' },
      { category: 'wardrobe_item', slot: 'outer', label: 'Jackets and coats' },
      { category: 'wardrobe_item', slot: 'extras', label: 'Extras' },
      { category: 'wardrobe_item', slot: 'jewellery', label: 'Jewellery' },
      { category: 'wardrobe_item', slot: 'bra', label: 'Bras' },
      { category: 'wardrobe_item', slot: 'panties', label: 'Panties' },
      { category: 'wardrobe_item', slot: 'lingerie', label: 'Lingerie pieces' },
      { category: 'wardrobe_item', slot: 'swim', label: 'Swimwear' },
      { category: 'carried_item', label: 'Things she carries' },
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
      // Never is a real option for both: nothing here is pushed on him.
      { category: 'transgender', label: 'Gender' },
      { category: 'species', label: 'Species and superpowers' },
      { category: 'hero_role', label: 'Hero role' },
      { category: 'double_life', label: 'Double life' },
      { category: 'era', label: 'Time traveller' },
      { category: 'curse', label: 'Curse' },
      { category: 'duo', label: 'Shared profiles' },
      { category: 'archetype', label: 'Personality' },
      { category: 'texting_persona', label: 'How she texts' },
      { category: 'occupation', label: 'Job' },
      { category: 'relationship_status', label: 'Relationship status' },
    ],
  },
];

