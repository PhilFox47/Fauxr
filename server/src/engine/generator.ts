import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { db, nowIso } from '../db/index.js';
import { byCategory, find, type Attribute } from '../db/attributes.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import { insertCharacter, createRelationship } from '../repo.js';
import type { Character, CharacterSeed, OnlineWindow } from '../types.js';
import { drawCount, newContext, pickOne, randInt, roll, rollMany, rollRange, type DiceContext } from './dice.js';
import { textOverlap } from './voice.js';

/** Fields the Director may swap during the coherence pass. */
const SWAPPABLE: Record<string, string> = {
  clothing_style: 'clothing_style',
  grooming: 'grooming',
  makeup_style: 'makeup_style',
  hair_style: 'hair_style',
  hair_color: 'hair_color',
  occupation: 'occupation',
  living_situation: 'living_situation',
  relationship_status: 'relationship_status',
  humor_type: 'humor_type',
  conflict_style: 'conflict_style',
  insecurity: 'insecurity',
  relationship_history: 'relationship_history',
  dating_experience: 'dating_experience',
};

function hintOf(a: Attribute | null | undefined): string {
  if (!a) return '';
  return a.prompt_hint || a.label;
}

function rollAge(): number {
  // Skewed young-adult curve, hard minimum 18.
  const base = 18 + Math.floor(Math.abs(Math.min(randInt(0, 10) + randInt(0, 12), 22)));
  return Math.max(18, Math.min(42, base));
}

function rollTypoRate(typingStyle: string, archetype: string): number {
  let base = Math.random() * 0.14;
  if (typingStyle === 'lowercase_no_punct' || typingStyle === 'no_apostrophes') base += 0.07;
  if (typingStyle === 'proper') base = Math.random() * 0.03;
  if (archetype === 'chaotic' || archetype === 'burnt_out') base += 0.06;
  if (archetype === 'intellectual') base *= 0.5;
  return Math.round(Math.min(0.35, base) * 100) / 100;
}

function fallbackOnlineTimes(): OnlineWindow[] {
  const { from, to } = getSettings().server_window;
  const windows: OnlineWindow[] = [];
  const days = [1, 2, 3, 4, 5, 6, 0].filter(() => Math.random() < 0.6);
  const pool = days.length ? days : [1, 3, 5, 6];
  for (const weekday of pool) {
    const startHour = randInt(17, 21);
    const endHour = Math.min(23, startHour + randInt(2, 4));
    windows.push({ weekday, from: `${String(startHour).padStart(2, '0')}:00`, to: `${String(endHour).padStart(2, '0')}:30` });
  }
  void from;
  void to;
  return windows;
}

export interface RolledSeed {
  seed: CharacterSeed;
  ctx: DiceContext;
  archetype: Attribute;
  /** id per swappable field, so the Director's swaps can be applied. */
  fieldIds: Record<string, string>;
}

/**
 * Age is a number rather than a tag, so unlike the attribute tables it cannot carry its own
 * `extra.weights`. This is its equivalent: the nudges that stop an eighteen-year-old
 * divorcee or a forty-year-old in student halls, without making any of it impossible.
 */
function ageWeights(age: number): Record<string, number> {
  const w: Record<string, number> = {};
  const scale = (ids: string[], mult: number) => {
    for (const id of ids) w[id] = (w[id] ?? 1) * mult;
  };

  if (age <= 22) {
    scale(['student_halls', 'with_parents', 'flatshare'], 2.2);
    scale(['student_psych', 'student_art'], 2.0);
    scale(['never_serious', 'first_love_still', 'serial_short'], 1.6);
    scale(['divorced_young', 'married_briefly', 'widowed', 'engaged_called_off'], 0.15);
    scale(['open_marriage', 'engaged_open', 'separated', 'long_distance_partner'], 0.1);
    scale(['polycule'], 0.5);
  } else if (age >= 33) {
    scale(['student_halls', 'with_parents'], 0.2);
    scale(['student_psych', 'student_art'], 0.15);
    scale(['alone_flat', 'above_shop', 'house_sitting'], 1.4);
    scale(['divorced_young', 'married_briefly', 'long_ended', 'separated'], 1.8);
    scale(['open_marriage', 'engaged_open'], 1.6);
    scale(['never_serious'], 0.4);
  }
  if (age >= 26) scale(['student_halls', 'student_psych', 'student_art'], 0.4);
  return w;
}

/**
 * Generation runs as a cascade rather than one flat roll, because the order is what makes a
 * character hold together. Each stage is drawn knowing the ones before it, via ctx.weights:
 *
 *   1. age and languages  - the base, conditioned on nothing
 *   2. who she is         - archetype, personality, how she writes, her life
 *   3. what she looks like
 *   4. what she is into   - non-sexual
 *   5. the intimate half
 *
 * Languages come first because they are a soft stand-in for where she or her family are
 * from, which is what later makes a name plausible; age decides which lives are even
 * available to her. Rolling looks before personality, as this used to, meant appearance
 * could never reflect the person underneath - only the archetype could reach it.
 */
