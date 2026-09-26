import { randomUUID } from 'node:crypto';
import { find, type Attribute } from '../db/attributes.js';
import { nowIso } from '../db/index.js';
import type { CharacterSeed, DateNpc, DuoPartner, UserProfile } from '../types.js';
import { newContext, pickOne, randInt, roll, type DiceContext } from './dice.js';
import { joinersFor } from './npcs.js';

/**
 * Duo profiles: two women sharing one profile - twins, a couple, best friends. She is still the
 * character (her seed, her chat, her dates); the other one is a card on her seed (duo_partner)
 * who can take the phone in chat and is at every date.
 *
 * The duo row says how they are with each other: `extra.together` is whether the two of them
 * are sexual with each other and share him. Twins are not, ever - they are sisters, and are
 * with him one at a time.
 */

export function duoRow(seed: Partial<CharacterSeed>): Attribute | null {
  if (!seed.duo || seed.duo === 'none') return null;
  return find('duo', seed.duo) ?? null;
}

/** The partner card, only when she really is half of a duo. */
export function duoPartner(seed: Partial<CharacterSeed>): DuoPartner | null {
  return duoRow(seed) && seed.duo_partner?.name ? seed.duo_partner : null;
}

export function duoTogether(seed: Partial<CharacterSeed>): boolean {
  return duoRow(seed)?.extra?.together === true;
}

/**
 * Which duo rows fit her and him. A partner is another woman in the picture, so a duo only
 * rolls when he wants women joining in; a couple who share him also needs neither of them to
 * be a no on a third, and her not to have it as a hard limit.
 */
export function allowedDuos(seed: Partial<CharacterSeed>, profile: UserProfile | null, all: Attribute[]): Set<string> {
  const joiners = joinersFor(profile);
  const womenOk = joiners === 'women' || joiners === 'anyone';
  const hers = seed.kink_map?.sharing;
  const sharingOk =
    hers !== 'hard_no' && hers !== 'soft_no' && !(seed.hard_limits ?? []).includes('third_parties') &&
    profile?.kink_map?.sharing !== 'hard_no';
  return new Set(
    all.filter((r) => r.id === 'none' || (womenOk && (r.extra?.together !== true || sharingOk))).map((r) => r.id),
  );
}

const PARTNER_NAMES = [
  'Mara', 'Lina', 'Sasha', 'Noor', 'Leah', 'Ivy', 'Kaia', 'Elena', 'Rin', 'Dana',
  'Maren', 'Selin', 'Tess', 'Aiko', 'Livia', 'Nell', 'Paz', 'Olga', 'Zara', 'Bea',
];

/**
 * Her partner's age and look, rolled here so the card never depends on the model: the
 * character pass only adds her name, manner and what she is up for, and falls back to these.
 * Twins are the same age and the same body; they are told apart by hair and style.
 */
export function rollPartnerBase(seed: CharacterSeed, row: Attribute, herName = ''): DuoPartner {
  const ctx: DiceContext = newContext();
  const text = (a: Attribute | null) => (a ? a.image_prompt || a.label.toLowerCase() : '');
  const name = pickOne(PARTNER_NAMES.filter((n) => n.toLowerCase() !== herName.toLowerCase()));
  const manner = find('archetype', roll('archetype', ctx, { ignoreArchetype: true })?.id ?? '')?.prompt_hint ?? '';
  if (row.extra?.same_look) {
    const hair = roll('hair_style', ctx, { exclude: new Set([seed.hair_style]), ignoreArchetype: true });
    const style = roll('clothing_style', ctx, { exclude: new Set([seed.clothing_style]), ignoreArchetype: true });
    return {
      name,
      age: seed.age,
      look: `her identical twin - the same face, body and colouring as her sister; told apart by her ${text(hair)} and her ${text(style)}`,
      manner,
      up_for: '',
    };
  }
  const parts = ['ethnicity', 'height', 'body_type', 'hair_color', 'hair_style', 'clothing_style']
    .map((c) => text(roll(c, ctx, { ignoreArchetype: true })))
    .filter(Boolean);
  // Close to her age, never under 18.
  const age = Math.max(18, seed.age + randInt(-4, 6));
  return { name, age, look: parts.join(', '), manner, up_for: '' };
}

