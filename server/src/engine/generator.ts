import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { db, nowIso } from '../db/index.js';
import { byCategory, find, type Attribute } from '../db/attributes.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import { insertCharacter, createRelationship } from '../repo.js';
import type { Character, CharacterSeed, OnlineWindow, Thresholds } from '../types.js';
import { drawCount, newContext, pickOne, randInt, roll, rollMany, rollRange, type DiceContext } from './dice.js';

/** Fields the Director may swap during the coherence pass. */
const SWAPPABLE: Record<string, string> = {
  clothing_style: 'clothing_style',
  grooming: 'grooming',
  makeup_style: 'makeup_style',
  hair_style: 'hair_style',
  hair_color: 'hair_color',
  occupation: 'occupation',
  living_situation: 'living_situation',
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

/**
 * Thresholds spread widely on purpose: every character is her own puzzle. The openness
 * curve and archetype nudge the centre, the dice do the rest.
 */
function rollThresholds(archetype: string, openness: string): Thresholds {
  let shift = 0;
  if (openness === 'slow_steady') shift += 8;
  if (openness === 'fast_then_plateau') shift -= 6;
  if (archetype === 'shy' || archetype === 'guarded') shift += 10;
  if (archetype === 'confident' || archetype === 'flirty') shift -= 8;

  const at = (min: number, max: number, weight = 1) =>
    Math.max(2, Math.min(98, randInt(min, max) + Math.round(shift * weight)));

  return {
    real_name: at(8, 45),
    profile_picture: at(12, 55),
    personal_photos: at(30, 75),
    sexual_topics: at(25, 80, 1.2),
    spicy_photos: at(55, 95, 1.2),
    allow_date: at(35, 80),
  };
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

export function rollSeed(): RolledSeed {
  const ctx = newContext();
  const fieldIds: Record<string, string> = {};

  // 1. archetype first - it re-weights every other table
  const archetype = roll('archetype', ctx)!;
  const extra = archetype.extra ?? {};
  ctx.weights = { ...(extra.weights ?? {}) };
  ctx.drawn.add(archetype.id);
  const counts = extra.counts ?? {};
  const ranges = extra.ranges ?? {};

  const one = (category: string, opts: { ignoreArchetype?: boolean } = {}) => {
    const a = roll(category, ctx, opts);
    if (a) fieldIds[category] = a.id;
    return a;
  };

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

  const piercingCount = drawCount(counts.piercings, 1);
  const piercings = Array.from({ length: piercingCount }, () => ({
    type: roll('piercing_type', ctx, { transient: true })?.id ?? 'stud',
    position: roll('piercing_position', ctx, { transient: true })?.id ?? 'earlobe',
  }));

  const accessories = rollMany('accessory', ctx, drawCount(counts.accessories, 1)).map((a) => a.id);

  // personality
  const attachment_style = one('attachment_style');
  const humor_type = one('humor_type');
  const conflict_style = one('conflict_style');
  const insecurity = one('insecurity');
  const quirks = rollMany('quirk', ctx, drawCount(counts.quirks, 2)).map((a) => a.id);

  const opennessFromArchetype = (archetype.modifies as any)?.openness_curve as string | undefined;
  const openness_curve = opennessFromArchetype ?? roll('openness_curve', ctx)!.id;

  // communication
  const typing_style = one('typing_style');
  const emoji_usage = one('emoji_usage');
  const emojiCount = emoji_usage?.id === 'none' ? 0 : emoji_usage?.id === 'heavy' ? randInt(2, 3) : randInt(0, 2);
  const favorite_emojis = rollMany('favorite_emoji', ctx, emojiCount).map((a) => a.extra?.char ?? a.label);
  const message_length = one('message_length');
  const speedFromArchetype = (archetype.modifies as any)?.response_speed as string | undefined;
  const response_speed = speedFromArchetype ?? roll('response_speed', ctx)!.id;
  const voice_msg_tendency = one('voice_msg_tendency');
  const slang_register = one('slang_register');

  // life
  const occupation = one('occupation');
  const living_situation = one('living_situation');
  const relationship_history = one('relationship_history');
  const dating_experience = one('dating_experience');
  const social_energy = one('social_energy');
  const interests = rollMany('interest', ctx, drawCount(counts.interests, 3)).map((a) => a.id);
  const hobbies = rollMany('hobby', ctx, drawCount(counts.hobbies, 2)).map((a) => a.id);
  const extraLanguages = rollMany('language', ctx, drawCount(counts.languages, 0)).map((a) => a.id);

  // gameplay - deliberately rolled WITHOUT the archetype filter so she can surprise
  const search_motive = roll('search_motive', ctx, { ignoreArchetype: true })!;
  const touchstone = roll('touchstone', ctx, { ignoreArchetype: true })!;
  const turn_ons = rollMany('turn_on', ctx, randInt(2, 4), { ignoreArchetype: true }).map((a) => a.id);
  const turn_offs = rollMany('turn_off', ctx, drawCount(counts.turn_offs, 2), { ignoreArchetype: true }).map((a) => a.id);
  const green_flags = rollMany('green_flag', ctx, drawCount(counts.green_flags, 2)).map((a) => a.id);
  const dealbreaker = roll('dealbreaker', ctx)!;

  // sexual
  const libido = rollRange(ranges.libido, 1, 5);
  const sexual_confidence = rollRange(ranges.sexual_confidence, 1, 5);
  const dom_sub_leaning = rollRange(ranges.dom_sub_leaning, -3, 3);
  const sextingMod = Number((archetype.modifies as any)?.sexting_readiness ?? 0);
  const sexting_readiness = Math.max(1, Math.min(5, rollRange(ranges.sexting_readiness, 1, 5) + sextingMod));
  const fetishes = rollMany('fetish', ctx, drawCount(counts.fetishes, 3)).map((a) => a.id);
  const hard_limits = rollMany('hard_limit', ctx, drawCount(counts.hard_limits, 2)).map((a) => a.id);

  const age = rollAge();

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

    thresholds: rollThresholds(archetype.id, openness_curve),
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


interface DirectorPass {
  swaps?: { field: string; to: string; why?: string }[];
  real_name?: string;
  username?: string;
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

export async function generateCharacter(): Promise<Character> {
  const { seed, fieldIds } = rollSeed();
  const settings = getSettings();
  let pass: DirectorPass = {};

  try {
    pass = await completeJson<DirectorPass>({
      scope: 'generator',
      label: 'generate_character',
      config: settings.models.director,
      messages: [
        {
          role: 'user',
          content: render('director_generate_character', {
            rolled_block: describeSeed(seed),
            age: seed.age,
            server_window: `${settings.server_window.from}-${settings.server_window.to}`,
            allowed_swaps: allowedSwapList(),
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

  const realName = (pass.real_name ?? '').trim().split(/\s+/)[0] || pickOne(FALLBACK_NAMES);
  // The final handle is settled by insertCharacter, which can only do it collision-free
  // in the same synchronous step as the write.
  const username =
    (pass.username ?? '').trim().toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 18) ||
    fallbackUsername(realName);

  if (pass.insecurity_detail) seed.hints.insecurity = pass.insecurity_detail;
  if (pass.search_motive_detail) seed.hints.search_motive = pass.search_motive_detail;
  if (pass.touchstone_detail) seed.hints.touchstone = pass.touchstone_detail;
  if (pass.one_line) seed.hints.one_line = pass.one_line;

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

/**
 * Structural shapes for the bio. Picked per character so the swipe stack does not read
 * like twelve variations of one joke - a cheap model left to its own devices will happily
 * write the same bio twelve times.
 */
interface BioFormat {
  hint: string;
  /** Archetypes this shape would be out of character for. */
  notFor?: string[];
}

const BIO_FORMATS: BioFormat[] = [
  { hint: 'One flat, oddly specific statement about her life. No punchline, no explanation, no follow-up.' },
  { hint: 'Two or three unrelated things, listed without any framing. The gaps between them do the work.' },
  { hint: 'A question aimed straight at whoever is reading it, specific enough that a lazy answer is obviously lazy.' },
  { hint: 'A small confession she is faintly embarrassed by, stated plainly and not apologised for.' },
  { hint: 'A condition for anyone thinking about swiping right. Dry, not aggressive.', notFor: ['shy', 'earnest', 'dreamy'] },
  { hint: 'One sentence from her actual week, dropped in with no conclusion drawn from it.' },
  { hint: 'A deadpan understatement about something that is obviously a big deal.', notFor: ['earnest'] },
  { hint: 'An opinion held far too strongly about something completely trivial.' },
  { hint: 'Two lines that quietly contradict each other. She does not acknowledge it.' },
  { hint: 'Something she wants, phrased so specifically that it is almost a joke, except she means it.' },
  { hint: 'A self-aware line about being on this app at all, without being bitter about it.' },
  { hint: 'One detail about her flat, her commute or her job that implies everything else.' },
  { hint: 'An unfinished thought. It stops before the point, on purpose.', notFor: ['confident', 'ambitious'] },
  { hint: 'A very short, very sincere sentence with nothing hiding behind it.', notFor: ['sarcastic', 'guarded'] },
];

/** Shapes used for the last few characters, so the stack rotates through them. */
const recentFormats: string[] = [];

function pickBioFormat(archetype: string): string {
  const inCharacter = BIO_FORMATS.filter((f) => !f.notFor?.includes(archetype));
  const pool = inCharacter.length ? inCharacter : BIO_FORMATS;
  const fresh = pool.filter((f) => !recentFormats.includes(f.hint));
  const chosen = pickOne(fresh.length ? fresh : pool).hint;
  recentFormats.push(chosen);
  if (recentFormats.length > 6) recentFormats.shift();
  return chosen;
}

/** Only used when no model is reachable, so the stack is still browsable offline. */
const FALLBACK_BIOS = [
  'my flatmate thinks i am at the gym right now',
  'i will need you to have an opinion about something',
  'three cancelled plans deep into this week and it is tuesday',
  'ask me about the spreadsheet. do not ask me about the spreadsheet',
  'i am the person who reads the plaque in the museum',
  'currently avoiding something important by being here',
  'i peaked at a pub quiz in 2019 and never recovered',
  'looking for someone to be unreasonable about small things with',
  'i have opinions about bread now. this is where i am',
  'the last four books i bought are still in the bag',
  'yes i have seen it. no i did not like it',
  'i talk to the bus driver. that is the kind of person i am',
  'my camera roll is 90 percent other people\'s dogs',
  'i keep a list. you would be on the list',
];

function recentBios(limit = 12): string[] {
  const rows = db
    .prepare(
      `SELECT bio FROM characters WHERE bio != '' AND state IN ('pool','swiped_left')
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(limit) as { bio: string }[];
  return rows.map((r) => r.bio);
}

async function writeBio(character: Character): Promise<string> {
  const settings = getSettings();
  const existing = recentBios();
  try {
    const out = await completeJson<{ bio: string }>({
      scope: 'generator',
      label: 'write_bio',
      // The bio is in-voice writing rather than analysis, so it goes to the actor model.
      // The director still designs the character; it just does not write her lines.
      config: { ...settings.models.actor, max_tokens: 300 },
      messages: [
        {
          role: 'user',
          content: render('director_write_bio', {
            username: character.username,
            seed_block: describeSeed(character.seed),
            format_hint: pickBioFormat(character.seed.archetype),
            avoid_bios: existing.length ? existing.map((b) => `- ${b}`).join('\n') : '(none yet)',
          }),
        },
      ],
    });
    const bio = (out.bio ?? '').trim();
    if (bio) return bio.slice(0, 220);
  } catch (err) {
    logger.warn('generator', 'bio generation failed, using fallback', { error: String(err) });
  }
  const unused = FALLBACK_BIOS.filter((b) => !existing.includes(b));
  return pickOne(unused.length ? unused : FALLBACK_BIOS);
}