export function rollSeed(): RolledSeed {
  const ctx = newContext();
  const fieldIds: Record<string, string> = {};

  const one = (category: string, opts: { ignoreArchetype?: boolean } = {}) => {
    const a = roll(category, ctx, opts);
    if (a) fieldIds[category] = a.id;
    return a;
  };

  // ---- 1. the base: age and languages, conditioned on nothing
  const age = rollAge();
  // Most people here speak English and maybe one other. This used to come from the
  // archetype, which coupled how many languages she speaks to how she behaves - an odd
  // pairing now that a language is standing in for background rather than personality.
  const extraLanguages = rollMany('language', ctx, drawCount([0.55, 0.33, 0.12], 0)).map((a) => a.id);
  ctx.weights = { ...ctx.weights, ...ageWeights(age) };

  // ---- 2. who she is. The archetype re-weights everything after it; roll() merges its
  // extra.weights into the context on the way past, so nothing has to be applied by hand.
  const archetype = roll('archetype', ctx)!;
  const extra = archetype.extra ?? {};
  const counts = extra.counts ?? {};
  const ranges = extra.ranges ?? {};

  const attachment_style = one('attachment_style');
  const humor_type = one('humor_type');
  const conflict_style = one('conflict_style');
  const insecurity = one('insecurity');
  const quirks = rollMany('quirk', ctx, drawCount(counts.quirks, 2)).map((a) => a.id);

  const opennessFromArchetype = (archetype.modifies as any)?.openness_curve as string | undefined;
  const openness_curve = opennessFromArchetype ?? roll('openness_curve', ctx)!.id;

  // how she writes
  const typing_style = one('typing_style');
  const emoji_usage = one('emoji_usage');
  const emojiCount = emoji_usage?.id === 'none' ? 0 : emoji_usage?.id === 'heavy' ? randInt(2, 3) : randInt(0, 2);
  const favorite_emojis = rollMany('favorite_emoji', ctx, emojiCount).map((a) => a.extra?.char ?? a.label);
  const message_length = one('message_length');
  const speedFromArchetype = (archetype.modifies as any)?.response_speed as string | undefined;
  const response_speed = speedFromArchetype ?? roll('response_speed', ctx)!.id;
  const voice_msg_tendency = one('voice_msg_tendency');
  const slang_register = one('slang_register');

  // her life
  const occupation = one('occupation');
  const living_situation = one('living_situation');
  const relationship_status = one('relationship_status');
  const relationship_history = one('relationship_history');
  const dating_experience = one('dating_experience');
  const social_energy = one('social_energy');

  // ---- 3. looks, drawn knowing who she is and how old she is
  const ethnicity = one('ethnicity');
  const skin_tone = one('skin_tone');
  const height = one('height');
  const body_type = one('body_type');
  const hair_color = one('hair_color');
  const hair_style = one('hair_style');
  const eye_color = one('eye_color');
  const clothing_style = one('clothing_style');
  const grooming = one('grooming');
  const makeup_style = one('makeup_style');
  const distinctive_feature = one('distinctive_feature');

  const tattooCount = drawCount(counts.tattoos, 0);
  const tattoos = Array.from({ length: tattooCount }, () => ({
    motif: roll('tattoo_motif', ctx, { transient: true })?.id ?? 'fineline_flower',
    position: roll('tattoo_position', ctx, { transient: true })?.id ?? 'forearm',
  }));

  // Type first, then a position that type can actually go in: rolling both independently
  // produced things like a stretched lobe in a navel.
  const piercingCount = drawCount(counts.piercings, 1);
  const piercings = Array.from({ length: piercingCount }, () => {
    const type = roll('piercing_type', ctx, { transient: true });
    const allowed: string[] = (type?.extra?.positions as string[]) ?? [];
    const position = roll('piercing_position', ctx, {
      transient: true,
      only: allowed.length ? new Set(allowed) : undefined,
    });
    return { type: type?.id ?? 'stud', position: position?.id ?? 'earlobe' };
  });

  const accessories = rollMany('accessory', ctx, drawCount(counts.accessories, 1)).map((a) => a.id);

  // ---- 4. what she is into, the non-sexual half. search_motive, touchstone and the
  // turn-ons deliberately skip the archetype filter so she can still surprise.
  const interests = rollMany('interest', ctx, drawCount(counts.interests, 3)).map((a) => a.id);
  const hobbies = rollMany('hobby', ctx, drawCount(counts.hobbies, 2)).map((a) => a.id);
  const search_motive = roll('search_motive', ctx, { ignoreArchetype: true })!;
  const touchstone = roll('touchstone', ctx, { ignoreArchetype: true })!;
  const turn_ons = rollMany('turn_on', ctx, randInt(2, 4), { ignoreArchetype: true }).map((a) => a.id);
  const turn_offs = rollMany('turn_off', ctx, drawCount(counts.turn_offs, 2), { ignoreArchetype: true }).map((a) => a.id);
  const green_flags = rollMany('green_flag', ctx, drawCount(counts.green_flags, 2)).map((a) => a.id);
  const dealbreaker = roll('dealbreaker', ctx)!;

  // ---- 5. the intimate half, last, knowing everything above
  const libido = rollRange(ranges.libido, 1, 5);
  const sexual_confidence = rollRange(ranges.sexual_confidence, 1, 5);
  const dom_sub_leaning = rollRange(ranges.dom_sub_leaning, -3, 3);
  const sextingMod = Number((archetype.modifies as any)?.sexting_readiness ?? 0);
  const sexting_readiness = Math.max(1, Math.min(5, rollRange(ranges.sexting_readiness, 1, 5) + sextingMod));
  const fetishes = rollMany('fetish', ctx, drawCount(counts.fetishes, 3)).map((a) => a.id);
  const hard_limits = rollMany('hard_limit', ctx, drawCount(counts.hard_limits, 2)).map((a) => a.id);

  const hints: Record<string, string> = {
    archetype: hintOf(archetype),
    attachment_style: hintOf(attachment_style),
    humor_type: hintOf(humor_type),
    conflict_style: hintOf(conflict_style),
    insecurity: hintOf(insecurity),
    openness_curve: hintOf(find('openness_curve', openness_curve)),
    typing_style: hintOf(typing_style),
    emoji_usage: hintOf(emoji_usage),
    message_length: hintOf(message_length),
    response_speed: hintOf(find('response_speed', response_speed)),
    voice_msg_tendency: hintOf(voice_msg_tendency),
    slang_register: hintOf(slang_register),
    occupation: hintOf(occupation),
    living_situation: hintOf(living_situation),
    relationship_status: hintOf(relationship_status),
    relationship_history: hintOf(relationship_history),
    dating_experience: hintOf(dating_experience),
    social_energy: hintOf(social_energy),
    clothing_style: hintOf(clothing_style),
    grooming: hintOf(grooming),
    search_motive: hintOf(search_motive),
    touchstone: hintOf(touchstone),
    dealbreaker: hintOf(dealbreaker),
  };
  for (const id of quirks) hints[`quirk:${id}`] = hintOf(find('quirk', id));
  for (const id of interests) hints[`interest:${id}`] = hintOf(find('interest', id));
  for (const id of hobbies) hints[`hobby:${id}`] = hintOf(find('hobby', id));
  for (const id of turn_ons) hints[`turn_on:${id}`] = hintOf(find('turn_on', id));
  for (const id of turn_offs) hints[`turn_off:${id}`] = hintOf(find('turn_off', id));
  for (const id of green_flags) hints[`green_flag:${id}`] = hintOf(find('green_flag', id));
  for (const id of fetishes) hints[`fetish:${id}`] = hintOf(find('fetish', id));
  for (const id of extraLanguages) hints[`language:${id}`] = hintOf(find('language', id));

  const seed: CharacterSeed = {
    age,
    ethnicity: ethnicity!.id,
    skin_tone: skin_tone!.id,
    height: height!.id,
    body_type: body_type!.id,
    hair_color: hair_color!.id,
    hair_style: hair_style!.id,
    eye_color: eye_color!.id,
    clothing_style: clothing_style!.id,
    grooming: grooming!.id,
    makeup_style: makeup_style!.id,
    distinctive_feature: distinctive_feature!.id,
    tattoos,
    piercings,
    accessories,

    archetype: archetype.id,
    attachment_style: attachment_style!.id,
    humor_type: humor_type!.id,
    conflict_style: conflict_style!.id,
    openness_curve,
    insecurity: insecurity!.id,
    quirks,

    typing_style: typing_style!.id,
    typo_rate: rollTypoRate(typing_style!.id, archetype.id),
    emoji_usage: emoji_usage!.id,
    favorite_emojis,
    message_length: message_length!.id,
    response_speed,
    voice_msg_tendency: voice_msg_tendency!.id,
    slang_register: slang_register!.id,

    occupation: occupation!.id,
    living_situation: living_situation!.id,
    relationship_status: relationship_status!.id,
    relationship_history: relationship_history!.id,
    dating_experience: dating_experience!.id,
    social_energy: social_energy!.id,
    interests,
    hobbies,
    languages: ['english', ...extraLanguages],
    online_times: fallbackOnlineTimes(),

    search_motive: search_motive.id,
    touchstone: touchstone.id,
    turn_ons,
    turn_offs,
    green_flags,
    dealbreaker: dealbreaker.id,

    libido,
    sexual_confidence,
    dom_sub_leaning,
    sexting_readiness,
    fetishes,
    hard_limits,

    hints,
    appearance_prompt: '',
    image_seed: randInt(1, 2_000_000_000),
  };

  seed.appearance_prompt = buildAppearancePrompt(seed);
  return { seed, ctx, archetype, fieldIds };
}

