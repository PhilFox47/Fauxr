import { find } from '../db/attributes.js';
import { getUserProfile } from '../repo.js';
import type { Character, KinkSide, Relationship } from '../types.js';
import { sideLabel } from './kinks.js';

/**
 * Everything a player can learn about a character, and whether they have learned it yet.
 *
 * Her ordinary profile - job, looks, personality, interests - is simply known from the start:
 * there is nothing to extract. What is still worth discovering is the intimate side: her
 * kinks, fetishes, limits, drive. Those fill in as she actually lets them out.
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
  add('real_name', 'basics', 'Name', character.real_name, '');
  add('age', 'basics', 'Age', String(s.age), 'On her profile from the start.');
  add('languages', 'basics', 'Languages', s.languages.map(langLabel).join(', '), 'On her profile from the start.');
  add('occupation', 'life', 'Work', label('occupation', s.occupation), 'Ask what she does. Or notice when she says it.');
  add('living_situation', 'life', 'Living', label('living_situation', s.living_situation), 'Where she is when she texts you.');
  add('social_energy', 'life', 'Social battery', label('social_energy', s.social_energy), 'Watch how she talks about her weekends.');
  add('relationship_status', 'life', 'Status', label('relationship_status', s.relationship_status), 'Whether anyone else is in the picture. She will say if it comes up.');

  // ---- personality
  add('archetype', 'personality', 'Character', label('archetype', s.archetype), 'Becomes obvious over time.');
  add('humor_type', 'personality', 'Humour', label('humor_type', s.humor_type), 'Make her laugh and find out.');
  add('speech_style', 'personality', 'How she talks in person', label('speech_style', s.speech_style), 'Needs a date.');
  s.quirks.forEach((q) => add(`quirk:${q}`, 'personality', 'Quirk', label('quirk', q), 'You will notice eventually.'));

  // ---- interests
  s.interests.forEach((i) => add(`interest:${i}`, 'interests', 'Into', label('interest', i), 'Get her talking about it.'));
  s.hobbies.forEach((h) => add(`hobby:${h}`, 'interests', 'Does', label('hobby', h), 'Ask what she does with her time.'));

  // ---- looks: photos, or meeting her
  // Species is the one 'looks' fact that can also come out in conversation rather than only
  // a photo - see the exception for it in detectMentions() below.
  add('species', 'looks', 'Species', s.species && s.species !== 'human' ? label('species', s.species) : '',
    'Shows in a photo, or comes up on its own.');
  add('hair', 'looks', 'Hair', `${label('hair_color', s.hair_color)}, ${label('hair_style', s.hair_style)}`, 'Needs a photo.');
  add('eyes', 'looks', 'Eyes', label('eye_color', s.eye_color), 'Needs a photo.');
  add('height', 'looks', 'Height', label('height', s.height), 'Needs a photo, or a date.');
  add('body_type', 'looks', 'Build', label('body_type', s.body_type), 'Needs a photo, or a date.');
  add('butt_size', 'looks', 'Her butt', s.butt_size ? label('butt_size', s.butt_size) : '', 'Needs a photo from the right angle.');
  add('style', 'looks', 'Style', label('clothing_style', s.clothing_style), 'Needs a photo.');
  add('distinctive_feature', 'looks', 'Distinctive', label('distinctive_feature', s.distinctive_feature), 'Needs a photo, or a date.');
  s.tattoos.forEach((t, i) =>
    add(`tattoo:${i}`, 'looks', 'Tattoo', `${label('tattoo_motif', t.motif)}, ${label('tattoo_position', t.position)}`, 'Some are easier to see than others.'));
  s.piercings.forEach((p, i) =>
    add(`piercing:${i}`, 'looks', 'Piercing', `${label('piercing_type', p.type)}, ${label('piercing_position', p.position)}`, 'Some are easier to see than others.'));
  s.accessories.forEach((a, i) =>
    add(`accessory:${i}`, 'looks', 'Accessory', label('accessory', a), 'Needs a photo.'));

  // ---- intimate: the part that is actually discovered
  add('sexual_persona', 'intimate', 'In bed', label('sexual_persona', s.sexual_persona), 'Becomes obvious once things get going.');
  add('search_motive', 'intimate', 'Why she is here', label('search_motive', s.search_motive), 'Ask her what she is looking for.');
  add('dirty_talk', 'intimate', 'Dirty talk', label('dirty_talk', s.dirty_talk), 'Get her talking.');
  add('sexual_experience', 'intimate', 'Experience', label('sexual_experience', s.sexual_experience), 'Ask what she has done.');
  add('body_pride', 'intimate', 'Proudest of', label('body_pride', s.body_pride), 'Compliment her and see what lands.');
  add('signature_move', 'intimate', 'Her signature', label('signature_move', s.signature_move), 'She will come back to it.');
  add('lingerie_style', 'intimate', 'Underneath', s.lingerie_style ? label('lingerie_style', s.lingerie_style) : '', 'Ask what she has on.');
  add('sleepwear', 'intimate', 'Sleeps in', s.sleepwear ? label('sleepwear', s.sleepwear) : '', 'Ask her at bedtime.');
  add('intimate_grooming', 'intimate', 'Down there', s.intimate_grooming ? label('intimate_grooming', s.intimate_grooming) : '', 'She will tell you if you ask nicely.');
  add('orientation', 'basics', 'Orientation', label('orientation', s.orientation), '');
  add('freak', 'intimate', 'How far she goes',
    s.freak >= 4 ? 'Very little fazes her' : s.freak >= 2.5 ? 'Fairly open' : s.freak >= 1.2 ? 'Open to a point' : 'Knows what she likes',
    'You will get a sense of it.');
  for (const [domain, stance] of Object.entries(s.kink_map ?? {})) {
    if (stance !== 'into' && stance !== 'hard_no') continue;
    const d = find('kink_domain', domain);
    if (!d) continue;
    const side = stance === 'into' ? sideLabel(d, s.kink_sides?.[domain]) : '';
    add(`kink:${domain}`, 'intimate', stance === 'into' ? 'Into' : 'Not for her', side ? `${d.label} - ${side}` : d.label,
      stance === 'into' ? 'She will let you know, one way or another.' : 'She will say so if it comes up.');
  }
  add('libido', 'intimate', 'Drive', `${s.libido}/5`, 'Shows in how often she goes there.');
  add('sexual_confidence', 'intimate', 'Confidence', `${s.sexual_confidence}/5`, 'Shows in how she talks about it.');
  add('dom_sub_leaning', 'intimate', 'Leaning',
    s.dom_sub_leaning <= -2 ? 'Submissive' : s.dom_sub_leaning >= 2 ? 'Dominant' : 'Switch / neither',
    'Find out who takes charge.');
  s.fetishes.forEach((f) => add(`fetish:${f}`, 'intimate', 'Into', label('fetish', f), 'Get her talking about what she wants.'));
  s.hard_limits.forEach((h) => add(`limit:${h}`, 'intimate', 'Hard limit', label('hard_limit', h), 'She will say so if it comes up.'));

  return facts;
}

export type DiscoveredMap = Record<string, string>;

/**
 * Everything except the intimate side is known from the start. The profile is not a thing to
 * extract; the fun is finding out what she is into.
 */
