import { byCategory, find } from '../db/attributes.js';
import type { UserCard, UserProfile } from '../types.js';

/**
 * His own character card, built from exactly the same attribute tables the generated
 * characters are built from - so whatever he picks, a character already has the vocabulary
 * to talk about it.
 *
 * Only the fields that mean something for a person who types his own messages are here.
 * Typing style, message length, response speed and the rest of the communication block are
 * machinery for driving the Actor's voice; he has a voice of his own, so they would be
 * filled in and then never used.
 */

export interface CardField {
  key: keyof UserCard;
  /** Attribute category the options come from. */
  category: string;
  label: string;
  /** Multi-select fields store an array of ids. */
  multi?: boolean;
  max?: number;
}

export interface CardSection {
  id: 'looks' | 'life' | 'interests' | 'wants' | 'intimate';
  label: string;
  /** Said on the editor, so it is obvious who gets to see what. */
  note: string;
  fields: CardField[];
}

export const CARD_SECTIONS: CardSection[] = [
  {
    id: 'looks',
    label: 'What you look like',
    note: 'Seen by a character once the two of you have swapped profile pictures.',
    fields: [
      { key: 'ethnicity', category: 'ethnicity', label: 'Background' },
      { key: 'skin_tone', category: 'skin_tone', label: 'Skin tone' },
      { key: 'height', category: 'height', label: 'Height' },
      { key: 'body_type', category: 'body_type', label: 'Build' },
      { key: 'hair_color', category: 'hair_color', label: 'Hair colour' },
      { key: 'hair_style', category: 'hair_style', label: 'Hair' },
      { key: 'eye_color', category: 'eye_color', label: 'Eyes' },
      { key: 'clothing_style', category: 'clothing_style', label: 'How you dress' },
      { key: 'grooming', category: 'grooming', label: 'Grooming' },
      { key: 'distinctive_feature', category: 'distinctive_feature', label: 'Distinctive' },
      { key: 'accessories', category: 'accessory', label: 'Usually wearing', multi: true, max: 4 },
    ],
  },
  {
    id: 'life',
    label: 'Your life',
    note: 'On your profile. Characters know this, the way they would having read it.',
    fields: [
      { key: 'occupation', category: 'occupation', label: 'Work' },
      { key: 'living_situation', category: 'living_situation', label: 'Living' },
      { key: 'relationship_status', category: 'relationship_status', label: 'Status' },
      { key: 'social_energy', category: 'social_energy', label: 'Social battery' },
      { key: 'languages', category: 'language', label: 'Languages besides English', multi: true, max: 4 },
    ],
  },
  {
    id: 'interests',
    label: 'What you are into',
    note: 'On your profile. This is what someone actually has to talk to you about.',
    fields: [
      { key: 'interests', category: 'interest', label: 'Into', multi: true, max: 6 },
      { key: 'hobbies', category: 'hobby', label: 'You spend time on', multi: true, max: 5 },
      { key: 'humor_type', category: 'humor_type', label: 'Your humour' },
    ],
  },
  {
    id: 'wants',
    label: 'What you want',
    note: 'What you are here for, and what does and does not do it for you.',
    fields: [
      { key: 'search_motive', category: 'search_motive', label: 'Why you are here' },
      { key: 'turn_ons', category: 'turn_on', label: 'Does it for you', multi: true, max: 5 },
      { key: 'turn_offs', category: 'turn_off', label: 'Puts you off', multi: true, max: 5 },
    ],
  },
  {
    id: 'intimate',
    label: 'The intimate half',
    note:
      'Nobody is told any of this up front. Characters find it out by talking to you - except your hard limits, which are always respected.',
    fields: [
      { key: 'fetishes', category: 'fetish', label: 'Really does it for you', multi: true, max: 6 },
      { key: 'hard_limits', category: 'hard_limit', label: 'Hard limits', multi: true, max: 6 },
    ],
  },
];

const FIELDS: CardField[] = CARD_SECTIONS.flatMap((s) => s.fields);

/** Keep only ids that exist in the right table, so nothing invented reaches a prompt. */
export function sanitizeCard(raw: unknown): UserCard {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const f of FIELDS) {
    const value = input[f.key];
    if (value == null) continue;
    const valid = new Set(byCategory(f.category).map((a) => a.id));
    if (f.multi) {
      if (!Array.isArray(value)) continue;
      const ids = value.map(String).filter((id) => valid.has(id)).slice(0, f.max ?? 6);
      if (ids.length) out[f.key] = ids;
    } else {
      const id = String(value);
      if (valid.has(id)) out[f.key] = id;
    }
  }

  // Free-number scales, clamped rather than dropped.
  const scale = (v: unknown, lo: number, hi: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
  };
  for (const [key, lo, hi] of [
    ['libido', 1, 5],
    ['sexual_confidence', 1, 5],
    ['sexting_readiness', 1, 5],
    ['dom_sub_leaning', -3, 3],
  ] as const) {
    const n = scale(input[key], lo, hi);
    if (n !== undefined) out[key] = n;
  }

  return out as UserCard;
}

