import { find } from '../db/attributes.js';
import { getUserProfile } from '../repo.js';
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
  add('orientation', 'basics', 'Orientation', label('orientation', s.orientation), 'Comes up when it comes up.');
  add('freak', 'intimate', 'How far she goes',
    s.freak >= 4 ? 'Very little fazes her' : s.freak >= 2.5 ? 'Fairly open' : s.freak >= 1.2 ? 'Open to a point' : 'Knows what she likes',
    'You will get a sense of it.');
  for (const [domain, stance] of Object.entries(s.kink_map ?? {})) {
    if (stance !== 'into' && stance !== 'hard_no') continue;
    const d = find('kink_domain', domain);
    if (!d) continue;
    add(`kink:${domain}`, 'intimate', stance === 'into' ? 'Into' : 'Not for her', d.label,
      stance === 'into' ? 'She will let you know, one way or another.' : 'She will say so if it comes up.');
  }
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
 * How many messages he has to send before showing up earns him a credit toward uncovering
 * one of her hidden traits - a small, guaranteed payoff for showing up at all, independent
 * of anything she chooses to reveal on her own.
 */
export const MESSAGES_PER_TRAIT_CREDIT = 50;

/** Counts one of his messages toward the next credit. Returns true the turn one is earned. */
export function trackMessageForCredit(rel: Relationship): boolean {
  const count = (rel.flags.state.messages_sent_count ?? 0) + 1;
  rel.flags.state.messages_sent_count = count;
  if (count % MESSAGES_PER_TRAIT_CREDIT !== 0) return false;
  rel.flags.state.trait_credits = (rel.flags.state.trait_credits ?? 0) + 1;
  return true;
}

export interface UncoverResult {
  ok: boolean;
  /** Why it failed, when ok is false. */
  reason?: 'no_credits' | 'nothing_left';
  revealed?: DiscoverableFact;
}

/**
 * Spends one credit to reveal a random currently-locked trait. Both failure cases leave the
 * credit untouched: no reason to burn one on a request that could not do anything.
 */
export function spendTraitCredit(character: Character, rel: Relationship): UncoverResult {
  const credits = rel.flags.state.trait_credits ?? 0;
  if (credits <= 0) return { ok: false, reason: 'no_credits' };
  const locked = undiscoveredKeys(character, rel);
  if (!locked.length) return { ok: false, reason: 'nothing_left' };
  const pick = locked[Math.floor(Math.random() * locked.length)];
  rel.flags.state.trait_credits = credits - 1;
  recordDiscoveries(rel, [pick.key], new Set(locked.map((f) => f.key)));
  return { ok: true, revealed: pick };
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

/**
 * Words that put a kink domain on the table, for spotting when he has just walked into one
 * of hers. Deliberately a short list of unambiguous terms per domain: this fires a strong
 * signal to the Director, so a false positive is worse than a miss.
 */
const DOMAIN_TERMS: Record<string, string[]> = {
  bdsm_power: ['dominant', 'submissive', 'dom ', 'sub ', 'domme', 'in charge', 'boss me', 'obey', 'good girl', 'collar', 'safeword', 'bdsm', 'edging', 'beg'],
  bondage: ['tie you', 'tie me', 'tied up', 'rope', 'restrain', 'handcuff', 'cuffs', 'blindfold', 'bondage', 'shibari'],
  impact: ['spank', 'spanking', 'smack', 'paddle', 'flogger', 'riding crop', 'hair pulling', 'pull your hair'],
  pain_intense: ['wax', 'scratch', 'bite you', 'bite me', 'marks', 'bruis'],
  breath_play: ['choke', 'choking', 'hand on your throat', 'breath play'],
  degradation: ['degrade', 'humiliat', 'call you names', 'talk down to'],
  praise: ['good girl', 'so good', 'praise', 'tell you how good'],
  feet: ['feet', 'foot', 'toes', 'soles'],
  exhibitionism: ['in public', 'somewhere public', 'get caught', 'car park', 'outdoors', 'someone might see'],
  sharing: ['threesome', 'third person', 'watch you with', 'another guy', 'another girl', 'cuckold', 'share you'],
  anal: ['anal', 'from behind properly', 'back door'],
  toys: ['toy', 'vibrator', 'dildo', 'plug'],
  roleplay: ['roleplay', 'role play', 'pretend to be', 'costume', 'uniform', 'nurse outfit'],
  recording: ['film', 'record', 'video', 'send a pic', 'photos of you', 'camera'],
  fetishwear: ['latex', 'leather', 'lingerie', 'corset', 'stockings', 'fishnet', 'heels'],
};

export interface KinkHit {
  domain: string;
  label: string;
  stance: string;
}

/**
 * Which of her domains the user just touched, and where she stands on each. The Director is
 * told about it explicitly rather than being left to spot it in the transcript, because
 * "he landed on one of her things" is the single biggest arousal move available and a cheap
 * model reading forty messages will miss it most of the time.
 */
export function detectKinkHits(character: Character, saidByUser: string): KinkHit[] {
  const text = ` ${saidByUser.toLowerCase()} `;
  const map = character.seed.kink_map ?? {};
  const hits: KinkHit[] = [];
  for (const [domain, terms] of Object.entries(DOMAIN_TERMS)) {
    const stance = map[domain];
    if (!stance) continue;
    if (!terms.some((t) => text.includes(t))) continue;
    hits.push({ domain, label: find('kink_domain', domain)?.label ?? domain, stance });
  }
  return hits;
}

/** The Director-facing line for what he just walked into. Empty when he walked into nothing. */
export function describeKinkHits(hits: KinkHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    if (h.stance === 'into') return `- ${h.label}: he just brought this up and it is one of HERS. This should move arousal hard, and she does not have to hide that it landed.`;
    if (h.stance === 'curious') return `- ${h.label}: he brought this up and she is curious about it. Interest, not indifference.`;
    if (h.stance === 'hard_no') return `- ${h.label}: he brought this up and it is a hard limit. She says so plainly. This is not arousal, and pushing it costs him.`;
    return `- ${h.label}: he brought this up and it does nothing for her. Not offended, just not interested.`;
  });
  return 'WHAT HE JUST WALKED INTO:\n' + lines.join('\n');
}