function knownFromStart(catalogue: DiscoverableFact[]): Set<string> {
  return new Set(catalogue.filter((f) => f.category !== 'intimate').map((f) => f.key));
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
  const implied = knownFromStart(catalogue);

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
  const catalogue = buildCatalogue(character);
  const implied = knownFromStart(catalogue);
  return catalogue.filter((f) => !(f.key in discovered) && !implied.has(f.key));
}

/**
 * Deterministic backstop for the obvious cases. If she names her job or her cat, that is
 * known whether or not the Director thought to say so.
 */
export function detectMentions(character: Character, rel: Relationship, saidByHer: string): string[] {
  const text = saidByHer.toLowerCase();
  if (!text.trim()) return [];
  const found: string[] = [];
  const undiscovered = undiscoveredKeys(character, rel);

  for (const fact of undiscovered) {
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
  { topic: 'the filthiest thing he has always wanted to try', keywords: ['always wanted', 'never tried', 'want to try', 'bucket list'] },
  { topic: 'what he thinks about when he gets himself off', keywords: ['think about', 'jerk', 'wank', 'get off', 'touch myself', 'fantasi'] },
  { topic: 'whether he likes to take charge or be told what to do', keywords: ['dominant', 'submissive', 'in charge', 'take control', 'told what', 'dom', 'sub'] },
  { topic: 'what he would do to her first if she were there right now', keywords: ['first thing', 'if you were here', 'if i were there', 'right now i would'] },
  { topic: 'what about her specifically turns him on', keywords: ['your body', 'your lips', 'your ass', 'your tits', 'turns me on about you', 'love your'] },
  { topic: 'the best sex he has ever had and what made it', keywords: ['best sex', 'best time', 'hottest', 'ever had'] },
  { topic: 'something he has never told anyone he is into', keywords: ['never told', 'secret', 'embarrass', 'confess'] },
  { topic: 'what he likes to hear in bed', keywords: ['dirty talk', 'say to me', 'talk dirty', 'hear you say', 'moan'] },
];

/** A stable per-character order, so two characters never get the same questions in the same order. */
function seededOrder<T>(items: T[], key: string): T[] {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const scored = items.map((item, i) => {
    let x = (h ^ Math.imul(i + 1, 2654435761)) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 2246822507) >>> 0; x ^= x >>> 13;
    return { item, x };
  });
  return scored.sort((a, b) => a.x - b.x).map((s) => s.item);
}