const label = (cat: string, id: string) => find(cat, id)?.label ?? id;

/**
 * The attribute tables are written for the women the app generates, so their labels and
 * hints say "her" - "small flat of her own", "still at her parents'". Reused verbatim on his
 * card that reads as a mistake in every prompt he appears in, so the pronouns are swapped to
 * match the gender he actually gave. Word boundaries only, or this eats "there" and "other".
 */
function repronoun(text: string, gender: string): string {
  const [subj, poss] = gender === 'man'
    ? ['he', 'his']
    : gender === 'woman'
      ? ['she', 'her']
      : ['they', 'their'];
  return text
    .replace(/\bshe\b/g, subj)
    .replace(/\bShe\b/g, subj.charAt(0).toUpperCase() + subj.slice(1))
    .replace(/\bher\b/g, poss)
    .replace(/\bHer\b/g, poss.charAt(0).toUpperCase() + poss.slice(1))
    .replace(/\bhers\b/g, gender === 'man' ? 'his' : gender === 'woman' ? 'hers' : 'theirs');
}

function lines(card: UserCard, fields: CardField[], gender: string): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const v = (card as any)[f.key];
    if (!v || (Array.isArray(v) && !v.length)) continue;
    // Labels rather than prompt hints: the hints are in-voice instructions written at a
    // character ("you dress..."), which makes no sense read back about him.
    const text = Array.isArray(v)
      ? v.map((id: string) => label(f.category, id)).join(', ')
      : label(f.category, String(v));
    out.push(`${f.label}: ${repronoun(text, gender)}`);
  }
  return out;
}

function section(id: CardSection['id']): CardField[] {
  return CARD_SECTIONS.find((s) => s.id === id)?.fields ?? [];
}

/**
 * What a character can see of his card right now.
 *
 * His profile and looks are readable, the same as anyone's before swiping; the intimate half
 * is discovered in conversation.
 */
export function userCardBlock(user: UserProfile, swapped = true): string {
  const card = user.card ?? {};
  const out: string[] = [];

  const g = user.gender ?? '';
  const profile = [
    ...lines(card, section('life'), g),
    ...lines(card, section('interests'), g),
    ...lines(card, section('wants').filter((f) => f.key === 'search_motive' || f.key === 'turn_ons'), g),
  ];
  if (profile.length) {
    out.push(
      'FROM HIS PROFILE. You have read this, the way you read anyone\'s before swiping:\n' +
        profile.map((l) => `- ${l}`).join('\n') +
        '\nYou know it, so do not read it back to him. Nobody recites someone\'s profile at them; ' +
        'you just talk like a person who has already seen it.',
    );
  }

  // What he looks like comes with his picture, so only after the swap.
  const looks = swapped ? lines(card, section('looks'), g) : [];
  if (looks.length) {
    out.push('WHAT HE LOOKS LIKE (you have seen his picture):\n' + looks.map((l) => `- ${l}`).join('\n'));
  }

  // His limits are never a discovery. Finding one by crossing it is not a game.
  const limits = card.hard_limits ?? [];
  if (limits.length) {
    out.push(
      'HE WILL NOT DO: ' + limits.map((id) => label('hard_limit', id)).join(', ') +
        '. These are his limits and they hold whatever the mood is. Do not push one, do not ' +
        'treat it as something to talk him round on, and do not bring it up to test it.',
    );
  }

  return out.join('\n\n');
}

/** The Director sees the lot, including his intimate side, so it can steer her towards it. */
export function userCardFullBlock(user: UserProfile): string {
  const card = user.card ?? {};
  const out: string[] = [];
  for (const s of CARD_SECTIONS) {
    const ls = lines(card, s.fields, user.gender ?? '');
    if (ls.length) out.push(`${s.label}:\n` + ls.map((l) => `- ${l}`).join('\n'));
  }
  const scales: string[] = [];
  if (card.libido) scales.push(`libido ${card.libido}/5`);
  if (card.sexual_confidence) scales.push(`sexual confidence ${card.sexual_confidence}/5`);
  if (card.sexting_readiness) scales.push(`sexting readiness ${card.sexting_readiness}/5`);
  if (card.dom_sub_leaning !== undefined) {
    scales.push(
      `leaning ${card.dom_sub_leaning <= -2 ? 'submissive' : card.dom_sub_leaning >= 2 ? 'dominant' : 'neither strongly'}`,
    );
  }
  if (scales.length) out.push('His own scales: ' + scales.join(', '));
  return out.join('\n\n');
}