/**
 * What she has worked out about what HE likes, and what she has not.
 *
 * His stances live on his profile and nobody is told them. A character learns one by him
 * actually bringing it up, and the knowledge is per-relationship and permanent - so the
 * woman he has been talking to for a fortnight knows things the new match does not, which
 * is the whole point of having it be discovered rather than handed over.
 *
 * Stored in the same `discovered` map as everything else under a `his:` prefix, so it
 * needed no new column and survives a restart like the rest of it.
 */
export function learnAboutHim(rel: Relationship, saidByUser: string): string[] {
  const profile = getUserProfile();
  const his = profile?.kink_map ?? {};
  if (!Object.keys(his).length) return [];
  const text = ` ${saidByUser.toLowerCase()} `;
  const learned: string[] = [];
  for (const [domain, terms] of Object.entries(DOMAIN_TERMS)) {
    if (!(domain in his)) continue;
    const key = `his:${domain}`;
    if (rel.discovered?.[key]) continue;
    if (!terms.some((t) => text.includes(t))) continue;
    rel.discovered[key] = new Date().toISOString();
    learned.push(domain);
  }
  return learned;
}

const HIS_STANCE_WORD: Record<string, string> = {
  into: 'he is into it',
  curious: 'he is curious about it',
  soft_no: 'not his thing',
  hard_no: 'a hard no for him',
};

/** What she knows about his side, and the gaps she could actually ask about. */
export function describeHim(rel: Relationship): string {
  const his = getUserProfile()?.kink_map ?? {};
  const entries = Object.entries(his);
  if (!entries.length) return '';

  const known = entries.filter(([d]) => rel.discovered?.[`his:${d}`]);
  const unknown = entries.filter(([d]) => !rel.discovered?.[`his:${d}`]);
  const lines: string[] = [];

  if (known.length) {
    lines.push(
      'What she has worked out about what HE likes:\n' +
        known.map(([d, st]) => `- ${find('kink_domain', d)?.label ?? d}: ${HIS_STANCE_WORD[st] ?? st}`).join('\n') +
        '\nShe knows these because he told her. She can use them, refer back to them, and take them into account.',
    );
  }
  if (unknown.length) {
    lines.push(
      'She does NOT know where he stands on: ' +
        unknown.map(([d]) => find('kink_domain', d)?.label ?? d).join(', ') +
        '.\nThese are real gaps in what she knows, and asking about one is a genuinely good use of a turn - ' +
        'not an interview question, the way someone actually asks when they want to know what they are dealing with. ' +
        'Never assume an answer to one of these, and never act as though he has already said.',
    );
  }
  return lines.join('\n\n');
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