/**
 * A couple of things SHE would like to know about him. Deliberately few, deliberately
 * hers: the same fixed list used to go to every character in the same order, which is how four
 * different women all opened by asking "take charge or be told?" and "what would you do to me
 * first". Half of it now comes from her own kinks, and the generic half is shuffled per
 * character.
 */
export function herCuriosity(character: Character, rel: Relationship, limit = 2): string {
  const known = (rel.ledger?.facts?.about_user ?? []).join(' ').toLowerCase();
  const own = seededOrder(character.seed.fetishes ?? [], character.id)
    .map((f) => find('fetish', f)?.label ?? f)
    .filter((label) => !known.includes(label.toLowerCase()))
    .slice(0, 1)
    // Quoted rather than spliced: the labels are written from her side ("Spanking him"), so
    // "whether he would be into spanking him with her" came out garbled.
    .map((label) => `whether he is up for one of her kinks: "${label.toLowerCase()}"`);
  const generic = seededOrder(HER_QUESTIONS, character.id)
    .filter((q) => !q.keywords.some((k) => known.includes(k)))
    .slice(0, Math.max(0, limit - own.length))
    .map((q) => q.topic);
  const all = [...own, ...generic];
  if (!all.length) return 'She knows a lot about what he likes by now.';
  return all.map((t) => `- ${t}`).join('\n') +
    '\nLow priority: she mostly finds these out by noticing what gets him, not by asking. At most one question per turn, and not every turn.';
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
  bdsm_power: ['dominant', 'submissive', 'dom ', 'sub ', 'domme', 'in charge', 'boss me', 'obey', 'good girl', 'collar', 'safeword', 'bdsm', 'edging', 'beg', 'jerk off instructions', 'joi', 'free use', 'primal', 'daddy', 'consensual non-consent', 'slave'],
  bondage: ['tie you', 'tie me', 'tied up', 'rope', 'restrain', 'handcuff', 'cuffs', 'blindfold', 'bondage', 'shibari'],
  impact: ['spank', 'spanking', 'smack', 'paddle', 'flogger', 'riding crop', 'hair pulling', 'pull your hair'],
  pain_intense: ['wax', 'scratch', 'bite you', 'bite me', 'marks', 'bruis'],
  breath_play: ['choke', 'choking', 'hand on your throat', 'breath play'],
  degradation: ['degrade', 'humiliat', 'call you names', 'talk down to'],
  praise: ['good girl', 'so good', 'praise', 'tell you how good'],
  feet: ['feet', 'foot', 'toes', 'soles', 'sockjob', 'shoejob', 'lick my boots', 'lick your boots'],
  exhibitionism: ['in public', 'somewhere public', 'get caught', 'car park', 'outdoors', 'someone might see'],
  sharing: ['threesome', 'third person', 'watch you with', 'another guy', 'another girl', 'cuckold', 'cuckquean', 'cuck queen', 'share you', 'orgy', 'group sex', 'gangbang', 'gang bang', 'foursome', 'swingers', 'sex party', 'play party', 'polycule', 'hotwife', 'cuckold', 'another man'],
  anal: ['anal', 'from behind properly', 'back door', 'pegging'],
  toys: ['toy', 'vibrator', 'dildo', 'plug'],
  roleplay: ['roleplay', 'role play', 'pretend to be', 'costume', 'uniform', 'nurse outfit', 'petplay', 'pet play', 'cosplay', 'hentai', 'affair', 'cheat on'],
  recording: ['film', 'record', 'video', 'send a pic', 'photos of you', 'camera'],
  fetishwear: ['latex', 'leather', 'lingerie', 'corset', 'stockings', 'fishnet', 'heels', 'pantyhose', 'knee highs', 'knee-high'],
  cum_play: ['cum', 'swallow', 'facial', 'cum play', 'cum in', 'cum on', 'creampie', 'breed', 'finish inside'],
  messy: ['spit', 'squirt', 'soaked', 'drool', 'messy'],
  oral: ['go down on', 'eat you out', 'eat me out', 'blowjob', 'blow job', 'suck you off', 'sit on my face', 'sit on your face', 'oral', ' 69 '],
  instruction: ['instructions', 'tell me how to touch', 'tell you how to touch', 'on my count', 'countdown', 'do as i say'],
  tease_denial: ['edge you', 'edge me', 'edging', 'deny you', 'denial', 'ruin it', 'ruined orgasm', 'chastity', 'permission to cum', 'permission to come'],
  voyeurism: ['watch you touch', 'watch me touch', 'watch each other', 'in the mirror', 'watch you get dressed', 'peep'],
  primal: ['chase you', 'chase me', 'hunt you', 'hunt me', 'pin you down', 'pin me down', 'primal', 'wrestle', 'rough sex', 'take you rough'],
  sensation: ['ice cube', 'feather', 'hot wax', 'blindfold', 'temperature play', 'nails down'],
  size_difference: ['size difference', 'so small next to', 'so tiny next to', 'pick you up', 'height difference'],
};

