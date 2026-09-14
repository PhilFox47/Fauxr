import { find } from '../db/attributes.js';
import type { Character, Flags, Relationship } from '../types.js';

/**
 * Everything a player can learn about a character, and whether they have learned it yet.
 *
 * This is the progression the chat was missing. Stats are invisible by design, so without
 * something like this there is nothing to work towards and no sense of getting anywhere -
 * every message feels like the same message. A profile that fills in as she actually tells
 * you things turns "chat with her" into "find out who she is", which is what a dating app
 * is for.
 *
 * Nothing here is revealed by a threshold. A fact becomes known because she said it.
 */

export type DiscoveryCategory = 'basics' | 'life' | 'personality' | 'interests' | 'looks' | 'intimate';

export interface DiscoverableFact {
  key: string;
  category: DiscoveryCategory;
  label: string;
  /** What the player sees once it is known. */
  value: string;
  /** Roughly how it comes out, shown as a nudge on the locked row. */
  hint: string;
}

export const CATEGORY_LABELS: Record<DiscoveryCategory, string> = {
  basics: 'Basics',
  life: 'Her life',
  personality: 'Who she is',
  interests: 'What she is into',
  looks: 'Looks',
  intimate: 'Intimate',
};

const label = (cat: string, id: string) => find(cat, id)?.label ?? id;
/** English has no row in the language table, so it would otherwise render lowercase. */
const langLabel = (id: string) => find('language', id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);

/** The full set of facts for one character. Stable keys, so progress survives a restart. */
export function buildCatalogue(character: Character): DiscoverableFact[] {
  const s = character.seed;
  const facts: DiscoverableFact[] = [];
  const add = (key: string, category: DiscoveryCategory, lbl: string, value: string, hint: string) => {
    if (value) facts.push({ key, category, label: lbl, value, hint });
  };

  // ---- basics
  add('real_name', 'basics', 'Name', character.real_name, 'She has to want to tell you.');
  add('age', 'basics', 'Age', String(s.age), 'On her profile from the start.');
  add('languages', 'basics', 'Languages', s.languages.map(langLabel).join(', '), 'On her profile from the start.');
  add('occupation', 'life', 'Work', label('occupation', s.occupation), 'Ask what she does. Or notice when she says it.');
  add('living_situation', 'life', 'Living', label('living_situation', s.living_situation), 'Where she is when she texts you.');
  add('social_energy', 'life', 'Social battery', label('social_energy', s.social_energy), 'Watch how she talks about her weekends.');
  add('relationship_status', 'life', 'Status', label('relationship_status', s.relationship_status), 'Whether anyone else is in the picture. She will say if it comes up.');
  add('relationship_history', 'life', 'History', label('relationship_history', s.relationship_history), 'Not a first-week question.');
  add('dating_experience', 'life', 'On apps', label('dating_experience', s.dating_experience), 'How she talks about this place.');

  // ---- personality
  add('archetype', 'personality', 'Character', label('archetype', s.archetype), 'Becomes obvious over time.');
  add('humor_type', 'personality', 'Humour', label('humor_type', s.humor_type), 'Make her laugh and find out.');
  add('attachment_style', 'personality', 'In a relationship', label('attachment_style', s.attachment_style), 'Shows when things get close.');
  add('conflict_style', 'personality', 'In an argument', label('conflict_style', s.conflict_style), 'Shows when something goes wrong.');
  add('insecurity', 'personality', 'Soft spot', s.hints.insecurity || label('insecurity', s.insecurity), 'Only if she trusts you with it.');
  add('search_motive', 'personality', 'Why she is here', s.hints.search_motive || label('search_motive', s.search_motive), 'Ask her, honestly.');
  s.quirks.forEach((q) => add(`quirk:${q}`, 'personality', 'Quirk', label('quirk', q), 'You will notice eventually.'));

  // ---- interests
  s.interests.forEach((i) => add(`interest:${i}`, 'interests', 'Into', label('interest', i), 'Get her talking about it.'));
  s.hobbies.forEach((h) => add(`hobby:${h}`, 'interests', 'Does', label('hobby', h), 'Ask what she does with her time.'));

  // ---- looks: photos, or meeting her
  add('hair', 'looks', 'Hair', `${label('hair_color', s.hair_color)}, ${label('hair_style', s.hair_style)}`, 'Needs a photo.');
  add('eyes', 'looks', 'Eyes', label('eye_color', s.eye_color), 'Needs a photo.');
  add('height', 'looks', 'Height', label('height', s.height), 'Needs a photo, or a date.');
  add('body_type', 'looks', 'Build', label('body_type', s.body_type), 'Needs a photo, or a date.');
  add('style', 'looks', 'Style', label('clothing_style', s.clothing_style), 'Needs a photo.');
  add('distinctive_feature', 'looks', 'Distinctive', label('distinctive_feature', s.distinctive_feature), 'Needs a photo, or a date.');
  s.tattoos.forEach((t, i) =>
    add(`tattoo:${i}`, 'looks', 'Tattoo', `${label('tattoo_motif', t.motif)}, ${label('tattoo_position', t.position)}`, 'Some are easier to see than others.'));
  s.piercings.forEach((p, i) =>
    add(`piercing:${i}`, 'looks', 'Piercing', `${label('piercing_type', p.type)}, ${label('piercing_position', p.position)}`, 'Some are easier to see than others.'));

  // ---- intimate: only once that side of the conversation is open
  add('libido', 'intimate', 'Drive', `${s.libido}/5`, 'She has to be comfortable first.');
  add('sexual_confidence', 'intimate', 'Confidence', `${s.sexual_confidence}/5`, 'She has to be comfortable first.');
  add('dom_sub_leaning', 'intimate', 'Leaning',
    s.dom_sub_leaning <= -2 ? 'Submissive' : s.dom_sub_leaning >= 2 ? 'Dominant' : 'Switch / neither',
    'She has to be comfortable first.');
  s.fetishes.forEach((f) => add(`fetish:${f}`, 'intimate', 'Into', label('fetish', f), 'She has to want to tell you.'));
  s.hard_limits.forEach((h) => add(`limit:${h}`, 'intimate', 'Hard limit', label('hard_limit', h), 'She will say so if it comes up.'));

  return facts;
}

