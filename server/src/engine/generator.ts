import { randomUUID } from 'node:crypto';
import { getSettings } from '../config.js';
import { db, nowIso } from '../db/index.js';
import { byCategory, find, RARITY_WEIGHT, type Attribute } from '../db/attributes.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import {
  AGE_FLOOR, createRelationship, getUserProfile, insertCharacter, preferredAgeRange, saveRelationship,
} from '../repo.js';
import type { Character, CharacterSeed, KinkStance, OnlineWindow } from '../types.js';
import { drawCount, newContext, pickOne, randInt, roll, rollMany, rollRange, type DiceContext } from './dice.js';
import { buildCatalogue, detectMentions, recordDiscoveries } from './discovery.js';
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

/**
 * Her age, drawn inside whatever band he asked for in his profile (18-42 by default).
 * Two draws averaged give a triangular curve rather than a flat one, so the middle of the
 * band is common and its edges are not - the same shape the fixed 18-42 roll had, just
 * rescaled to fit. The 18 floor is enforced here as well as at the profile, because this
 * is the last place it can be got wrong.
 */
function rollAge(): number {
  const { min, max } = preferredAgeRange();
  const lo = Math.max(AGE_FLOOR, min);
  const hi = Math.max(lo, max);
  const span = hi - lo;
  return lo + Math.round((randInt(0, span) + randInt(0, span)) / 2);
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
 * Which orientations could plausibly be interested in this user. Everyone generated here is
 * a woman, so what varies is whether she is into men, women or both - and a dating app does
 * not show you people who are not into you at all.
 */
export function compatibleOrientations(): Attribute[] {
  const gender = getUserProfile()?.gender ?? '';
  const bucket = gender === 'man' ? 'men' : gender === 'woman' ? 'women' : 'enby';
  const all = byCategory('orientation');
  const fits = all.filter((o) => ((o.extra?.attracted_to as string[]) ?? []).includes(bucket));
  // A user who did not state a gender still needs a stack; the orientations that are not
  // defined by binary attraction are the honest answer there rather than showing nobody.
  return fits.length ? fits : all.filter((o) => ((o.extra?.attracted_to as string[]) ?? []).length > 1);
}

/**
 * How far out she goes in general, 0-5. Her sexual stats carry it, with the archetype
 * nudging: the same libido reads differently on someone reckless than on someone careful.
 * This is deliberately not a sixth stat to tune - it is derived, so it cannot drift out of
 * step with the three it comes from.
 */
function rollFreak(libido: number, confidence: number, sexting: number, archetype: string): number {
  const base = (libido + confidence + sexting) / 3;
  let shift = 0;
  if (['chaotic', 'provocateur', 'menace', 'deadpan_menace', 'flirty'].includes(archetype)) shift += 0.8;
  if (['shy', 'guarded', 'earnest', 'perfectionist', 'still_water'].includes(archetype)) shift -= 0.7;
  const jitter = Math.random() * 1.4 - 0.7;
  return Math.max(0, Math.min(5, Math.round((base + shift + jitter) * 10) / 10));
}

/**
 * Her standing position on every kink domain, decided before any specific fetish is drawn.
 *
 * The point is that the general view comes first and the specifics live inside it. Fetishes
 * used to be drawn from all 183 rows independently of the 22 hard limits, so a character
 * could genuinely come out loving spanking and refusing all impact - the two tables never
 * consulted each other. Now a domain gets a stance, and both the fetishes and the limits are
 * drawn from that.
 *
 * `freak` decides how generous the stances are, and intensity gates the far end: a domain
 * marked intense is mostly off the table for someone who is not built for it, rather than
 * being impossible for anyone.
 */
function rollKinkMap(freak: number, domains: Attribute[]): Record<string, KinkStance> {
  const map: Record<string, KinkStance> = {};
  for (const d of domains) {
    const intensity = Number(d.extra?.intensity ?? 0);
    // Roughly: freak 0 says yes to almost nothing, freak 5 says yes to most of the
    // mainstream and a fair bit of the rest.
    const reach = freak - intensity * 1.7;
    const intoChance = Math.max(0.02, Math.min(0.6, 0.05 + reach * 0.115));
    const curiousChance = Math.max(0.05, Math.min(0.4, 0.12 + reach * 0.07));
    const r = Math.random();
    if (r < intoChance) map[d.id] = 'into';
    else if (r < intoChance + curiousChance) map[d.id] = 'curious';
    else {
      // A hard no is a real position, not just absence of interest, and it is much more
      // likely on the things she is furthest from.
      map[d.id] = Math.random() < 0.25 + intensity * 0.16 - freak * 0.04 ? 'hard_no' : 'soft_no';
    }
  }
  return map;
}

/**
 * Generation runs as a cascade rather than one flat roll, because the order is what makes a
 * character hold together. Each stage is drawn knowing the ones before it, via ctx.weights:
 *
 *   1. age and species    - the base, conditioned on nothing
 *   2. who she is         - archetype, personality, how she writes, her life
 *   3. what she looks like
 *   4. what she is into   - non-sexual
 *   5. the intimate half
 *
 * Languages come first because they are a soft stand-in for where she or her family are
 * from, which is what later makes a name plausible; age decides which lives are even
 * available to her. Rolling looks before personality, as this used to, meant appearance
 * could never reflect the person underneath - only the archetype could reach it.
 *
 * Species is rolled here too, before archetype, on purpose: almost everyone is human and it
 * changes nothing, but on the very rare roll that lands somewhere else, its own
 * extra.weights should be able to lean the archetype and everything after it (a dragonkin
 * leaning possessive, a fairy leaning free-spirited) the same way the archetype leans what
 * comes after it. Rolling it any later would mean her nature never actually touched who she
 * turned out to be.
 */
export function rollSeed(): RolledSeed {
  const ctx = newContext();
  const fieldIds: Record<string, string> = {};

  const one = (category: string, opts: { ignoreArchetype?: boolean } = {}) => {
    const a = roll(category, ctx, opts);
    if (a) fieldIds[category] = a.id;
    return a;
  };

  // ---- 1. the base: age and species, conditioned on nothing
  const age = rollAge();
  ctx.weights = { ...ctx.weights, ...ageWeights(age) };

  // Almost always human - see appearance.json's species entries for the actual calibration
  // (one heavily-weighted 'human' row against sixteen very_rare/extremely_rare ones). Rolled
  // with ignoreArchetype since nothing has set a personality yet to lean it.
  const species = roll('species', ctx, { ignoreArchetype: true })!;

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
  // Off extra.range rather than the id itself, so a new bucket between sparse and heavy
  // draws its own count instead of quietly landing on the sparse default.
  const [emojiMin, emojiMax] = (emoji_usage?.extra?.range as [number, number] | undefined) ?? [0, 2];
  const emojiCount = randInt(emojiMin, emojiMax);
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
  // Rolled here rather than up front, now that she has an ethnicity to draw from: a German
  // entry's extra.weights leans this toward german, a Brazilian one toward portuguese, and
  // so on, so who she is on paper actually shows up in what she speaks - not a hard rule
  // (english is still always first, and plenty of ids are deliberately left unweighted,
  // "white_european" and "mixed_race" among them, since no single language fits), just a
  // real thumb on the scale instead of a roll with no connection to her at all.
  const extraLanguages = rollMany('language', ctx, drawCount([0.55, 0.33, 0.12], 0)).map((a) => a.id);
  const skin_tone = one('skin_tone');
  const height = one('height');
  const body_type = one('body_type');
  const breast_size = one('breast_size');
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
  const orientation = roll('orientation', ctx, {
    only: new Set(compatibleOrientations().map((o) => o.id)),
  })!;
  const freak = rollFreak(libido, sexual_confidence, sexting_readiness, archetype.id);
  const arousal_tell = one('arousal_tell')!;
  const domains = byCategory('kink_domain');
  const kink_map = rollKinkMap(freak, domains);

  // Her named fetishes are drawn only from domains she is actually open to, and the
  // unmapped ones (kissing, massage, mornings - most of the table) stay available to
  // everyone. Being "into feet" now means the feet domain already said yes.
  const openIds = new Set<string>();
  for (const d of domains) {
    const stance = kink_map[d.id];
    if (stance === 'into' || stance === 'curious') {
      for (const f of (d.extra?.fetishes as string[]) ?? []) openIds.add(f);
    }
  }
  const claimed = new Set<string>(domains.flatMap((d) => (d.extra?.fetishes as string[]) ?? []));
  const allowedFetishes = new Set(
    byCategory('fetish').map((f) => f.id).filter((id) => openIds.has(id) || !claimed.has(id)),
  );
  const fetishes = rollMany('fetish', ctx, drawCount(counts.fetishes, 3), { only: allowedFetishes })
    .map((a) => a.id);

  // Limits come from the domains she is a hard no on, so they can never contradict a
  // fetish she was just given. The two limits no domain owns stay open to anyone.
  const limitIds = new Set<string>();
  for (const d of domains) {
    if (kink_map[d.id] === 'hard_no') for (const l of (d.extra?.limits as string[]) ?? []) limitIds.add(l);
  }
  // A limit can belong to more than one domain - "nothing that leaves marks" sits under
  // both impact and sharper sensation - so a single hard no is not enough to claim it. If
  // she is into ANY domain the limit would contradict, it is not one of her limits.
  for (const d of domains) {
    const st = kink_map[d.id];
    if (st !== 'into' && st !== 'curious') continue;
    for (const l of (d.extra?.limits as string[]) ?? []) limitIds.delete(l);
  }
  const ownedLimits = new Set<string>(domains.flatMap((d) => (d.extra?.limits as string[]) ?? []));
  for (const l of byCategory('hard_limit')) if (!ownedLimits.has(l.id)) limitIds.add(l.id);
  const hard_limits = rollMany('hard_limit', ctx, drawCount(counts.hard_limits, 2), { only: limitIds })
    .map((a) => a.id);

  const hints: Record<string, string> = {
    species: hintOf(species),
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
    orientation: hintOf(orientation),
    arousal_tell: hintOf(arousal_tell),
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
    species: species.id,
    ethnicity: ethnicity!.id,
    skin_tone: skin_tone!.id,
    height: height!.id,
    body_type: body_type!.id,
    breast_size: breast_size!.id,
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

    orientation: orientation.id,
    arousal_tell: arousal_tell.id,
    libido,
    sexual_confidence,
    dom_sub_leaning,
    sexting_readiness,
    freak,
    kink_map,
    fetishes,
    hard_limits,

    hints,
    appearance_prompt: '',
    image_seed: randInt(1, 2_000_000_000),
  };

  seed.appearance_prompt = buildAppearancePrompt(seed);
  return { seed, ctx, archetype, fieldIds };
}

/**
 * Every (category, id) pair a rolled seed is actually built from, under the same category
 * names rollSeed() itself rolled them under. Used only to grade how unusual a character is
 * as a whole (see rarityTier below) - nothing here decides gameplay, so a field this misses
 * only makes that grade a little less precise, never wrong.
 */
function seedAttributeIds(seed: CharacterSeed): { category: string; id: string }[] {
  const singular: [string, string][] = [
    ['species', seed.species], ['ethnicity', seed.ethnicity], ['skin_tone', seed.skin_tone], ['height', seed.height],
    ['body_type', seed.body_type], ['breast_size', seed.breast_size], ['hair_color', seed.hair_color],
    ['hair_style', seed.hair_style], ['eye_color', seed.eye_color], ['clothing_style', seed.clothing_style],
    ['grooming', seed.grooming], ['makeup_style', seed.makeup_style], ['distinctive_feature', seed.distinctive_feature],
    ['archetype', seed.archetype], ['attachment_style', seed.attachment_style], ['humor_type', seed.humor_type],
    ['conflict_style', seed.conflict_style], ['openness_curve', seed.openness_curve], ['insecurity', seed.insecurity],
    ['typing_style', seed.typing_style], ['emoji_usage', seed.emoji_usage], ['message_length', seed.message_length],
    ['response_speed', seed.response_speed], ['voice_msg_tendency', seed.voice_msg_tendency],
    ['slang_register', seed.slang_register], ['occupation', seed.occupation],
    ['living_situation', seed.living_situation], ['relationship_status', seed.relationship_status],
    ['relationship_history', seed.relationship_history], ['dating_experience', seed.dating_experience],
    ['social_energy', seed.social_energy], ['search_motive', seed.search_motive], ['touchstone', seed.touchstone],
    ['dealbreaker', seed.dealbreaker], ['orientation', seed.orientation], ['arousal_tell', seed.arousal_tell],
  ];
  const plural: [string, string[]][] = [
    ['quirk', seed.quirks], ['interest', seed.interests], ['hobby', seed.hobbies],
    ['turn_on', seed.turn_ons], ['turn_off', seed.turn_offs], ['green_flag', seed.green_flags],
    ['fetish', seed.fetishes], ['hard_limit', seed.hard_limits], ['accessory', seed.accessories],
    // English says nothing about her - everyone speaks it, and it has no row in the table.
    ['language', seed.languages.filter((l) => l !== 'english')],
  ];
  const out: { category: string; id: string }[] = [];
  for (const [category, id] of singular) if (id) out.push({ category, id });
  for (const [category, ids] of plural) for (const id of ids) out.push({ category, id });
  for (const t of seed.tattoos) {
    out.push({ category: 'tattoo_motif', id: t.motif });
    out.push({ category: 'tattoo_position', id: t.position });
  }
  for (const p of seed.piercings) {
    out.push({ category: 'piercing_type', id: p.type });
    out.push({ category: 'piercing_position', id: p.position });
  }
  return out;
}

/**
 * How unusual a character is as a whole, from the rarity tags on the attributes she rolled
 * alone - nothing about what any of them actually mean. That is what makes it safe to show
 * before a single message is sent: a "Rare" badge on the swipe card is a promise about the
 * shape of the dice roll, not a spoiler about her.
 *
 * Averaged as surprisal (-log2 of the rarity weight) rather than counting how many rare tags
 * she has: a character with forty common traits and one very rare one should read as mostly
 * ordinary with one striking thing about her, not get dragged up to "rare" by that one
 * outlier, and the average stays comparable even though how many traits get counted varies a
 * little from character to character.
 */
export type RarityTier = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'extremely_rare';

export function rarityScore(seed: CharacterSeed): number {
  const ids = seedAttributeIds(seed);
  if (!ids.length) return 0;
  const total = ids.reduce((sum, { category, id }) => {
    const weight = RARITY_WEIGHT[find(category, id)?.rarity ?? 'common'];
    return sum - Math.log2(weight);
  }, 0);
  return total / ids.length;
}

/**
 * Thresholds picked empirically (3000 rolled seeds, after the attribute database's rarity
 * tags were re-audited for the fifth tier) to land roughly 24% common / 42% uncommon /
 * 22% rare / 9% very rare / 3% extremely rare - a real, thin top tier, not something a third
 * of the stack claims.
 */
const RARITY_LABEL: Record<RarityTier, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  very_rare: 'Very rare',
  extremely_rare: 'Extremely rare',
};