/** Fixed appearance block assembled from the image_prompt fields of the appearance tags. */
export function buildAppearancePrompt(seed: CharacterSeed): string {
  const parts: string[] = [];
  const img = (cat: string, id: string) => find(cat, id)?.image_prompt;
  parts.push(`${seed.age} year old ${img('ethnicity', seed.ethnicity) ?? 'woman'}`);
  for (const [cat, id] of [
    ['skin_tone', seed.skin_tone],
    ['height', seed.height],
    ['body_type', seed.body_type],
    ['hair_color', seed.hair_color],
    ['hair_style', seed.hair_style],
    ['eye_color', seed.eye_color],
    ['distinctive_feature', seed.distinctive_feature],
    ['makeup_style', seed.makeup_style],
    ['grooming', seed.grooming],
    ['clothing_style', seed.clothing_style],
  ] as const) {
    const v = img(cat, id);
    if (v) parts.push(v);
  }
  return parts.filter(Boolean).join(', ');
}

export function describeSeed(seed: CharacterSeed): string {
  const label = (cat: string, id: string) => find(cat, id)?.label ?? id;
  const labels = (cat: string, ids: string[]) => ids.map((i) => label(cat, i)).join(', ') || 'none';
  const lines = [
    `age: ${seed.age}`,
    `archetype: ${label('archetype', seed.archetype)} - ${seed.hints.archetype}`,
    `attachment: ${label('attachment_style', seed.attachment_style)} - ${seed.hints.attachment_style}`,
    `humour: ${label('humor_type', seed.humor_type)} - ${seed.hints.humor_type}`,
    `conflict style: ${label('conflict_style', seed.conflict_style)} - ${seed.hints.conflict_style}`,
    `openness curve: ${seed.openness_curve} - ${seed.hints.openness_curve}`,
    `insecurity: ${label('insecurity', seed.insecurity)} - ${seed.hints.insecurity}`,
    `quirks: ${labels('quirk', seed.quirks)}`,
    '',
    `typing style: ${label('typing_style', seed.typing_style)} (${seed.hints.typing_style})`,
    `typo rate: ${seed.typo_rate}`,
    `emoji: ${seed.emoji_usage}${seed.favorite_emojis.length ? ' - favourites ' + seed.favorite_emojis.join(' ') : ''}`,
    `message length: ${seed.message_length} (${seed.hints.message_length})`,
    `response speed: ${seed.response_speed}`,
    `voice messages: ${seed.voice_msg_tendency}`,
    `register: ${seed.slang_register}`,
    '',
    `appearance: ${seed.appearance_prompt}`,
    `tattoos: ${seed.tattoos.map((t) => `${label('tattoo_motif', t.motif)} ${label('tattoo_position', t.position)}`).join('; ') || 'none'}`,
    `piercings: ${seed.piercings.map((p) => `${label('piercing_type', p.type)} ${label('piercing_position', p.position)}`).join('; ') || 'none'}`,
    `accessories: ${labels('accessory', seed.accessories)}`,
    '',
    `occupation: ${label('occupation', seed.occupation)} - ${seed.hints.occupation}`,
    `lives: ${label('living_situation', seed.living_situation)} - ${seed.hints.living_situation}`,
    `relationship status: ${label('relationship_status', seed.relationship_status)} - ${seed.hints.relationship_status}`,
    `history: ${label('relationship_history', seed.relationship_history)} - ${seed.hints.relationship_history}`,
    `dating experience: ${label('dating_experience', seed.dating_experience)} - ${seed.hints.dating_experience}`,
    `social energy: ${seed.social_energy}`,
    `interests: ${labels('interest', seed.interests)}`,
    `hobbies: ${labels('hobby', seed.hobbies)}`,
    `languages: ${seed.languages.join(', ')}`,
    '',
    `search motive: ${label('search_motive', seed.search_motive)} - ${seed.hints.search_motive}`,
    `touchstone: ${label('touchstone', seed.touchstone)} - ${seed.hints.touchstone}`,
    `turn ons: ${labels('turn_on', seed.turn_ons)}`,
    `turn offs: ${labels('turn_off', seed.turn_offs)}`,
    `green flags: ${labels('green_flag', seed.green_flags)}`,
    `DEALBREAKER: ${label('dealbreaker', seed.dealbreaker)} - ${seed.hints.dealbreaker}`,
    '',
    `libido ${seed.libido}/5, sexual confidence ${seed.sexual_confidence}/5, dom-sub ${seed.dom_sub_leaning}, sexting readiness ${seed.sexting_readiness}/5`,
    `fetishes: ${labels('fetish', seed.fetishes)}`,
    `hard limits: ${labels('hard_limit', seed.hard_limits)}`,
  ];
  return lines.join('\n');
}