export type DiscoveredMap = Record<string, string>;

/**
 * Known from the moment she appears, because they are on her card before you swipe. Nothing
 * is gained by making someone extract a number that was printed on the profile, and the
 * Director being told to "reveal" her age produced conversations that opened by stating it.
 */
const ALWAYS_KNOWN = ['age', 'languages'];

/** Flags already record some reveals; keep the profile consistent with them. */
function impliedByFlags(flags: Flags): string[] {
  const keys: string[] = [...ALWAYS_KNOWN];
  if (flags.state.real_name_known) keys.push('real_name');
  if (flags.state.profile_picture_sent) keys.push('hair', 'eyes', 'style', 'distinctive_feature');
  if (flags.state.has_had_first_date) keys.push('height', 'body_type');
  return keys;
}

export interface ProfileRow {
  key: string;
  category: DiscoveryCategory;
  label: string;
  known: boolean;
  /** Null while undiscovered; the UI shows ??? for those. */
  value: string | null;
  hint: string;
  at: string | null;
}

export interface ProfileView {
  known: number;
  total: number;
  categories: { category: DiscoveryCategory; label: string; known: number; total: number; rows: ProfileRow[] }[];
}

export function profileView(character: Character, rel: Relationship): ProfileView {
  const catalogue = buildCatalogue(character);
  const discovered: DiscoveredMap = rel.discovered ?? {};
  const implied = new Set(impliedByFlags(rel.flags));

  const rows: ProfileRow[] = catalogue.map((f) => {
    const known = f.key in discovered || implied.has(f.key);
    return {
      key: f.key,
      category: f.category,
      label: f.label,
      known,
      value: known ? f.value : null,
      hint: f.hint,
      at: discovered[f.key] ?? null,
    };
  });

  const order: DiscoveryCategory[] = ['basics', 'life', 'personality', 'interests', 'looks', 'intimate'];
  const categories = order
    .map((category) => {
      const inCategory = rows.filter((r) => r.category === category);
      return {
        category,
        label: CATEGORY_LABELS[category],
        known: inCategory.filter((r) => r.known).length,
        total: inCategory.length,
        rows: inCategory,
      };
    })
    .filter((c) => c.total > 0);

  return { known: rows.filter((r) => r.known).length, total: rows.length, categories };
}

/** Keys the Director may still reveal, so its prompt does not list what is already known. */
export function undiscoveredKeys(character: Character, rel: Relationship): DiscoverableFact[] {
  const discovered = rel.discovered ?? {};
  const implied = new Set(impliedByFlags(rel.flags));
  return buildCatalogue(character).filter((f) => !(f.key in discovered) && !implied.has(f.key));
}

/**
 * Deterministic backstop for the obvious cases. If she names her job or her cat, that is
 * known whether or not the Director thought to say so.
 */
