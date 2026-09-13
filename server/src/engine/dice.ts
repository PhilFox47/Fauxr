import { byCategory, RARITY_WEIGHT, type Attribute } from '../db/attributes.js';
import { getSettings } from '../config.js';

export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function pickOne<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Draw a count from a discrete distribution, e.g. [0.6, 0.25, 0.1, 0.05] -> 0..3. */
export function drawCount(distribution: number[] | undefined, fallback = 1): number {
  if (!distribution || distribution.length === 0) return fallback;
  const total = distribution.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < distribution.length; i++) {
    roll -= distribution[i];
    if (roll <= 0) return i;
  }
  return distribution.length - 1;
}

export interface DiceContext {
  /** Per-attribute-id multipliers contributed by the archetype. */
  weights: Record<string, number>;
  /** Ids already drawn; used for affinity boosts and conflict filtering. */
  drawn: Set<string>;
}

export function newContext(): DiceContext {
  return { weights: {}, drawn: new Set() };
}

const AFFINITY_BOOST = 2.5;

function rarityWeight(a: Attribute): number {
  const base = RARITY_WEIGHT[a.rarity] ?? 1;
  if (base >= 1) return base;
  // The bias dial pulls the whole rare tail up or down together: at 2 a very rare tag is
  // about four times as likely as at 1, at 0.5 it all but disappears.
  const bias = Math.max(0.1, Math.min(3, getSettings().rarity_bias));
  return Math.pow(base, 1 / bias);
}

function effectiveWeight(a: Attribute, ctx: DiceContext): number {
  let w = a.weight * rarityWeight(a) * (ctx.weights[a.id] ?? 1);
  // Affinity works both ways: an already-drawn tag that lists this one, or vice versa.
  for (const id of ctx.drawn) {
    if (a.affinities.includes(id)) w *= AFFINITY_BOOST;
  }
  if (a.affinities.some((x) => ctx.drawn.has(x))) w *= 1; // already counted above
  return w;
}

export interface RollOptions {
  /** Ignore the archetype weight overrides - used for the deliberately surprising fields. */
  ignoreArchetype?: boolean;
  exclude?: Set<string>;
  /** Restrict the draw to these ids, for tags that only make sense in combination. */
  only?: Set<string>;
  /** Do not register the result in ctx.drawn (used for throwaway sub-rolls). */
  transient?: boolean;
}

export function roll(category: string, ctx: DiceContext, opts: RollOptions = {}): Attribute | null {
  const pool = byCategory(category).filter((a) => {
    if (opts.only && !opts.only.has(a.id)) return false;
    if (opts.exclude?.has(a.id)) return false;
    if (a.conflicts.some((c) => ctx.drawn.has(c))) return false;
    return true;
  });
  if (pool.length === 0) return null;

  const weights = pool.map((a) =>
    // Rarity always applies; only the archetype's own re-weighting is skipped.
    opts.ignoreArchetype
      ? Math.max(a.weight * rarityWeight(a), 0.0001)
      : Math.max(effectiveWeight(a, ctx), 0.0001),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let chosen = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      chosen = pool[i];
      break;
    }
  }
  if (!opts.transient) {
    ctx.drawn.add(chosen.id);
    for (const aff of chosen.affinities) {
      ctx.weights[aff] = (ctx.weights[aff] ?? 1) * 1.8;
    }
  }
  return chosen;
}

export function rollMany(
  category: string,
  ctx: DiceContext,
  count: number,
  opts: RollOptions = {},
): Attribute[] {
  const out: Attribute[] = [];
  const exclude = new Set(opts.exclude ?? []);
  for (let i = 0; i < count; i++) {
    const a = roll(category, ctx, { ...opts, exclude });
    if (!a) break;
    exclude.add(a.id);
    out.push(a);
  }
  return out;
}

/** Clamp a roll into an archetype-provided range, falling back to the full range. */
export function rollRange(range: number[] | undefined, min: number, max: number): number {
  const lo = range?.[0] ?? min;
  const hi = range?.[1] ?? max;
  return randInt(Math.max(min, lo), Math.min(max, hi));
}
