import { find, type Attribute } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';

/**
 * Layers: rare things that can be true of any woman on top of everything else - a double life,
 * having come here from another time, a curse. They combine with each other and with species,
 * powers and gender, which is the point: a vampire who is secretly a spy, a trans woman from
 * 1925. One definition drives every reader (prompts, card, profile sheet, dossier, leak guards,
 * Taste) so a new layer is a table plus one line here.
 *
 * Each table has a 'none' row carrying almost all the weight. A row's extra.visibility is
 * 'profile' (on her profile, he knows) or 'later' (hers to reveal; the default); extra.voice,
 * when set, is a line about how it changes the way she texts.
 */

export type LayerField = 'double_life' | 'era' | 'curse';

export interface LayerDef {
  field: LayerField;
  /** What a card or profile row calls it. */
  caption: string;
  /** Whether a woman with a superpower can also roll it (her hero role already is a double life). */
  withPower: boolean;
}

export const LAYERS: LayerDef[] = [
  { field: 'double_life', caption: 'Double life', withPower: false },
  { field: 'era', caption: 'From', withPower: true },
  { field: 'curse', caption: 'Curse', withPower: true },
];

/** Her row for this layer, or null for 'none' (and for anyone generated before it existed). */
export function layerRow(seed: Partial<CharacterSeed>, field: LayerField): Attribute | null {
  const id = seed[field];
  if (!id || id === 'none') return null;
  return find(field, id) ?? null;
}

export function layerVisible(row: Attribute): boolean {
  return row.extra?.visibility === 'profile';
}

/** Every layer she has, with its definition. */
export function herLayers(seed: Partial<CharacterSeed>): { def: LayerDef; row: Attribute }[] {
  return LAYERS.map((def) => ({ def, row: layerRow(seed, def.field) })).filter((l): l is { def: LayerDef; row: Attribute } => !!l.row);
}

/** For her own prompt: each layer as a fact she lives with, and whether he knows. */
export function layerLines(seed: CharacterSeed): string[] {
  return herLayers(seed).map(({ def, row }) =>
    layerVisible(row)
      ? `${def.caption}: ${row.label}. It is on your profile, so he knows. ${row.prompt_hint}`
      : `${def.caption}: ${row.label} - almost nobody knows. When and how you let him in on it is up to you: ` +
        `a slip, a confession, part of a fantasy. Never deny it if he asks outright. ${row.prompt_hint}`,
  );
}

/** How her layers change the way she texts (extra.voice), for the communication block. */
export function layerVoiceLines(seed: CharacterSeed): string[] {
  return herLayers(seed).map(({ row }) => row.extra?.voice as string | undefined).filter((v): v is string => !!v);
}

/** For the dossier: every layer, marked visible or hidden. */
export function layerDossierLines(seed: CharacterSeed): string[] {
  return herLayers(seed).map(({ def, row }) =>
    `${def.caption.toLowerCase()}: ${row.label} - ${row.prompt_hint} ` +
      (layerVisible(row) ? '(on her profile, he knows)' : '(hidden: hers to reveal, never in the bio or handle)'));
}

/** Labels of the layers he must not be able to read off her bio or handle. */
export function hiddenLayerLabels(seed: CharacterSeed): string[] {
  return herLayers(seed).filter(({ row }) => !layerVisible(row)).map(({ row }) => row.label);
}

/** The telling word of a label, for catching it in a handle ("Off-duty assassin" -> "assassin"). */
export function tellingWord(label: string): string {
  return label.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0] ?? '';
}
