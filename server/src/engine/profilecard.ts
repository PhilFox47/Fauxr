import { randomUUID } from 'node:crypto';
import { find } from '../db/attributes.js';
import type { CharacterSeed, CoreEntry } from '../types.js';

/**
 * Her core: the three to five things that define her - "Kristina is a girl who is a tsundere,
 * lives in pantyhose and works as a scientist".
 *
 * They are printed on her swipe card, and they are what she is built around in every prompt
 * (coreBlock in blocks.ts): what she brings up, what colours how she flirts, what he remembers
 * her by. Everything else in her seed is true and available but is flavour. Before this every
 * character tended her whole attribute list evenly, so every chat circled the same spread -
 * above all her job, which the prompts named on every turn - and nobody stood out.
 *
 * For that to make the cast varied, the cores themselves have to vary, so the candidates are
 * broad: a visible species, personality, humour, how she texts, how she talks dirty, style,
 * what she is proudest of, who she is in bed, her signature move, one or two of her kinks, her
 * job, her relationship status and her main hobby. One woman is two kinks and her personality;
 * the next is her style, her job and how she flirts.
 * - Each candidate scores by how rare the rolled value is (softened, so one extremely rare
 *   kink does not win every time), a per-category lean, and a random jitter large enough that
 *   two similar women still come out with different cores.
 * - Three to five of them (coreCount): some women are three things, some need five. Ranked,
 *   so the first two are what she is above all and the rest support them.
 * - One per group, except kinks, which can take two slots. At most two intimate traits (three
 *   in a core of five), and each one past the first has to beat a penalty - most cores are one
 *   part sex, two parts person.
 * - A species that shows in any photo always makes it. One she can hide (a witch, a succubus,
 *   an angel) is hers to reveal and never does; neither does her big secret.
 * Picked once at generation and stored (seed.core); existing characters get theirs on first
 * load (repo.ts), with a jitter keyed on their id so it is the same every time.
 */

export interface CoreTrait extends CoreEntry {
  label: string;
  /** The attribute's own description, for prompts. */
  hint: string;
  /** Part of her intimate side, which the card reveals up front (see matching.ts). */
  intimate: boolean;
}

/** Softened rarity: enough to prefer the unusual, not enough to always crown the rarest roll. */
const RARITY_SCORE: Record<string, number> = { common: 0, uncommon: 0.8, rare: 1.4, very_rare: 1.9, extremely_rare: 2.3 };
/** How much a random roll moves each candidate; large on purpose, see above. */
const JITTER = 2.2;
/** What a second intimate trait has to beat. */
const SECOND_INTIMATE_PENALTY = 0.35;

/** Statuses that say nothing on a card: she is single, or between things. */
const PLAIN_STATUS = new Set(['single', 'single_recently', 'newly_single', 'taking_a_break', 'separated', 'complicated']);

const INTIMATE = new Set(['dirty_talk', 'sexual_persona', 'signature_move', 'fetish']);

interface Candidate { entry: CoreEntry; group: string; intimate: boolean; score: number }

/** A 0-1 number from a string: stable for a stored character, fresh for a new one. */
function unit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

interface Option { category: string; id?: string; key: string; caption: string; group: string; lean: number; force?: boolean }

function options(seed: CharacterSeed): Option[] {
  const species = seed.species && seed.species !== 'human' ? find('species', seed.species) : undefined;
  return [
    ...(species && (species.extra?.visibility ?? 'profile') === 'profile'
      ? [{ category: 'species', id: seed.species, key: 'species', caption: 'Species', group: 'identity', lean: 0, force: true }]
      : []),
    { category: 'archetype', id: seed.archetype, key: 'archetype', caption: 'Personality', group: 'identity', lean: 0.55 },
    { category: 'humor_type', id: seed.humor_type, key: 'humor_type', caption: 'Humour', group: 'voice', lean: 0.35 },
    { category: 'texting_persona', id: seed.texting_persona, key: 'texting_persona', caption: 'Texts like', group: 'voice', lean: 0.5 },
    { category: 'dirty_talk', id: seed.dirty_talk, key: 'dirty_talk', caption: 'Talks dirty', group: 'voice', lean: 0.8 },
    { category: 'clothing_style', id: seed.clothing_style, key: 'style', caption: 'Style', group: 'look', lean: 0.55 },
    { category: 'body_pride', id: seed.body_pride, key: 'body_pride', caption: 'Proudest of', group: 'look', lean: 0.5 },
    { category: 'sexual_persona', id: seed.sexual_persona, key: 'sexual_persona', caption: 'In bed', group: 'bed', lean: 0.6 },
    { category: 'signature_move', id: seed.signature_move, key: 'signature_move', caption: 'Her move', group: 'bed', lean: 0.4 },
    ...(seed.fetishes ?? []).slice(0, 2).map((f, i) => ({
      category: 'fetish', id: f, key: `fetish:${f}`, caption: 'Into', group: 'kink', lean: i === 0 ? 0.6 : 0.45,
    })),
    { category: 'occupation', id: seed.occupation, key: 'occupation', caption: 'Job', group: 'life', lean: 0.25 },
    ...(seed.relationship_status && !PLAIN_STATUS.has(seed.relationship_status)
      ? [{ category: 'relationship_status', id: seed.relationship_status, key: 'relationship_status', caption: 'Relationship', group: 'life', lean: 0.3 }]
      : []),
    ...(seed.hobbies?.[0] ? [{ category: 'hobby', id: seed.hobbies[0], key: `hobby:${seed.hobbies[0]}`, caption: 'Lives for', group: 'life', lean: 0.2 }] : []),
  ];
}

