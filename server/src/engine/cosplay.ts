import { byCategory, find, type Attribute } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';

/**
 * The cosplay reference table (cosplay_character): characters a cosplaying woman actually
 * dresses up as, each with the costume spelled out. Without it the model guessed - Tifa came
 * out in a generic "fighter outfit", 2B lost her blindfold - and a costume that is wrong is
 * worse than none, both in her texts and in the photo.
 *
 * Only a woman with a reason to cosplay gets a list of her own: `extra.cosplays` on her
 * persona, job, style, hobbies or fetishes says how many (the largest wins). Anyone can still
 * be asked to dress up as one; cosplayMentions() finds the character in the conversation or a
 * photo idea and hands over the same description.
 */

/** How many costumes she has, from whatever about her makes her a cosplayer. */
export function cosplayCount(seed: Partial<CharacterSeed>): number {
  const sources: [string, string | string[] | undefined][] = [
    ['sexual_persona', seed.sexual_persona],
    ['occupation', seed.occupation],
    ['clothing_style', seed.clothing_style],
    ['hobby', seed.hobbies],
    ['fetish', seed.fetishes],
  ];
  let n = 0;
  for (const [category, ids] of sources) {
    for (const id of [ids ?? []].flat()) n = Math.max(n, Number(find(category, id)?.extra?.cosplays ?? 0));
  }
  return n;
}

/** Her own costumes, in the order she rolled them. */
export function herCosplays(seed: Partial<CharacterSeed>): Attribute[] {
  return (seed.cosplays ?? []).map((id) => find('cosplay_character', id)).filter((a): a is Attribute => !!a);
}

/** One costume, as the model needs it: who, from what, the exact look, and how to play her. */
export function cosplayLine(row: Attribute): string {
  return `${row.label}. The costume: ${(row.image_prompt ?? '').replace(/^an? [^:]+ cosplay:\s*/i, '')}. Playing her: ${row.prompt_hint}.`;
}

/** For her own prompt (chat and dates). Empty when she has none. */
export function cosplayBlock(seed: Partial<CharacterSeed>): string {
  const rows = herCosplays(seed);
  if (!rows.length) return '';
  return [
    'Costumes you own and have worn (you know exactly how each one looks; bring one up when it fits):',
    ...rows.map((r) => `- ${cosplayLine(r)}`),
  ].join('\n');
}

let matchers: { row: Attribute; re: RegExp }[] | null = null;

/**
 * Every character named in a piece of text. Matches only the curated aliases and full
 * two-word names, on word boundaries: a bare "storm" or "mercy" is far more often the word
 * than the character, and pulling a costume into a photo of a rainy street is the failure.
 */
export function cosplayMentions(text: string): Attribute[] {
  if (!text) return [];
  if (!matchers) {
    matchers = byCategory('cosplay_character').map((row) => {
      const name = String(row.extra?.name ?? '');
      const terms = [...((row.extra?.aliases as string[]) ?? []), ...(name.includes(' ') ? [name] : [])]
        .map((t) => t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return { row, re: new RegExp(`(?<![a-z0-9])(${terms.join('|')})(?![a-z0-9])`, 'i') };
    });
  }
  return matchers.filter((m) => m.re.test(text)).map((m) => m.row);
}

/** For the image assembler: the costume exactly, on her own face and body. */
export function cosplayImageBlock(situation: string): string {
  const rows = cosplayMentions(situation);
  if (!rows.length) return '';
  return rows
    .map((r) => `${r.label}: ${r.image_prompt}.`)
    .join('\n');
}

/**
 * Per turn: characters named in the recent conversation that are not already in her own
 * list, so "come as Tifa" gets the real costume back instead of a guessed one.
 */
export function costumeMentionBlock(texts: string[], seed: Partial<CharacterSeed>): string {
  const own = new Set(seed.cosplays ?? []);
  const rows = cosplayMentions(texts.join('\n')).filter((r) => !own.has(r.id));
  if (!rows.length) return '';
  return rows.map((r) => `- ${cosplayLine(r)}`).join('\n');
}