/** Who she is to her, in two words: "her twin sister", "her wife". */
export function partnerRelation(seed: Partial<CharacterSeed>): string {
  return (duoRow(seed)?.label ?? '').replace(/^with /i, '');
}

/** For her own prompt: the other woman on the profile and how the two of them work. */
export function duoLines(seed: CharacterSeed): string[] {
  const row = duoRow(seed);
  const p = duoPartner(seed);
  if (!row || !p) return [];
  return [
    `You share this profile with ${p.name}, ${partnerRelation(seed)} (${p.age}). He knows: it says so on the profile. ${row.prompt_hint}`,
    `${p.name}: ${p.manner}${p.up_for ? ` What she wants with him: ${p.up_for}` : ''} Looks: ${p.look}.`,
  ];
}

/** For the chat prompt: how she takes the phone. Empty for everyone else. */
export function duoChatNote(seed: CharacterSeed): string {
  const p = duoPartner(seed);
  if (!p) return '';
  return (
    `${p.name} is often around when you text and sometimes takes the phone. A message she writes ` +
    `herself gets "from": "${p.name}" and sounds like her, not like you; leave "from" out for your own. ` +
    `Not every turn - she is around, not glued to the phone.`
  );
}

/** For the dossier. */
export function duoDossierLines(seed: CharacterSeed): string[] {
  const p = duoPartner(seed);
  const row = duoRow(seed);
  if (!row) return [];
  return [
    `duo: ${row.label} - ${row.prompt_hint} (on the profile, he knows)`,
    ...(p ? [`her partner on the profile: ${p.name}, ${p.age} - ${p.look}. ${p.manner} ${p.up_for}`.trim()] : []),
  ];
}

/**
 * A duo row can pin her relationship status (`extra.relationship_status`): a woman on a profile
 * with her wife is married, whatever was rolled earlier or swapped in by the character pass.
 * Returns true when it changed anything.
 */
export function enforceDuoStatus(seed: CharacterSeed): boolean {
  const allowed = duoRow(seed)?.extra?.relationship_status as string[] | undefined;
  if (!allowed?.length || allowed.includes(seed.relationship_status)) return false;
  const to = find('relationship_status', pickOne(allowed));
  if (!to) return false;
  seed.relationship_status = to.id;
  seed.hints.relationship_status = to.prompt_hint || to.label;
  return true;
}

/**
 * Her partner as a card on a date (npcs.ts): she comes along to every one, because the profile
 * he matched was the two of them. A twin is there for the evening and never for the sex; a
 * couple or best friends are there for all of it.
 */
export function duoPartnerNpc(seed: CharacterSeed): DateNpc | null {
  const p = duoPartner(seed);
  if (!p) return null;
  const together = duoTogether(seed);
  return {
    id: randomUUID(),
    name: p.name,
    gender: 'woman',
    count: 1,
    age: Math.max(18, p.age),
    who: `${partnerRelation(seed)}, who shares the profile with her and came along`,
    look: p.look,
    manner: p.manner,
    up_for: together
      ? p.up_for || 'everything the two of them want with him, and with each other'
      : 'the evening, not the sex: she is her sister, and when things head there she finds somewhere else to be',
    // 'scene', not 'invite': he did not ask for her, and an unanswered invite request keys off 'invite'.
    source: 'scene',
    joined_at: nowIso(),
    left_at: null,
    joined_in: null,
    left_in: null,
  };
}

/**
 * For the image assembler: her partner's look, when the photo idea names her. Never in a spicy
 * photo of a twin: sisters are not in a sexual picture together.
 */
export function duoImageBlock(seed: CharacterSeed, situation: string, spicy = false): string {
  const p = duoPartner(seed);
  if (!p || (spicy && !duoTogether(seed))) return '';
  const named = new RegExp(`(?<![a-z])${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i');
  if (!named.test(situation) && !/\b(both of us|the two of us|with my (sister|twin|girlfriend|wife|best friend|bestie))\b/i.test(situation)) return '';
  return `${p.name}, ${partnerRelation(seed)} (${p.age}), is in this photo too: ${p.look}. She is a different woman from the fixed block above - give her her own look exactly as written here, and keep the two of them distinct.`;
}
