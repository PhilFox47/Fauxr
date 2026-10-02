import { find } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';
import { speciesRow, speciesVisibility } from './species.js';

const img = (cat: string, id: string | undefined): string | undefined => id ? find(cat, id)?.image_prompt ?? undefined : undefined;

function speciesPrompt(seed: CharacterSeed): string | undefined {
  // A species with a permanent, unhideable tell (cat ears, a giant's actual scale, ...)
  // belongs in the fixed block like any other constant fact about her - see it early, since
  // it can dominate framing (a giantess or a fairy). A 'later'/'private'/'chat_only' species
  // is deliberately left out here: its tell is something she can conceal, or has none at all.
  // See blocks.ts's appearanceBlock() and images.ts's visibleMarks() for where those get
  // added only once she has actually chosen to reveal them.
  const species = speciesRow(seed);
  return species?.image_prompt && speciesVisibility(seed) === 'profile' ? species.image_prompt : undefined;
}

/** A non-human body needs its own physically real surface, not the human-skin fallback. */
export function speciesMaterialPrompt(seed: CharacterSeed): string | undefined {
  const species = speciesRow(seed);
  if (!species || speciesVisibility(seed) !== 'profile') return undefined;
  const material = String(species.extra?.image_material ?? '').trim();
  return material || undefined;
}

function join(label: string, values: Array<string | undefined>): string {
  const body = values.filter(Boolean).join(', ');
  return body ? `${label}: ${body}` : '';
}

/** The compact, permanent face description that every face-visible shot repeats. */
export function buildVisualIdentityPrompt(seed: CharacterSeed, includeHair = true): string {
  const replacesSkin = speciesRow(seed)?.extra?.image_replaces_skin === true;
  return join('Identity', [
    `${seed.age} year old ${img('ethnicity', seed.ethnicity) ?? 'woman'}`,
    speciesPrompt(seed), replacesSkin ? undefined : img('skin_tone', seed.skin_tone), img('face_shape', seed.face_shape),
    img('facial_structure', seed.facial_structure), img('eye_shape', seed.eye_shape),
    img('eye_spacing', seed.eye_spacing), img('eye_color', seed.eye_color),
    img('nose_shape', seed.nose_shape), img('mouth_shape', seed.mouth_shape),
    img('brow_shape', seed.brow_shape), includeHair ? img('hair_color', seed.hair_color) : undefined,
    includeHair ? img('hair_style', seed.hair_style) : undefined, img('distinctive_feature', seed.distinctive_feature),
    img('facial_detail', seed.facial_detail),
  ]);
}

/**
 * Compact textual likeness anchor for models without reference-image support.
 *
 * Calling her the "same recurring woman" gives a stateless image model a relationship it
 * cannot resolve, while copying the entire attribute inventory crowds the actual photograph
 * out of Z-Image's small prompt budget. Keep only the strongest visible anchors here; the
 * full appearance block remains available to the assembler when it decides what the crop sees.
 */
export function buildFacePassport(seed: CharacterSeed, includeHair = true): string {
  const replacesSkin = speciesRow(seed)?.extra?.image_replaces_skin === true;
  const subject = `${seed.age} year old ${img('ethnicity', seed.ethnicity) ?? 'woman'}`;
  const traits = [
    speciesPrompt(seed),
    replacesSkin ? undefined : img('skin_tone', seed.skin_tone),
    img('face_shape', seed.face_shape),
    img('eye_shape', seed.eye_shape),
    img('eye_color', seed.eye_color),
    img('nose_shape', seed.nose_shape),
    img('mouth_shape', seed.mouth_shape),
    includeHair ? img('hair_color', seed.hair_color) : undefined,
    includeHair ? img('hair_style', seed.hair_style) : undefined,
  ].filter(Boolean);
  return `The woman in this image is a ${subject}${traits.length ? ` with ${traits.join(', ')}` : ''}.`;
}

export function buildBodyPrompt(seed: CharacterSeed): string {
  return join('Build', [
    img('height', seed.height), img('body_type', seed.body_type), img('breast_size', seed.breast_size),
    img('butt_size', seed.butt_size), img('grooming', seed.grooming),
  ]);
}

export function buildDefaultStylingPrompt(seed: CharacterSeed, faceOnly = false): string {
  const values = [img('makeup_style', seed.makeup_style), img('visual_palette', seed.visual_palette)];
  // Accessories are a multi-select (glasses, jewellery, a bag she's holding...), unlike
  // every category above - rolled as an array rather than one id, and previously never
  // reached the image prompt at all, so a character who rolled glasses would never
  // actually be drawn wearing them.
  for (const accessoryId of seed.accessories ?? []) {
    if (faceOnly && !['glasses', 'reading_glasses', 'tinted_glasses'].includes(accessoryId)) continue;
    values.push(img('accessory', accessoryId));
  }
  return join('Usual styling', values);
}

export type AppearanceFraming = 'face' | 'upper' | 'full' | 'body';

/** Persist the exact attribute anchors, so later prompt refactors cannot silently redesign her. */
export function buildVisualCore(seed: CharacterSeed): NonNullable<CharacterSeed['visual_core']> {
  const fields: Array<[string, string | undefined]> = [
    ['ethnicity', seed.ethnicity], ['skin_tone', seed.skin_tone], ['face_shape', seed.face_shape],
    ['facial_structure', seed.facial_structure], ['eye_shape', seed.eye_shape], ['eye_spacing', seed.eye_spacing],
    ['eye_color', seed.eye_color], ['nose_shape', seed.nose_shape], ['mouth_shape', seed.mouth_shape],
    ['brow_shape', seed.brow_shape], ['hair_color', seed.hair_color], ['hair_style', seed.hair_style],
    ['distinctive_feature', seed.distinctive_feature], ['facial_detail', seed.facial_detail],
  ];
  const anchors = fields.flatMap(([category, id]) => id ? [{ category, id }] : []);
  return {
    version: 1,
    anchors,
    ...(seed.visual_palette ? { palette: { category: 'visual_palette', id: seed.visual_palette } } : {}),
  };
}

/** Only send the image model details the camera can plausibly see. */
export function appearanceForShot(seed: CharacterSeed, framing: AppearanceFraming, includeHair = true): string {
  if (framing === 'face') return [buildVisualIdentityPrompt(seed, includeHair), buildDefaultStylingPrompt(seed, true)].filter(Boolean).join('; ');
  if (framing === 'body') return [
    join('Identity', [`${seed.age} year old ${img('ethnicity', seed.ethnicity) ?? 'woman'}`, speciesPrompt(seed), speciesRow(seed)?.extra?.image_replaces_skin === true ? undefined : img('skin_tone', seed.skin_tone), includeHair ? img('hair_color', seed.hair_color) : undefined]),
    buildBodyPrompt(seed), buildDefaultStylingPrompt(seed),
  ].filter(Boolean).join('; ');
  if (framing === 'upper') return [
    buildVisualIdentityPrompt(seed, includeHair),
    join('Build', [img('body_type', seed.body_type), img('breast_size', seed.breast_size)]),
    buildDefaultStylingPrompt(seed),
  ].filter(Boolean).join('; ');
  return [buildVisualIdentityPrompt(seed, includeHair), buildBodyPrompt(seed), buildDefaultStylingPrompt(seed)].filter(Boolean).join('; ');
}

/** Full compatibility form used by dossiers and non-image prompts. */
export function buildAppearancePrompt(seed: CharacterSeed): string {
  return appearanceForShot(seed, 'full');
}