/** Whether two ends of a domain meet: unset means no preference, so it meets anything. */
function sidesMeet(a: KinkSide | undefined, b: KinkSide | undefined): boolean {
  return !a || !b || a === 'both' || b === 'both' || a === b;
}

export interface KinkHit {
  domain: string;
  label: string;
  stance: string;
  /** Her end of it, in words, for a domain with two ends. */
  side: string;
  /**
   * True when his own profile has this domain as 'into' too, at an end that meets hers: she
   * wants her feet worshipped and he wants to worship them. Two people who both want their
   * own feet worshipped are not a "me too".
   */
  mutual: boolean;
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
  const profile = getUserProfile();
  const his = profile?.kink_map ?? {};
  const hits: KinkHit[] = [];
  for (const [domain, terms] of Object.entries(DOMAIN_TERMS)) {
    const stance = map[domain];
    if (!stance) continue;
    if (!terms.some((t) => text.includes(t))) continue;
    const d = find('kink_domain', domain);
    const herSide = character.seed.kink_sides?.[domain];
    hits.push({
      domain,
      label: d?.label ?? domain,
      stance,
      side: stance === 'into' || stance === 'curious' ? sideLabel(d, herSide) : '',
      mutual: stance === 'into' && his[domain] === 'into' && sidesMeet(herSide, profile?.kink_sides?.[domain]),
    });
  }
  return hits;
}

/** The Director-facing line for what he just walked into. Empty when he walked into nothing. */
export function describeKinkHits(hits: KinkHit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    const label = h.side ? `${h.label} (her end: ${h.side})` : h.label;
    if (h.mutual) return `- ${label}: he just brought this up, and it is not just one of hers - it is one of HIS too. This is a "wait, really? me too" moment, not just an arousal spike: let her react to the overlap itself, explicitly, before letting it move things forward.`;
    if (h.stance === 'into') return `- ${label}: he just brought this up and it is one of HERS. This moves arousal hard, and she lets it show and runs with it.`;
    if (h.stance === 'curious') return `- ${label}: he brought this up and she is curious about it. Interest, not indifference.`;
    if (h.stance === 'hard_no') return `- ${label}: he brought this up and it is a hard limit. She says so plainly and steers to something she does want.`;
    return `- ${label}: he brought this up and it does nothing for her. Not offended, just not interested.`;
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

/** What she knows about his side, and the gaps. */
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
        known
          .map(([d, st]) => {
            const dom = find('kink_domain', d);
            const side = st === 'into' || st === 'curious' ? sideLabel(dom, getUserProfile()?.kink_sides?.[d]) : '';
            return `- ${dom?.label ?? d}: ${HIS_STANCE_WORD[st] ?? st}${side ? ` (${side})` : ''}`;
          })
          .join('\n') +
        '\nShe knows these because he told her. She can use them, refer back to them, and take them into account.',
    );
  }
  if (unknown.length) {
    lines.push(
      'She does NOT know where he stands on: ' +
        unknown.map(([d]) => find('kink_domain', d)?.label ?? d).join(', ') +
        '.\nShe finds these out from how he reacts to what she brings, not by asking him down a list. ' +
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
      '. She lets these out when it suits her - hints, suggestions, or just saying it when she is worked up. ' +
      'If he lands on one himself, that is a big arousal jump and she reacts like it.');
  }
  const limits = character.seed.hard_limits.map((h) => find('hard_limit', h)?.label ?? h);
  if (limits.length) lines.push('Absolute limits, never crossed whatever the mood: ' + limits.join(', ') + '.');
  return lines.join('\n');
}