function allowedSwapList(): string {
  return Object.keys(SWAPPABLE)
    .map((field) => `${field}: ${byCategory(field).map((a) => a.id).join(', ')}`)
    .join('\n');
}

const FALLBACK_NAMES = [
  'Mila', 'Lena', 'Sofia', 'Nora', 'Amara', 'Elif', 'Ines', 'Yara', 'Clara', 'Rosa',
  'Juno', 'Talia', 'Hana', 'Nina', 'Frida', 'Zoe', 'Maya', 'Alba', 'Nadia', 'Vera',
];

function fallbackUsername(name: string): string {
  const suffixes = ['_xo', '.exe', '404', '_txt', 'hrs', '_jpg', 'ish', '__'];
  return `${name.toLowerCase()}${pickOne(suffixes)}`.slice(0, 18);
}


/**
 * Avatars before a photo is unlocked. Her own emoji comes from the Director pass; this is
 * the fallback for an offline generation or a model that returned something that was not an
 * emoji. It only aims to make her distinguishable in the match list, not to characterise
 * her - that is the model's job when it is reachable.
 */
const FALLBACK_EMOJI = [
  '🦊', '🌙', '🍒', '🐍', '⚡', '🌵', '🦢', '🍋', '🎧', '🧨',
  '🪩', '🐝', '🌶️', '🦑', '🎸', '🫧', '🪬', '🦉', '🍄', '🧿',
  '🐙', '🌊', '🦩', '☕', '🧷', '🪐', '🥀', '🎲', '🦇', '🍷',
];