export function rarityTier(seed: CharacterSeed): { tier: RarityTier; label: string } {
  const score = rarityScore(seed);
  const tier: RarityTier =
    score >= 0.46 ? 'extremely_rare' :
    score >= 0.40 ? 'very_rare' :
    score >= 0.33 ? 'rare' :
    score >= 0.24 ? 'uncommon' : 'common';
  return { tier, label: RARITY_LABEL[tier] };
}

/** Fixed appearance block assembled from the image_prompt fields of the appearance tags. */
export function buildAppearancePrompt(seed: CharacterSeed): string {
  const parts: string[] = [];
  const img = (cat: string, id: string) => find(cat, id)?.image_prompt;
  parts.push(`${seed.age} year old ${img('ethnicity', seed.ethnicity) ?? 'woman'}`);
  // A species with a permanent, unhideable tell (cat ears, a giant's actual scale, ...)
  // belongs in the fixed block like any other constant fact about her - see it early, since
  // it can dominate framing (a giantess or a fairy). A 'later'/'private'/'chat_only' species
  // is deliberately left out here: its tell is something she can conceal, or has none at all.
  // See blocks.ts's appearanceBlock() and images.ts's visibleMarks() for where those get
  // added only once she has actually chosen to reveal them.
  if (seed.species && seed.species !== 'human') {
    const species = find('species', seed.species);
    if (species?.extra?.visibility === 'profile' && species.image_prompt) {
      parts.push(species.image_prompt);
    }
  }
  for (const [cat, id] of [
    ['skin_tone', seed.skin_tone],
    ['height', seed.height],
    ['body_type', seed.body_type],
    ['breast_size', seed.breast_size],
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
  // Accessories are a multi-select (glasses, jewellery, a bag she's holding...), unlike
  // every category above - rolled as an array rather than one id, and previously never
  // reached the image prompt at all, so a character who rolled glasses would never
  // actually be drawn wearing them.
  for (const accessoryId of seed.accessories) {
    const v = img('accessory', accessoryId);
    if (v) parts.push(v);
  }
  return parts.filter(Boolean).join(', ');
}

export function describeSeed(seed: CharacterSeed): string {
  const label = (cat: string, id: string) => find(cat, id)?.label ?? id;
  const labels = (cat: string, ids: string[]) => ids.map((i) => label(cat, i)).join(', ') || 'none';
  const lines = [
    `age: ${seed.age}`,
    seed.species && seed.species !== 'human'
      ? `species: ${label('species', seed.species)} - ${seed.hints.species}`
      : `species: human`,
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
    `orientation: ${label('orientation', seed.orientation)} - ${seed.hints.orientation ?? ''}`,
    `how far she goes in general (0-5): ${seed.freak}`,
    `how it shows when she is turned on: ${label('arousal_tell', seed.arousal_tell)} - ${seed.hints.arousal_tell ?? ''}`,
    `where she stands on the usual kinks: ${
      Object.entries(seed.kink_map ?? {})
        .filter(([, st]) => st === 'into' || st === 'hard_no')
        .map(([d, st]) => `${label('kink_domain', d)} = ${st === 'into' ? 'into it' : 'hard no'}`)
        .join('; ') || 'nothing strong either way'
    }`,
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

/**
 * Never built from her real name - a handle exists precisely so a stranger cannot tell who
 * she is from it, and this is the path that runs with no model in the loop to catch that if
 * it were. Two generic parts stitched together instead, so the emergency case is still
 * varied without ever risking the one thing a handle is not allowed to leak.
 */
const FALLBACK_HANDLE_ROOTS = [
  'moonlit', 'quietstorm', 'nightowl', 'lowkey', 'faded', 'driftwood', 'restless', 'sundry',
  'lonestar', 'afterglow', 'wildflower', 'hazymorning', 'stray', 'undertow', 'paperplane',
  'greyscale', 'halflight', 'wanderer', 'saltwater', 'thornbird',
];
function fallbackUsername(): string {
  const suffixes = ['_xo', '.exe', '404', '_txt', 'hrs', '_jpg', 'ish', '__', String(randInt(10, 99))];
  return `${pickOne(FALLBACK_HANDLE_ROOTS)}${pickOne(suffixes)}`.slice(0, 18);
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
export function sanitizeEmoji(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 12) return null;
  if (/[A-Za-z0-9]/.test(s)) return null;
  if (!/\p{Extended_Pictographic}/u.test(s)) return null;
  return s;
}

interface DirectorPass {
  swaps?: { field: string; to: string; why?: string }[];
  real_name?: string;
  avatar_emoji?: string;
  one_line?: string;
  /**
   * The character written out in full prose from the rolled tags - who she is, how she
   * talks, what she is into, in a form a person could actually read. This is what
   * writeUsername and writeBio work from now, instead of the raw attribute dump: a handle
   * or a bio pulled from a spec sheet reads like it was assembled from a spec sheet, and
   * two women who rolled the same three tags produced suspiciously similar ones.
   */
  dossier?: string;
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
      config: { ...getSettings().models.actor, max_tokens: NAME_TOKENS },
      require: ['real_name'],
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
async function writeUsername(
  seed: CharacterSeed,
  realName: string,
  taken: string[],
  dossierIsReal: boolean,
): Promise<string> {
  // A degraded dossier is nothing but the raw "label - hint" attribute dump - asking a model
  // to pick a handle from that produces exactly the copied-wording problem this exists to
  // avoid. The curated fallback pool is a better bet than a handle assembled from a spec
  // sheet, and it is what a total API failure already falls back to a few lines down.
  if (!dossierIsReal) {
    logger.warn('generator', 'no real dossier to work from, using a fallback handle');
    return fallbackUsername();
  }

  let correction: string | null = null;
  /**
   * Only a sample reaches the prompt, though the whole list still decides the clash below.
   *
   * The instruction used to be "must not share a word with any of them, rework one, or follow
   * the same construction", against every handle in the cast. By the twentieth character that
   * forbids `_jpg`, `hrs`, `.exe`, `_xo`, `__`, `ish`, `404` and `_txt` at once - which is
   * most of the ways a handle is built - and the constraint tightens with every character
   * made. An ask that cannot be satisfied does not produce originality, it produces a refusal.
   * A short list still says "not these", and `nearestHandle` catches what slips through.
   */
  const shown = taken.slice(0, HANDLES_SHOWN);

  // The dossier now freely discusses a 'later'/'private'/'chat_only' species (see
  // director_generate_character.md's is_fantasy section) - so without an explicit guard here,
  // the same dossier text this prompt is built from could just as easily leak it into the
  // handle as into the name. A 'profile'-tier species has nothing to protect: it is visible
  // in any photo regardless, so a handle referencing it is a stylistic choice, not a leak.
  const species = seed.species && seed.species !== 'human' ? find('species', seed.species) : null;
  const hiddenSpecies = species && species.extra?.visibility !== 'profile' ? species.label.toLowerCase() : null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prompt = [
        'Pick the dating-app handle this woman would actually have. This is the adult hookup app',
        'she is on, and the handle sits next to her bio as the only things anyone sees before',
        'swiping.',
        '',
        seed.hints.dossier,
        '',
        'Work out what SHE would have typed into the box: some pick something nobody else could',
        'decode; some are still using a handle they made at sixteen; some use a word they like, a',
        'mangled surname that is not actually hers, an inside joke, a place, a number that means',
        'something to them. A guarded woman and a loud one do not pick the same kind of handle.',
        'There is no house style to match and nothing has to be clever.',
        '',
        'One thing every one of them has in common: a dating-app handle is anonymous by design,',
        'and hers is not the exception. Whoever she is, this cannot be a version of her actual name.',
        '',
        'Rules, and only these: lowercase, 4-18 characters, letters with optional numbers, dots or',
        `underscores. Must not contain her real name "${realName}" in any form - not spelled out, not`,
        'shortened, not as a prefix or suffix with numbers or symbols around it. It has to read as',
        'genuinely unconnected to her name, the way an actual anonymous handle is.',
        ...(hiddenSpecies ? [
          '',
          'She is also secretly not human, and keeps that hidden day to day - the handle must not hint',
          `at it either, directly or in code (nothing like "${hiddenSpecies}", a pun on it, or a related`,
          'creature/mythology word). That reveal is hers to make later, not something this handle gives away.',
        ] : []),
        '',
        'A few that are already taken. Do not reuse a word from one of these or rework it into',
        'something adjacent:',
        shown.map((u) => `- @${u}`).join('\n') || '(none yet)',
        '',
        'Reply with exactly one JSON object and nothing else: { "username": "..." }',
      ].join('\n');

      const out = await completeJson<{ username?: string }>({
        scope: 'generator',
        label: attempt ? 'write_username:retry' : 'write_username',
        config: { ...getSettings().models.actor, max_tokens: NAME_TOKENS },
        require: ['username'],
        messages: correction
          ? [{ role: 'user', content: prompt }, { role: 'user', content: correction }]
          : [{ role: 'user', content: prompt }],
      });

      const cleaned = cleanHandle(out.username);
      if (cleaned.length < 4) {
        // This used to `continue` in silence, which is how three dead calls in a row left
        // no trace at all: the only sign anything had happened was a fallback handle.
        logger.warn('generator', 'no usable handle came back, re-asking', {
          raw: out.username ?? null,
          attempt: attempt + 1,
        });
        continue;
      }

      // Not a stylistic ask like the near-duplicate check below - a handle that leaks her
      // real name defeats the entire point of it being anonymous, so this is checked on
      // every attempt including the last, and never let through the way a near-miss is.
      if (cleaned.includes(realName.toLowerCase())) {
        logger.warn('generator', 'handle leaked her real name, re-asking', { cleaned, realName });
        correction =
          `"${cleaned}" contains her real name "${realName}" - a dating-app handle has to be anonymous, ` +
          `which is the one rule that never bends. Pick something with no connection to her name at all. ` +
          `Same JSON, nothing else.`;
        continue;
      }
      if (hiddenSpecies && cleaned.includes(hiddenSpecies)) {
        logger.warn('generator', 'handle leaked her hidden species, re-asking', { cleaned, hiddenSpecies });
        correction =
          `"${cleaned}" hints at what she actually is, which she keeps hidden day to day - pick ` +
          `something with no connection to that at all. Same JSON, nothing else.`;
        continue;
      }

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
  return fallbackUsername();
}

export async function generateCharacter(): Promise<Character> {
  const { seed, fieldIds } = rollSeed();
  const settings = getSettings();
  const takenHandles = existingUsernames();
  const takenNames = existingNames();
  let pass: DirectorPass = {};
  const characterPassMessages = [
    {
      role: 'user' as const,
      content: render('director_generate_character', {
        rolled_block: describeSeed(seed),
        is_fantasy: seed.species && seed.species !== 'human' ? '1' : '',
        age: seed.age,
        server_window: `${settings.server_window.from}-${settings.server_window.to}`,
        allowed_swaps: allowedSwapList(),
        avoid_names: takenNames.length ? takenNames.map((n) => `- ${n}`).join('\n') : '(none yet)',
      }),
    },
  ];

  // A dossier that degrades to the raw attribute dump (see below) is exactly what makes her
  // bio and handle read like a spec sheet - the whole reason this call exists. A single
  // retry of the exact same request costs nothing and catches the ordinary transport hiccup
  // that used to send every character born during it straight to that fallback.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      pass = await completeJson<DirectorPass>({
        scope: 'generator',
        label: attempt ? 'generate_character:retry' : 'generate_character',
        // Writing a character is a creative job, not an analytical one, so it goes to the
        // actor model like the bio does. The director model is picked for being cheap and
        // is typically also the censored one, which makes it a poor choice for something
        // that has to take a seed full of explicit traits seriously rather than sand them
        // down. The director still runs the game; it just does not invent the cast.
        config: { ...settings.models.actor, max_tokens: CHARACTER_TOKENS },
        require: ['real_name', 'dossier'],
        messages: characterPassMessages,
      });
      break;
    } catch (err) {
      logger.warn('generator', `director coherence pass failed${attempt ? ', using raw roll' : ', retrying once'}`, {
        error: String(err),
      });
    }
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

  // The fallback pool is only reached when the API is down, but it can repeat just as
  // easily as the model can, so it gets the same avoid-list treatment.
  const freshFallbacks = FALLBACK_NAMES.filter((n) => !nearestName(n, takenNames));
  let realName =
    (pass.real_name ?? '').trim().split(/\s+/)[0] ||
    pickOne(freshFallbacks.length ? freshFallbacks : FALLBACK_NAMES);
  const nameClash = nearestName(realName, takenNames);
  if (nameClash) {
    logger.warn('generator', 'name too close to one already in the cast, re-asking', { realName, nameClash });
    const rejectedName = realName;
    const fresh = await rerollName(seed, realName, nameClash, takenNames);
    if (fresh) {
      realName = fresh;
      // The dossier and one_line were drafted by the same call that picked the name that
      // just got rejected, so they still refer to her by it throughout - a reroll only ever
      // touches the name field, never the prose already written around it. Without this,
      // write_username() and writeBio() read a dossier that confidently describes "Layla"
      // for a woman who, from here on, is actually named something else entirely.
      pass.dossier = renameInProse(pass.dossier, rejectedName, realName);
      pass.one_line = renameInProse(pass.one_line, rejectedName, realName);
    }
  }

  if (pass.insecurity_detail) seed.hints.insecurity = pass.insecurity_detail;
  if (pass.search_motive_detail) seed.hints.search_motive = pass.search_motive_detail;
  if (pass.touchstone_detail) seed.hints.touchstone = pass.touchstone_detail;
  if (pass.one_line) seed.hints.one_line = pass.one_line;

  // Everything written about her from here on is built from this, not from the raw tags -
  // that is the entire point of asking for it. describeSeed() is still the fallback that
  // keeps the rest of the app (the Actor's core "who is she" context, mainly) working when
  // the coherence pass failed outright or came back without one despite `require` - but a
  // dossier that degraded to it is exactly the flat "label - hint" dump that makes a bio or
  // handle read like a spec sheet, which is why writeUsername/writeBio below are told
  // whether this is the real thing rather than being handed it blind.
  const dossierIsReal = !!(pass.dossier ?? '').trim();
  seed.hints.dossier = (pass.dossier ?? '').trim() || describeSeed(seed);

  // The handle is picked last, once she is a finished person, so it can actually be hers -
  // an inside joke, a mangled surname, or something completely opaque. The final collision
  // check still happens inside insertCharacter, which is the only place it can be done
  // atomically with the write.
  const username = await writeUsername(seed, realName, takenHandles, dossierIsReal);
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

  character.bio = await writeBio(character, dossierIsReal);

  insertCharacter(character);
  const rel = createRelationship(character.id, {
    director_notes: {
      intent: pass.director_intent ?? '',
      plans: pass.opening_plan?.text ? [pass.opening_plan] : [],
    },
  });

  // Whatever she put in her own bio is not a secret to re-extract from her in conversation -
  // the same reasoning ALWAYS_KNOWN in discovery.ts already applies to age and languages,
  // which are printed on the card itself. detectMentions only catches the literal, obvious
  // cases, which is the right amount here too: a bio that gestures at something without
  // spelling it out has not told him yet, and the profile should still show that as unknown.
  const bioReveals = detectMentions(character, rel, character.bio);
  if (bioReveals.length) {
    const validKeys = new Set(buildCatalogue(character).map((f) => f.key));
    const added = recordDiscoveries(rel, bioReveals, validKeys);
    if (added.length) {
      saveRelationship(rel);
      logger.debug('generator', `${username}'s bio already revealed: ${added.join(', ')}`);
    }
  }

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
 *
 * Also deliberately varied in REGISTER: Fauxr is not built for one kind of person, and a
 * fallback pool that was uniformly blunt and casual would teach that as the house style too,
 * the same way a fixed shape did. A few of these are shy, hopeful or genuinely unsure rather
 * than confidently physical - see the "WHAT FAUXR IS" section of director_write_bio.md.
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
  'not really sure what im doing here if im honest. downloaded this after a rough week and havent worked out yet if that was a good idea',
  'kind of hoping this turns into something and not just admitting that to a stranger on an app, but here we are I guess',
  'first time actually going through with using one of these. be patient with me, im better once i stop being nervous about it',
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

/**
 * Swaps every whole-word occurrence of a rejected name for the one that replaced it, so a
 * reroll actually reaches the prose that was written around the old name - not just the
 * seed field that held it. See the nameClash handling above for why this exists.
 */
function renameInProse(text: string | undefined, oldName: string, newName: string): string | undefined {
  if (!text || !oldName) return text;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), newName);
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

/**
 * Output budgets for the generation calls.
 *
 * These were sized for the answer alone - 120 tokens is generous for `{ "username": "..." }`.
 * A reasoning model bills its thinking against the same budget, so it spent the lot working
 * out what she would type and had nothing left to type it with, returning `{}`. Every one of
 * those failures sat exactly on its ceiling; every success sat under it. The room is for the
 * thinking, not for a longer answer.
 */
/** How many existing handles and bios the prompt names. Enough to steer, not enough to box in. */
const HANDLES_SHOWN = 8;
const BIOS_SHOWN = 10;

// 4x'd across the board (600/1200/3600 -> 2400/4800/14400): headroom traded for cost and
// worst-case latency, on purpose, so a genuinely long answer - or a reasoning model that
// wants to think at length before it writes one - never gets cut off by its own ceiling.
const NAME_TOKENS = 2400;
const BIO_TOKENS = 4800;
const CHARACTER_TOKENS = 14400;

const BIO_MIN_WORDS = 14;
const BIO_MAX_WORDS = 75;

function bioWordCount(bio: string): number {
  return bio.trim().split(/\s+/).filter(Boolean).length;
}

function pickFallbackBio(existing: string[]): string {
  const unused = FALLBACK_BIOS.filter((b) => !existing.includes(b));
  return pickOne(unused.length ? unused : FALLBACK_BIOS);
}

async function writeBio(character: Character, dossierIsReal: boolean): Promise<string> {
  const settings = getSettings();
  const existing = recentBios();

  // A degraded dossier is the raw "label - hint" attribute dump, not a person - a bio
  // written from that reads like it, which is exactly the complaint this avoids. The
  // curated fallback pool, already used for a total API failure below, is the better bet.
  if (!dossierIsReal) {
    logger.warn('generator', 'no real dossier to work from, using a fallback bio');
    return pickFallbackBio(existing);
  }

  const speciesVis = character.seed.species && character.seed.species !== 'human'
    ? find('species', character.seed.species)?.extra?.visibility
    : null;

  const prompt = render('director_write_bio', {
    username: character.username,
    // The dossier, not the raw tags - written from and covering the same ground, but as
    // an actual person rather than a spec sheet, which is what let two women who rolled
    // three of the same tags come out with suspiciously similar bios.
    seed_block: character.seed.hints.dossier,
    // Same reasoning as the handles: the whole list still decides the clash, but showing
    // thirty bios spends a thousand tokens teaching the model exactly what to sound like.
    avoid_bios: existing.length
      ? existing.slice(0, BIOS_SHOWN).map((b) => `- ${b}`).join('\n')
      : '(none yet)',
    // The dossier now knows and can talk freely about a 'later'/'private'/'chat_only'
    // species (see director_generate_character.md's is_fantasy section) - without this, that
    // freely-available knowledge would leak the species straight into the bio, discovered via
    // detectMentions() the moment the character is generated, before anyone has even swiped.
    // A 'profile'-tier species has nothing to protect: it is visible in any photo anyway.
    hides_species: speciesVis === 'later' || speciesVis === 'private' || speciesVis === 'chat_only' ? '1' : '',
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
        config: { ...settings.models.actor, max_tokens: BIO_TOKENS },
        require: ['bio'],
        messages: correction
          ? [{ role: 'user', content: prompt }, { role: 'user', content: correction }]
          : [{ role: 'user', content: prompt }],
      });
      const bio = (out.bio ?? '').trim();
      if (!bio) {
        logger.warn('generator', 'no bio came back, re-asking', { attempt: attempt + 1 });
        continue;
      }

      const words = bioWordCount(bio);
      if (words < BIO_MIN_WORDS) {
        logger.warn('generator', `bio too short (${words} words), re-requesting`, { bio });
        correction =
          `That is ${words} words. It reads as cryptic rather than interesting, and nobody can decide ` +
          `whether to swipe on it. Write a new one, ${BIO_MIN_WORDS}-${BIO_MAX_WORDS} words over two to four lines, ` +
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

  return pickFallbackBio(existing);
}
