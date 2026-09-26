import { find } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';
import { speciesRow, speciesVisibility } from './species.js';

/**
 * Fixed appearance block assembled from the image_prompt fields of the appearance tags: her
 * body, face, hair and what never comes off. What she is wearing is not in here any more - it
 * comes from her outfit for the shot (wardrobe.ts). The clothing style's one stock outfit line
 * used to sit in this block, so every photo of a goth started from "black clothing, chunky
 * boots", and a photo in pyjamas or in the shower had to fight it.
 */
export function buildAppearancePrompt(seed: CharacterSeed): string {
  const parts: string[] = [];
  const img = (cat: string, id: string) => find(cat, id)?.image_prompt;
  parts.push(`${seed.age} year old ${img('ethnicity', seed.ethnicity) ?? 'woman'}`);
  // A species with a permanent, unhideable tell (cat ears, a giant's actual scale, ...)
  // belongs in the fixed block like any other constant fact about her - see it early, since
  // it can dominate framing (a giantess or a fairy). A 'later'/'private'/'chat_only' species
  // is deliberately left out here: its tell is something she can conceal, or has none at all.
  // See blocks.ts's appearanceBlock() and images.ts's visibleMarks() for where those get
  // added only once she has actually chosen to reveal them.
  const species = speciesRow(seed);
  if (species?.image_prompt && speciesVisibility(seed) === 'profile') parts.push(species.image_prompt);
  for (const [cat, id] of [
    ['skin_tone', seed.skin_tone],
    ['height', seed.height],
    ['body_type', seed.body_type],
    ['breast_size', seed.breast_size],
    ['butt_size', seed.butt_size],
    ['hair_color', seed.hair_color],
    ['hair_style', seed.hair_style],
    ['eye_color', seed.eye_color],
    ['distinctive_feature', seed.distinctive_feature],
    ['makeup_style', seed.makeup_style],
    ['grooming', seed.grooming],
  ] as const) {
    const v = img(cat, id);
    if (v) parts.push(v);
  }
  // Accessories are a multi-select (glasses, jewellery, a bag she's holding...), unlike
  // every category above - rolled as an array rather than one id, and previously never
  // reached the image prompt at all, so a character who rolled glasses would never
  // actually be drawn wearing them.
  for (const accessoryId of seed.accessories) {
    const v = img('accessory', accessoryId);
    if (v) parts.push(v);
  }
  return parts.filter(Boolean).join(', ');
}