/** Stable per character, so she does not change face between restarts. */
function fallbackEmoji(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_EMOJI[hash % FALLBACK_EMOJI.length];
}

/**
 * Her avatar emoji, resolved at read time rather than baked in at generation: characters
 * made before this existed get a stable one too, and the fallback keys off her id rather
 * than her handle. Handles are not unique at the point the seed is written - the final one
 * is settled during the insert, and a model that hands back the same username twice would
 * otherwise give both characters the same face.
 */
export function avatarEmojiFor(character: Character): string {
  return character.seed.avatar_emoji ?? fallbackEmoji(character.id);
}

/**
 * Models asked for an emoji will sometimes answer ":)", "U+1F98A" or "a fox". Anything with
 * letters or digits in it is one of those, and anything with no pictographic character in it
 * is not an emoji either.
 */
function sanitizeEmoji(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 12) return null;
  if (/[A-Za-z0-9]/.test(s)) return null;
  if (!/\p{Extended_Pictographic}/u.test(s)) return null;
  return s;
}

interface DirectorPass {
  swaps?: { field: string; to: string; why?: string }[];
  real_name?: string;
  username?: string;
  avatar_emoji?: string;
  one_line?: string;
  insecurity_detail?: string;
  search_motive_detail?: string;
  touchstone_detail?: string;
  director_intent?: string;
  opening_plan?: { text: string; expires_when: string };
  online_times?: OnlineWindow[];
}

function sanitizeOnlineTimes(windows: OnlineWindow[] | undefined): OnlineWindow[] | null {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  const { from, to } = getSettings().server_window;
  const clean = windows
    .filter((w) => typeof w?.weekday === 'number' && /^\d{2}:\d{2}$/.test(w.from) && /^\d{2}:\d{2}$/.test(w.to))
    .map((w) => ({ weekday: ((w.weekday % 7) + 7) % 7, from: w.from, to: w.to }))
    .filter((w) => w.from < w.to)
    // keep windows inside the server uptime window; the simple case is from < to
    .filter((w) => (from <= to ? w.from >= from && w.to <= to : w.from >= from || w.to <= to));
  return clean.length ? clean : null;
}

/** One cheap, targeted re-ask for a name that landed on one already in the cast. */
async function rerollName(
  seed: CharacterSeed,
  rejected: string,
  clash: string,
  takenNames: string[],
): Promise<string | null> {
  try {
    const out = await completeJson<{ real_name?: string }>({
      scope: 'generator',
      label: 'reroll_name',
      config: { ...getSettings().models.actor, max_tokens: 120 },
      messages: [
        {
          role: 'user',
          content: [
            `Pick a different first name for a ${seed.age} year old woman who speaks ${seed.languages.join(', ')}.`,
            '',
            `"${rejected}" is not usable: "${clash}" is already in the cast and they read as the same name.`,
            'Names already used, none of which yours may repeat or closely resemble:',
            takenNames.map((n) => `- ${n}`).join('\n') || '(none yet)',
            '',
            'Her languages are a soft hint at where she or her family are from, and her age says which',
            'names were being given out when she was born. Lean on both, then go further afield than the',
            'first name that comes to mind - that one is almost certainly already on the list above.',
            '',
            'Reply with exactly one JSON object and nothing else: { "real_name": "..." }',
          ].join('\n'),
        },
      ],
    });
    const cleaned = (out.real_name ?? '').trim().split(/\s+/)[0] ?? '';
    if (cleaned.length < 2) return null;
    return nearestName(cleaned, takenNames) ? null : cleaned;
  } catch (err) {
    logger.warn('generator', 'name reroll failed, keeping the original', { error: String(err) });
    return null;
  }
}

/**
 * Her handle, written last and by the actor model, against the finished character rather
 * than a half-built one. It used to come out of the coherence pass alongside her name and
 * her stats, which meant it was being invented before there was much of a person for it to
 * belong to - and a handle is one of the few things on a profile she actually chose.
 */