/** How many traits define her: 3 for a quarter, 4 for nearly half, 5 for the rest. */
export function coreCount(key: string): number {
  const u = unit(key + ':count');
  return u < 0.25 ? 3 : u < 0.7 ? 4 : 5;
}

/**
 * Choose her core. `jitterKey` is her id for a stored character, anything random for a new
 * one. `start` keeps a core she already has and only adds to it - a character from the
 * three-trait days keeps her three and grows to her count.
 */
export function pickCore(seed: CharacterSeed, jitterKey: string = randomUUID(), start: CoreEntry[] = []): CoreEntry[] {
  const count = coreCount(jitterKey);
  const maxIntimate = count >= 5 ? 3 : 2;
  const pool: Candidate[] = [];
  for (const o of options(seed)) {
    const attr = o.id ? find(o.category, o.id) : undefined;
    if (!attr) continue;
    const score = o.force ? 100 : (RARITY_SCORE[attr.rarity ?? 'common'] ?? 0) + o.lean + unit(jitterKey + o.key) * JITTER;
    pool.push({ entry: { category: o.category, id: o.id!, key: o.key, caption: o.caption }, group: o.group, intimate: INTIMATE.has(o.category), score });
  }
  const picked: Candidate[] = [];
  const perGroup: Record<string, number> = {};
  for (const e of start) {
    const c = pool.find((p) => p.entry.key === e.key);
    if (!c || picked.includes(c)) continue;
    picked.push(c);
    perGroup[c.group] = (perGroup[c.group] ?? 0) + 1;
  }
  while (picked.length < count) {
    const intimate = picked.filter((p) => p.intimate).length;
    const next = pool
      .filter((c) => !picked.includes(c))
      .filter((c) => (perGroup[c.group] ?? 0) < (c.group === 'kink' ? 2 : 1))
      .filter((c) => !(c.intimate && intimate >= maxIntimate))
      .map((c) => ({ c, s: c.score - (c.intimate && intimate >= 1 ? SECOND_INTIMATE_PENALTY * intimate : 0) }))
      .sort((a, b) => b.s - a.s)[0]?.c;
    if (!next) break;
    picked.push(next);
    perGroup[next.group] = (perGroup[next.group] ?? 0) + 1;
  }
  return picked.map((p) => p.entry);
}

/** Her core as displayable, prompt-ready traits: the stored one, or picked now for an old seed. */
export function coreTraits(seed: CharacterSeed, characterId: string): CoreTrait[] {
  const entries = seed.core?.length ? seed.core : pickCore(seed, characterId);
  return entries
    .map((e) => {
      const attr = find(e.category, e.id);
      if (!attr) return null;
      // Stored cores from before the rename still say "Status", which now reads as her WhatsApp
      // status sitting right under it in her profile.
      const caption = e.category === 'relationship_status' ? 'Relationship' : e.caption;
      return { ...e, caption, label: attr.label, hint: attr.prompt_hint || attr.label, intimate: INTIMATE.has(e.category) };
    })
    .filter((t): t is CoreTrait => !!t);
}

/** Whether one of her fields is part of her core - her job, say. */
export function isCore(seed: CharacterSeed, category: string): boolean {
  return (seed.core ?? []).some((e) => e.category === category);
}
