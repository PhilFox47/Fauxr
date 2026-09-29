import { byCategory, type Attribute } from '../db/attributes.js';
import { roll, type DiceContext } from './dice.js';

/**
 * Height is normally a human-scale roll. A species with dedicated rows replaces that pool
 * entirely: a palm-sized fairy must never also be "1.65-1.70m", and a giantess needs more
 * information than the old open-ended "1.80m+" bucket supplied.
 *
 * The relationship lives in attribute data (`extra.species`), not an id switch here, so a
 * future species can define its scale by adding rows without changing generation code.
 */
export function heightRowsForSpecies(speciesId: string | undefined): Attribute[] {
  const rows = byCategory('height');
  const dedicated = rows.filter((row) =>
    Array.isArray(row.extra?.species) && row.extra.species.includes(speciesId),
  );
  return dedicated.length
    ? dedicated
    : rows.filter((row) => !Array.isArray(row.extra?.species) || row.extra.species.length === 0);
}

export function rollHeight(speciesId: string | undefined, ctx: DiceContext): Attribute | null {
  return roll('height', ctx, { only: new Set(heightRowsForSpecies(speciesId).map((row) => row.id)) });
}

export function heightFitsSpecies(heightId: string | undefined, speciesId: string | undefined): boolean {
  return !!heightId && heightRowsForSpecies(speciesId).some((row) => row.id === heightId);
}