async function writeUsername(seed: CharacterSeed, realName: string, taken: string[]): Promise<string> {
  let correction: string | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prompt = [
        'Pick the dating-app handle this woman would actually have. This is the adult hookup app',
        'she is on, and the handle sits next to her bio as the only things anyone sees before',
        'swiping.',
        '',
        describeSeed(seed),
        '',
        'Work out what SHE would have typed into the box. Some people are obvious and say exactly',
        'who they are; some pick something nobody else could decode; some are still using a handle',
        'they made at sixteen; some use a word they like, a mangled surname, an inside joke, a place,',
        'a number that means something to them. A guarded woman and a loud one do not pick the same',
        'kind of handle. There is no house style to match and nothing has to be clever.',
        '',
        'Rules, and only these: lowercase, 4-18 characters, letters with optional numbers, dots or',
        `underscores. Not "${realName}" spelled out plainly.`,
        '',
        'These handles are already taken. Yours must not share a word with any of them, rework one,',
        'or follow the same construction:',
        taken.map((u) => `- @${u}`).join('\n') || '(none yet)',
        '',
        'Reply with exactly one JSON object and nothing else: { "username": "..." }',
      ].join('\n');

      const out = await completeJson<{ username?: string }>({
        scope: 'generator',
        label: attempt ? 'write_username:retry' : 'write_username',
        config: { ...getSettings().models.actor, max_tokens: 120 },
        messages: correction
          ? [{ role: 'user', content: prompt }, { role: 'user', content: correction }]
          : [{ role: 'user', content: prompt }],
      });

      const cleaned = cleanHandle(out.username);
      if (cleaned.length < 4) continue;

      const clash = nearestHandle(cleaned, taken);
      if (clash && attempt < 2) {
        logger.warn('generator', 'handle reads as a variant of an existing one, re-asking', { cleaned, clash });
        correction =
          `"${cleaned}" is too close to "@${clash}", which is already taken - it reuses its words or its ` +
          `shape. Pick something that starts from a different part of her entirely. Same JSON, nothing else.`;
        continue;
      }
      // A last-attempt near-miss is still kept: it beats the digit suffix insertCharacter
      // would otherwise staple on, and only an exact match actually triggers that.
      return cleaned;
    } catch (err) {
      logger.warn('generator', 'username generation failed, using fallback', { error: String(err) });
      break;
    }
  }
  return fallbackUsername(realName);
}

export async function generateCharacter(): Promise<Character> {
  const { seed, fieldIds } = rollSeed();
  const settings = getSettings();
  const takenHandles = existingUsernames();
  const takenNames = existingNames();
  let pass: DirectorPass = {};

  try {
    pass = await completeJson<DirectorPass>({
      scope: 'generator',
      label: 'generate_character',
      // Writing a character is a creative job, not an analytical one, so it goes to the
      // actor model like the bio does. The director model is picked for being cheap and
      // is typically also the censored one, which makes it a poor choice for something
      // that has to take a seed full of explicit traits seriously rather than sand them
      // down. The director still runs the game; it just does not invent the cast.
      config: { ...settings.models.actor, max_tokens: 1200 },
      messages: [
        {
          role: 'user',
          content: render('director_generate_character', {
            rolled_block: describeSeed(seed),
            age: seed.age,
            server_window: `${settings.server_window.from}-${settings.server_window.to}`,
            allowed_swaps: allowedSwapList(),
            avoid_names: takenNames.length ? takenNames.map((n) => `- ${n}`).join('\n') : '(none yet)',
          }),
        },
      ],
    });
  } catch (err) {
    logger.warn('generator', 'director coherence pass failed, using raw roll', { error: String(err) });
  }

  // 3. coherence correction: at most two swaps, only in swappable fields
  for (const swap of (pass.swaps ?? []).slice(0, 2)) {
    const category = SWAPPABLE[swap?.field];
    if (!category) continue;
    const replacement = find(category, swap.to);
    if (!replacement) continue;
    (seed as any)[swap.field] = replacement.id;
    seed.hints[swap.field] = hintOf(replacement);
    fieldIds[swap.field] = replacement.id;
    logger.debug('generator', `swapped ${swap.field} -> ${swap.to}`, { why: swap.why });
  }
  seed.appearance_prompt = buildAppearancePrompt(seed);

  const online = sanitizeOnlineTimes(pass.online_times);
  if (online) seed.online_times = online;

  let realName = (pass.real_name ?? '').trim().split(/\s+/)[0] || pickOne(FALLBACK_NAMES);
  const nameClash = nearestName(realName, takenNames);
  if (nameClash) {
    logger.warn('generator', 'name too close to one already in the cast, re-asking', { realName, nameClash });
    const fresh = await rerollName(seed, realName, nameClash, takenNames);
    if (fresh) realName = fresh;
  }

  if (pass.insecurity_detail) seed.hints.insecurity = pass.insecurity_detail;
  if (pass.search_motive_detail) seed.hints.search_motive = pass.search_motive_detail;
  if (pass.touchstone_detail) seed.hints.touchstone = pass.touchstone_detail;
  if (pass.one_line) seed.hints.one_line = pass.one_line;

  // The handle is picked last, once she is a finished person, so it can actually be hers -
  // an inside joke, a mangled surname, or something completely opaque. The final collision
  // check still happens inside insertCharacter, which is the only place it can be done
  // atomically with the write.
  const username = await writeUsername(seed, realName, takenHandles);
  // Only stored when the model actually chose one; otherwise avatarEmojiFor() derives it.
  const chosenEmoji = sanitizeEmoji(pass.avatar_emoji);
  if (chosenEmoji) seed.avatar_emoji = chosenEmoji;

  const character: Character = {
    id: randomUUID(),
    username,
    real_name: realName,
    bio: '',
    created_at: nowIso(),
    state: 'pool',
    seed,
    reappear_at: null,
    rejection_count: 0,
    matched_at: null,
  };

  character.bio = await writeBio(character);

  insertCharacter(character);
  createRelationship(character.id, {
    director_notes: {
      intent: pass.director_intent ?? '',
      plans: pass.opening_plan?.text ? [pass.opening_plan] : [],
    },
  });

  logger.info('generator', `generated ${username} (${realName})`, {
    id: character.id,
    archetype: seed.archetype,
    bio: character.bio,
  });
  return character;
}

