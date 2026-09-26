import { find, type Attribute } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';

/**
 * What she is, and who can see it - one place for every reader, because "is this on her
 * profile or hers to reveal" used to be decided separately in seven files.
 *
 * Species rows cover two kinds of not-quite-ordinary woman:
 * - fantastical beings (a catgirl, a vampire), whose own row says how visible they are;
 * - superpowers (`extra.kind: 'power'`), where the row is the power and her hero role
 *   (hero_role table) says how visible it is: a public hero is on her profile, a secret
 *   identity is hers to reveal. Powers reuse everything species already has - rarity, the
 *   visibility tiers, image tells, kink weights, the handle and bio leak guards.
 */

export type Visibility = 'profile' | 'later' | 'private' | 'chat_only';

/** Her species row, or null for an ordinary human. */
export function speciesRow(seed: CharacterSeed): Attribute | null {
  if (!seed.species || seed.species === 'human') return null;
  return find('species', seed.species) ?? null;
}

/** She is an AI inside the fiction (`extra.ai`), so talking about being one is her, not a refusal. */
export function isAiCharacter(seed: CharacterSeed): boolean {
  return speciesRow(seed)?.extra?.ai === true;
}

export function isPower(seed: CharacterSeed): boolean {
  return speciesRow(seed)?.extra?.kind === 'power';
}

/** Her hero role, only ever set alongside a power. */
export function heroRoleRow(seed: CharacterSeed): Attribute | null {
  return isPower(seed) && seed.hero_role ? find('hero_role', seed.hero_role) ?? null : null;
}

/** How visible her species or power is; null for a human. */
export function speciesVisibility(seed: CharacterSeed): Visibility | null {
  const row = speciesRow(seed);
  if (!row) return null;
  const own = (row.extra?.kind === 'power' ? heroRoleRow(seed)?.extra?.visibility : row.extra?.visibility) as Visibility | undefined;
  return own ?? 'profile';
}

/** Hidden day to day: hers to reveal, so nothing he sees before then may name it. */
export function speciesHidden(seed: CharacterSeed): boolean {
  const vis = speciesVisibility(seed);
  return !!vis && vis !== 'profile';
}

/** What to call the field on a card or a profile row. */
export function speciesCaption(seed: CharacterSeed): string {
  return isPower(seed) ? 'Superpower' : 'Species';
}

/** Her trans row, or null for a cis woman (and for anyone generated before the table existed). */
export function transRow(seed: CharacterSeed): Attribute | null {
  if (!seed.transgender || seed.transgender === 'cis_woman') return null;
  return find('transgender', seed.transgender) ?? null;
}

/**
 * Whether a row's body restriction fits her (`extra.body`: the transgender ids it is for).
 * Unset means anyone. Characters from before the table read as cis.
 */
export function bodyFits(row: Attribute | undefined, seed: { transgender?: string }): boolean {
  const allowed = row?.extra?.body as string[] | undefined;
  return !allowed?.length || allowed.includes(seed.transgender ?? 'cis_woman');
}

/** Whether a row's species restriction fits her (`extra.species`). Unset means anyone. */
export function speciesFits(row: Attribute | undefined, speciesId: string | undefined): boolean {
  const allowed = row?.extra?.species as string[] | undefined;
  return !allowed?.length || allowed.includes(speciesId ?? 'human');
}

/**
 * Every restriction a kink or scenario row can carry, in one check: `extra.species`,
 * `extra.body`, and `extra.requires` - `{ seed field: [ids] }`, e.g. `{ double_life: ['spy'] }`
 * for "an interrogation that goes somewhere else". A missing field reads as 'none'.
 */
export function fitsHer(row: Attribute | undefined, seed: Partial<CharacterSeed>): boolean {
  if (!speciesFits(row, seed.species) || !bodyFits(row, seed)) return false;
  const requires = row?.extra?.requires as Record<string, string[]> | undefined;
  if (!requires) return true;
  return Object.entries(requires).every(([field, ids]) => ids.includes(String((seed as any)[field] ?? 'none')));
}