export function detectMentions(character: Character, rel: Relationship, saidByHer: string): string[] {
  const text = saidByHer.toLowerCase();
  if (!text.trim()) return [];
  const found: string[] = [];
  for (const fact of undiscoveredKeys(character, rel)) {
    // Looks need a photo or a meeting; saying "my hair" does not reveal its colour.
    if (fact.category === 'looks') continue;
    const words = fact.value
      .toLowerCase()
      .split(/[,/]/)[0]
      .split(/\s+/)
      .filter((w) => w.length > 4);
    if (words.length && words.every((w) => text.includes(w))) found.push(fact.key);
  }
  return found;
}

export function recordDiscoveries(rel: Relationship, keys: string[], validKeys: Set<string>): string[] {
  const added: string[] = [];
  const at = new Date().toISOString();
  rel.discovered = rel.discovered ?? {};
  for (const key of keys) {
    if (!validKeys.has(key) || rel.discovered[key]) continue;
    rel.discovered[key] = at;
    added.push(key);
  }
  return added;
}

/**
 * The other half of the exchange: what SHE still wants to know about him. Without this the
 * Director only ever thinks about what she is giving away, and she ends up as an interview
 * subject rather than someone with her own interest in the person she is talking to.
 */
const HER_QUESTIONS: { topic: string; keywords: string[] }[] = [
  { topic: 'what he actually does for work, and whether he likes it', keywords: ['work', 'job', 'career', 'office', 'shift', 'employ'] },
  { topic: 'how he spends time when nobody is watching', keywords: ['hobby', 'hobbies', 'weekend', 'free time', 'plays', 'reads', 'watches'] },
  { topic: 'why he is on this app, honestly', keywords: ['app', 'looking for', 'why he', 'dating', 'wants'] },
  { topic: 'whether he is talking to other people here', keywords: ['other', 'matches', 'exclusive', 'seeing anyone'] },
  { topic: 'what went wrong in his last relationship', keywords: ['ex', 'relationship', 'breakup', 'broke up', 'single'] },
  { topic: 'where he lives, roughly, and who with', keywords: ['lives', 'flat', 'apartment', 'house', 'flatmate', 'city'] },
  { topic: 'who he is close to - friends, family', keywords: ['friend', 'family', 'brother', 'sister', 'mum', 'dad', 'parents'] },
  { topic: 'what he is actually like when he is not typing', keywords: ['in person', 'nervous', 'shy', 'confident', 'meet'] },
  { topic: 'something he cares about more than he lets on', keywords: ['cares', 'passionate', 'loves', 'obsessed'] },
];

export function herCuriosity(rel: Relationship, limit = 4): string {
  const known = (rel.ledger?.facts?.about_user ?? []).join(' ').toLowerCase();
  const open = HER_QUESTIONS.filter((q) => !q.keywords.some((k) => known.includes(k)));
  if (!open.length) return 'She knows a fair amount about him by now. Find something more specific she would want.';
  return open.slice(0, limit).map((q) => `- ${q.topic}`).join('\n');
}

export interface FetishProgress {
  key: string;
  label: string;
  hint: string;
  known: boolean;
}

/**
 * Which of her fetishes he has actually found, and which are still hidden.
 *
 * Fetish exploration is a core loop rather than flavour, so the Director needs it broken
 * out explicitly: it is the difference between "she is into things" and "he found the one
 * thing and she came apart". Undiscovered ones are what she hints at when she is worked
 * up; discovered ones are what she wants him to use.
 */
export function fetishProgress(character: Character, rel: Relationship): FetishProgress[] {
  const discovered = rel.discovered ?? {};
  return character.seed.fetishes.map((f) => {
    const attr = find('fetish', f);
    return {
      key: `fetish:${f}`,
      label: attr?.label ?? f,
      hint: attr?.prompt_hint ?? '',
      known: `fetish:${f}` in discovered,
    };
  });
}

export function describeFetishProgress(character: Character, rel: Relationship): string {
  const all = fetishProgress(character, rel);
  if (!all.length) return '(none rolled for her)';
  const found = all.filter((f) => f.known);
  const hidden = all.filter((f) => !f.known);
  const lines: string[] = [];
  if (found.length) {
    lines.push('He has found out about: ' + found.map((f) => f.label).join(', ') +
      '. She knows he knows. Using these on her works, and she will not pretend otherwise.');
  }
  if (hidden.length) {
    lines.push('Still hidden: ' + hidden.map((f) => `${f.label} (${f.hint || 'no detail'})`).join('; ') +
      '. She does not announce these. When she is worked up she circles them, hints, tests whether he picks it up. ' +
      'If he lands on one himself, that is a large spark and arousal jump and she should react like it.');
  }
  const limits = character.seed.hard_limits.map((h) => find('hard_limit', h)?.label ?? h);
  if (limits.length) lines.push('Absolute limits, never crossed whatever the mood: ' + limits.join(', ') + '.');
  return lines.join('\n');
}