/** Only used when no model is reachable, so the stack is still browsable offline. */
/**
 * The emergency pool, used only when the API fails outright. Deliberately varied in SHAPE,
 * not just in wording: these were previously twelve versions of one three-beat structure
 * (quirky detail / blunt want / sign-off), and because the bio prompt's examples had been
 * lifted straight out of this list, that one shape was being taught to the model as well as
 * shipped on failure. Run-ons, fragments, one-liners and a properly-punctuated one all
 * belong here, or the fallback quietly becomes the house style again.
 */
const FALLBACK_BIOS = [
  'night shifts so my body clock is a joke. i am awake when nobody else is and it has made me strange about it. anyway. if you are also up at 4am we should probably do something about that',
  'ask me about bread\nno seriously. ask me about bread\nthen ask me what else im good with my hands at, ill wait',
  'good at: remembering birthdays, parallel parking, being blunt about this bit\nbad at: mornings, small talk, pretending i want a boyfriend',
  'I am told I write like a woman who owns a label maker. I do own a label maker. I also know exactly what I want out of this and I am not going to be shy about it, so please keep up.',
  'newly single, making up for lost time, sorry in advance',
  'ppl assume im quiet\nim not quiet. im picky\nthose r different and youll find out which one applies to u fairly quickly',
  'whats the point of the gym if nobody ever sees it. genuine question. i have been going for four years and the answer is increasingly you, apparently',
  'not looking for a bf. looking for a regular. theres a difference and ill explain it to u slowly if ur struggling',
  'my flatmates cat has decided this bio is his and honestly he has more personality than most of u so ive left it. he says hi. i say come over',
  'i will remember one weird detail about u for years and cannot remember where my keys are. say something filthy and specific and watch it get filed permanently',
  'here for sex. decent company either side of it. not interested in a three week warm up. what are u into',
  'ive rewritten this six times which probably tells u everything\nim funnier in person\nim also worse in person, depending what ur after',
];

/**
 * Every bio still in the app, not just the ones sitting unswiped in the pool. The old
 * filter excluded matched characters, which meant the bios the player has actually read
 * closely were the only ones a new character was free to imitate.
 */
function recentBios(limit = 30): string[] {
  const rows = db
    .prepare(`SELECT bio FROM characters WHERE bio != '' ORDER BY rowid DESC LIMIT ?`)
    .all(limit) as { bio: string }[];
  return rows.map((r) => r.bio);
}

/**
 * Normalise a handle the model gave us. Over-length ones are cut back to a separator rather
 * than mid-word, because "genuinely.differen" looks like a glitch, which is the opposite of
 * the point - a handle should always look like something a person chose.
 */
function cleanHandle(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._]/g, '');
  if (s.length <= 18) return s;
  const cut = s.slice(0, 18);
  const boundary = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('_'));
  const trimmed = boundary >= 4 ? cut.slice(0, boundary) : cut;
  return trimmed.replace(/[._]+$/, '');
}

function existingNames(limit = 40): string[] {
  const rows = db
    .prepare(`SELECT real_name FROM characters WHERE real_name != '' ORDER BY rowid DESC LIMIT ?`)
    .all(limit) as { real_name: string }[];
  return rows.map((r) => r.real_name);
}

/**
 * Names had no protection of any kind - whatever the model said was kept. Asked for "a first
 * name that fits her" with no knowledge of the rest of the cast, a model goes to its priors
 * every single time, which is why the stack fills up with four variations on the same handful
 * of names. Matching is loose on purpose: Lena/Lena is the obvious case, but Mila/Mia and
 * Sofia/Sophia are the ones that actually make the cast feel small.
 */
function nearestName(name: string, existing: string[]): string | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z]/g, '');
  const a = norm(name);
  if (!a) return null;
  for (const prior of existing) {
    const b = norm(prior);
    if (!b) continue;
    if (a === b) return prior;
    // Same start and near-identical length reads as a variant spelling of one name.
    if (Math.abs(a.length - b.length) <= 1 && a.slice(0, 3) === b.slice(0, 3)) return prior;
  }
  return null;
}

function existingUsernames(limit = 40): string[] {
  const rows = db
    .prepare(`SELECT username FROM characters ORDER BY rowid DESC LIMIT ?`)
    .all(limit) as { username: string }[];
  return rows.map((r) => r.username);
}

