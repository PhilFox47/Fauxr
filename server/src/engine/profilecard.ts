import { find, RARITY_WEIGHT } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';

/**
 * The three things on her swipe card that say who she is.
 *
 * The card used to be a handle, an age, her languages and a bio, which made choosing whom to
 * talk to a guess. Now it names three of her defining traits. They are picked here from her
 * seed, not stored, so every existing character has them the moment this ships:
 * - candidates are her species (when she is not human), personality, style, who she is in
 *   bed, her signature kink, her job, and her relationship status when it is not plain single;
 * - each scores by how rare the rolled value is, plus a lean towards what the app is about
 *   (sexuality and style over job and living situation - the bio work had the same lesson);
 * - no two from the same group, and a second intimate trait (in bed plus a kink) only when it
 *   is rare enough to beat the penalty - measured without it, 60% of cards were two thirds
 *   sex, which drowned the personality and style that make the choice interesting;
 * - a non-human species always makes it, since nothing else on the card would matter more -
 *   but only one that shows in any photo anyway. A species she can hide (a witch, a succubus,
 *   an angel) is hers to reveal, a bit of play the card must not spoil; the bio skips it too.
 *   Her big secret is never a candidate.
 * A small per-character jitter breaks ties the same way every time, so the card is stable.
 */

export interface CoreTrait {
  /** The discovery key this trait corresponds to (see discovery.ts). */
  key: string;
  /** What kind of thing it is, as a small caption: "Style", "In bed", "Into". */
  caption: string;
  label: string;
  /** Whether it is part of her intimate side, which the card reveals up front. */
  intimate: boolean;
}

interface Candidate extends CoreTrait {
  group: string;
  score: number;
}

/** How distinctive a rolled value is: 0 for common, rising with rarity. */
function distinct(category: string, id: string): number {
  const weight = RARITY_WEIGHT[find(category, id)?.rarity ?? 'common'] ?? 1;
  return -Math.log2(weight);
}

/** What a second intimate trait has to beat: about one rarity tier. */
const SECOND_INTIMATE_PENALTY = 1.3;

/** Statuses that say nothing on a card: she is single, or between things. */
const PLAIN_STATUS = new Set(['single', 'single_recently', 'newly_single', 'taking_a_break', 'separated', 'complicated']);

/** A stable 0-1 jitter per character and trait, so ties do not flip between loads. */
function jitter(seedKey: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedKey.length; i++) h = Math.imul(h ^ seedKey.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

export function coreTraits(seed: CharacterSeed, characterId: string): CoreTrait[] {
  const out: Candidate[] = [];
  const add = (group: string, caption: string, category: string, id: string | undefined, key: string, lean: number, intimate = false) => {
    const attr = id ? find(category, id) : undefined;
    if (!attr) return;
    out.push({ group, caption, label: attr.label, key, intimate, score: distinct(category, id!) + lean + jitter(characterId + key) * 0.6 });
  };

  if (seed.species && seed.species !== 'human' && (find('species', seed.species)?.extra?.visibility ?? 'profile') === 'profile') {
    add('identity', 'Species', 'species', seed.species, 'species', 100);
  }
  add('identity', 'Personality', 'archetype', seed.archetype, 'archetype', 1.0);
  add('look', 'Style', 'clothing_style', seed.clothing_style, 'style', 1.1);
  add('bed', 'In bed', 'sexual_persona', seed.sexual_persona, 'sexual_persona', 1.2, true);
  // Her first fetish is the signature one, always from a domain she is into (generator.ts).
  if (seed.fetishes?.[0]) add('kink', 'Into', 'fetish', seed.fetishes[0], `fetish:${seed.fetishes[0]}`, 1.0, true);
  add('life', 'Job', 'occupation', seed.occupation, 'occupation', 0);
  if (seed.relationship_status && !PLAIN_STATUS.has(seed.relationship_status)) {
    add('life', 'Status', 'relationship_status', seed.relationship_status, 'relationship_status', 0.4);
  }

  const picked: CoreTrait[] = [];
  const used = new Set<string>();
  while (picked.length < 3) {
    const hasIntimate = picked.some((p) => p.intimate);
    const next = out
      .filter((c) => !used.has(c.group))
      .map((c) => ({ c, s: c.score - (c.intimate && hasIntimate ? SECOND_INTIMATE_PENALTY : 0) }))
      .sort((a, b) => b.s - a.s)[0]?.c;
    if (!next) break;
    used.add(next.group);
    picked.push({ key: next.key, caption: next.caption, label: next.label, intimate: next.intimate });
  }
  return picked;
}