/**
 * The words in a handle, with the separators thrown away. "late.bloomer" and "latebloomer"
 * and "bloomer_late" are the same idea wearing different punctuation, and a uniqueness check
 * that only compares whole strings lets all three through.
 */
function handleParts(username: string): string[] {
  return username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\d+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Whether a handle reads as a variation on one that already exists - a shared distinctive
 * word, or the same letters rearranged. Exact-match uniqueness was never the problem: the
 * pool filling up with six handles built from the same two nouns is.
 */
function nearestHandle(username: string, existing: string[]): string | null {
  const parts = new Set(handleParts(username));
  const flat = username.toLowerCase().replace(/[^a-z]/g, '');
  if (!flat) return null;
  for (const prior of existing) {
    if (prior === username) return prior;
    const priorFlat = prior.toLowerCase().replace(/[^a-z]/g, '');
    if (priorFlat && priorFlat === flat) return prior;
    for (const part of handleParts(prior)) if (parts.has(part)) return prior;
  }
  return null;
}

/** The first few words, which is where a repeated bio gives itself away fastest. */
function bioOpening(bio: string): string {
  return bio.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
}

/**
 * Asking a model not to repeat itself is necessary but not sufficient - it has no memory of
 * the other calls and will drift back to whatever phrasing it likes. This is the backstop
 * that makes "do not repeat these" actually mean something: the bio is compared against the
 * ones that already exist and sent back if it landed on the same words or the same opening.
 *
 * Deliberately a check and not a constraint. Nothing here tells her how a bio should be
 * shaped - it only refuses one that has already been written.
 */
function nearestBio(bio: string, existing: string[]): string | null {
  const opening = bioOpening(bio);
  for (const prior of existing) {
    if (textOverlap(bio, prior) > 0.45) return prior;
    if (opening && opening === bioOpening(prior)) return prior;
  }
  return null;
}

const BIO_MIN_WORDS = 14;
const BIO_MAX_WORDS = 75;

function bioWordCount(bio: string): number {
  return bio.trim().split(/\s+/).filter(Boolean).length;
}

async function writeBio(character: Character): Promise<string> {
  const settings = getSettings();
  const existing = recentBios();
  const prompt = render('director_write_bio', {
    username: character.username,
    seed_block: describeSeed(character.seed),
    avoid_bios: existing.length ? existing.map((b) => `- ${b}`).join('\n') : '(none yet)',
  });

  // A model told to be pithy will happily answer with four words, which is not a bio -
  // it is a fortune cookie, and nobody can decide whether to swipe on it. Retries also
  // cover a bio that came back too close to one that already exists.
  let correction: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await completeJson<{ bio: string }>({
        scope: 'generator',
        label: attempt ? 'write_bio:retry' : 'write_bio',
        // The bio is in-voice writing rather than analysis, so it goes to the actor model.
        // The director still designs the character; it just does not write her lines.
        config: { ...settings.models.actor, max_tokens: 400 },
        messages: correction
          ? [{ role: 'user', content: prompt }, { role: 'user', content: correction }]
          : [{ role: 'user', content: prompt }],
      });
      const bio = (out.bio ?? '').trim();
      if (!bio) continue;

      const words = bioWordCount(bio);
      if (words < BIO_MIN_WORDS) {
        logger.warn('generator', `bio too short (${words} words), re-requesting`, { bio });
        correction =
          `That is ${words} words. It reads as cryptic rather than interesting, and nobody can decide ` +
          `whether to swipe on it. Write a new one, ${BIO_MIN_WORDS}-60 words over two to four lines, ` +
          `that leaves a stranger with a real sense of what she is like and how she spends her time. ` +
          `Same JSON, nothing else.`;
        continue;
      }
      if (words > BIO_MAX_WORDS) {
        logger.warn('generator', `bio too long (${words} words), trimming`, { bio });
        return bio.split(/\n/).slice(0, 4).join('\n').slice(0, 500);
      }

      const clash = nearestBio(bio, existing);
      if (clash) {
        if (attempt < 2) {
          logger.warn('generator', 'bio too close to an existing one, re-requesting', { bio, clash });
          correction =
            `That is too close to a bio already in the app:\n"${clash}"\n\n` +
            `It reuses its words, its opening or its joke. Throw it away and write a different one for ` +
            `this same woman - a different angle on her, a different thing to lead with, a different ` +
            `shape on the page. Same JSON, nothing else.`;
          continue;
        }
        // Out of retries and it is still a near-duplicate. Kept rather than swapped for a
        // hardcoded fallback: those are a fixed pool of twelve, so leaning on them is how the
        // cast converges for real. Logged loudly instead, because a model that cannot get
        // clear of the existing bios after three goes is worth knowing about.
        logger.warn('generator', 'bio still resembles an existing one after 3 attempts, keeping it', { bio, clash });
      }
      return bio.slice(0, 500);
    } catch (err) {
      logger.warn('generator', 'bio generation failed, using fallback', { error: String(err) });
      break;
    }
  }

  const unused = FALLBACK_BIOS.filter((b) => !existing.includes(b));
  return pickOne(unused.length ? unused : FALLBACK_BIOS);
}
