import { db, nowIso } from './db/index.js';
import { byCategory, find } from './db/attributes.js';
import { newContext, roll, rollMany } from './engine/dice.js';
import { cosplayCount } from './engine/cosplay.js';
import { rollWardrobe, WARDROBE_ACCESSORY_IDS } from './engine/wardrobe.js';
import { buildAppearancePrompt, buildVisualCore } from './engine/appearance.js';
import { heightFitsSpecies, rollHeight } from './engine/height.js';
import { rollDomainStance, rollKinkSides } from './engine/kinks.js';
import { pickCore } from './engine/profilecard.js';
import { buildCharacterBlueprint } from './engine/blueprint.js';
import type {
  Character, CharacterSeed, CharacterState, DateNpc, DateSession, Direction, Flags, KinkSide, Ledger, LifeThread,
  Location, Relationship, UserProfile,
} from './types.js';

// ---------------------------------------------------------------- user profile

/** Everyone on here is an adult; the floor is not negotiable from the client. */
export const AGE_FLOOR = 18;
export const AGE_CEILING = 70;

function clampPreferredAge(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(AGE_FLOOR, Math.min(AGE_CEILING, n));
}

/**
 * The age band he wants to see. Read straight from the profile rather than cached, because
 * generation and the swipe stack both have to agree with it the moment it changes.
 */
/**
 * Orientations that could be interested in this user, as a SQL-safe id list. Kept next to
 * the age band because it is the same kind of filter and has the same failure mode: hide a
 * character from the stack without also hiding her from the counter and the stack stops
 * topping itself up.
 */
export function compatibleOrientationIds(): string[] {
  const gender = getUserProfile()?.gender ?? '';
  const bucket = gender === 'man' ? 'men' : gender === 'woman' ? 'women' : 'enby';
  const all = byCategory('orientation');
  const fits = all.filter((o) => ((o.extra?.attracted_to as string[]) ?? []).includes(bucket));
  const chosen = fits.length ? fits : all.filter((o) => ((o.extra?.attracted_to as string[]) ?? []).length > 1);
  // Characters generated before orientation existed have none; they stay visible rather
  // than vanishing out of an existing save.
  return chosen.map((o) => o.id);
}

export function preferredAgeRange(): { min: number; max: number } {
  const p = getUserProfile();
  const min = clampPreferredAge(p?.age_min, AGE_FLOOR);
  const max = clampPreferredAge(p?.age_max, 42);
  // A range saved back to front would otherwise match nothing at all.
  return min <= max ? { min, max } : { min: max, max: min };
}

export function getUserProfile(): UserProfile | null {
  const row = db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as any;
  if (!row) return null;
  return {
    display_name: row.display_name,
    age: row.age,
    bio: row.bio,
    photos: JSON.parse(row.photos),
    gender: row.gender,
    age_min: row.age_min ?? 18,
    age_max: row.age_max ?? 42,
    kink_map: JSON.parse(row.kink_map ?? '{}'),
    kink_sides: JSON.parse(row.kink_sides ?? '{}'),
    joiners: row.joiners ?? '',
    avatar_emoji: row.avatar_emoji ?? '',
    card: JSON.parse(row.card ?? '{}'),
    seeking: row.seeking,
  };
}

export function saveUserProfile(p: UserProfile): UserProfile {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO user_profile (id, display_name, age, bio, photos, gender, seeking, age_min, age_max, kink_map, kink_sides, joiners, avatar_emoji, card, created_at, updated_at)
     VALUES (1, @display_name, @age, @bio, @photos, @gender, @seeking, @age_min, @age_max, @kink_map, @kink_sides, @joiners, @avatar_emoji, @card, @ts, @ts)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, age = excluded.age,
       bio = excluded.bio, photos = excluded.photos, gender = excluded.gender,
       seeking = excluded.seeking, age_min = excluded.age_min, age_max = excluded.age_max,
       kink_map = excluded.kink_map, kink_sides = excluded.kink_sides, joiners = excluded.joiners, avatar_emoji = excluded.avatar_emoji, card = excluded.card,
       updated_at = excluded.updated_at`,
  ).run({
    ...p,
    photos: JSON.stringify(p.photos ?? []),
    age_min: clampPreferredAge(p.age_min, 18),
    age_max: clampPreferredAge(p.age_max, 42),
    kink_map: JSON.stringify(p.kink_map ?? {}),
    kink_sides: JSON.stringify(p.kink_sides ?? {}),
    joiners: p.joiners ?? '',
    avatar_emoji: p.avatar_emoji ?? '',
    card: JSON.stringify(p.card ?? {}),
    ts,
  });
  return getUserProfile()!;
}

// ---------------------------------------------------------------- characters

/**
 * Characters generated before breast_size existed have none - rather than leaving a gap in
 * the fixed appearance block forever, roll one in now, on first load. Seeded with her
 * existing body_type/height/ethnicity so the same affinities that make a size "fit" a build
 * during normal generation still apply here, not just a flat random pick. Persisted
 * immediately so this only ever runs once per character; every load after the first is a
 * no-op check.
 */
function backfillBreastSize(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.breast_size) return seed;
  const ctx = newContext();
  for (const id of [seed.body_type, seed.height, seed.ethnicity]) if (id) ctx.drawn.add(id);
  const chosen = roll('breast_size', ctx) ?? byCategory('breast_size')[0];
  if (!chosen) return seed; // attribute table not seeded yet - nothing to assign
  seed.breast_size = chosen.id;
  if (chosen.image_prompt) {
    seed.appearance_prompt = [seed.appearance_prompt, chosen.image_prompt].filter(Boolean).join(', ');
  }
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Characters generated before species existed have none - rolled the same way a fresh
 * character's is (same table, same weighting), not defaulted to human outright, so an old
 * character gets exactly the same rare shot at being something else that a new one does
 * rather than being retroactively excluded from the feature. ignoreArchetype because there is
 * no meaningful archetype-driven lean for this roll (nothing has been drawn to base one on at
 * backfill time), the same reasoning rollSeed() itself uses.
 */
function backfillSpecies(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.species) return seed;
  const ctx = newContext();
  const chosen = roll('species', ctx, { ignoreArchetype: true }) ?? byCategory('species')[0];
  if (!chosen) return seed; // attribute table not seeded yet - nothing to assign
  seed.species = chosen.id;
  if (chosen.extra?.visibility === 'profile' && chosen.image_prompt) {
    seed.appearance_prompt = [seed.appearance_prompt, chosen.image_prompt].filter(Boolean).join(', ');
  }
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Characters generated before texting_persona/speech_style existed have neither - rolled in
 * now, on first load, the same way breast_size was. Seeded with her existing archetype,
 * hobbies and interests so the affinities and conflicts these two categories
 * actually declare (a confident archetype excluding a shy texting or speech style, an
 * anime/gaming hobby leaning toward uwu or leetspeak) still apply here rather than landing
 * as a flat random pick disconnected from who she already is.
 */
function backfillCommStyles(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.texting_persona && seed.speech_style) return seed;
  const ctx = newContext();
  for (const id of [seed.archetype, ...(seed.hobbies ?? []), ...(seed.interests ?? [])]) {
    if (id) ctx.drawn.add(id);
  }
  let changed = false;
  if (!seed.texting_persona) {
    const chosen = roll('texting_persona', ctx) ?? byCategory('texting_persona')[0];
    if (chosen) { seed.texting_persona = chosen.id; changed = true; }
  }
  if (!seed.speech_style) {
    const chosen = roll('speech_style', ctx) ?? byCategory('speech_style')[0];
    if (chosen) { seed.speech_style = chosen.id; changed = true; }
  }
  if (changed) db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Characters made before sexual personas existed get one on first load, picked to fit the
 * stats they already have: only personas whose dom/sub range contains her leaning and whose
 * libido range is within one point of hers are eligible, leaned by her archetype the same way
 * a fresh roll is. The persona's own weights then lean her dirty talk and signature. Her
 * search_motive is rerolled too if it points at the old, retired table.
 */
function backfillSexualProfile(characterId: string, seed: CharacterSeed): CharacterSeed {
  const motiveOk = !!seed.search_motive && byCategory('search_motive').some((a) => a.id === seed.search_motive);
  if (seed.sexual_persona && seed.dirty_talk && seed.sexual_experience && seed.body_pride && seed.signature_move && motiveOk) {
    return seed;
  }
  if (!byCategory('sexual_persona').length) return seed; // attribute table not seeded yet
  const ctx = newContext();
  for (const id of [seed.archetype, ...(seed.fetishes ?? [])]) if (id) ctx.drawn.add(id);
  const hints = (seed.hints = seed.hints ?? {});
  const within = (range: number[] | undefined, v: number, slack = 0) =>
    !range || (v >= range[0] - slack && v <= range[1] + slack);

  if (!seed.sexual_persona || !find('sexual_persona', seed.sexual_persona)) {
    const fits = byCategory('sexual_persona').filter((p) => {
      const r = (p.extra?.ranges ?? {}) as Record<string, number[]>;
      return within(r.dom_sub_leaning, seed.dom_sub_leaning ?? 0) && within(r.libido, seed.libido ?? 3, 1);
    });
    const persona = roll('sexual_persona', ctx, fits.length ? { only: new Set(fits.map((p) => p.id)) } : {});
    if (persona) { seed.sexual_persona = persona.id; hints.sexual_persona = persona.prompt_hint; }
  } else {
    // Re-apply the stored persona's leans so the rolls below still follow it.
    for (const [id, m] of Object.entries(find('sexual_persona', seed.sexual_persona)?.extra?.weights ?? {})) {
      ctx.weights[id] = (ctx.weights[id] ?? 1) * Number(m);
    }
  }
  const fill = (field: 'dirty_talk' | 'sexual_experience' | 'body_pride' | 'signature_move' | 'search_motive') => {
    const current = seed[field];
    if (current && find(field, current)) return;
    const a = roll(field, ctx, field === 'search_motive' ? { ignoreArchetype: true } : {});
    if (a) { seed[field] = a.id; hints[field] = a.prompt_hint; }
  };
  fill('search_motive');
  fill('dirty_talk');
  fill('sexual_experience');
  fill('body_pride');
  fill('signature_move');
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Whether her sides are out of step with her kink map: a two-ended domain she is open to
 * with no side, or a side left on one she no longer is. Checked on every load without
 * rolling anything.
 */
function kinkSidesDue(seed: CharacterSeed): boolean {
  const want = new Set<string>();
  for (const d of byCategory('kink_domain')) {
    const st = seed.kink_map?.[d.id];
    if ((d.extra as any)?.sides && (st === 'into' || st === 'curious')) want.add(d.id);
  }
  const have = Object.keys(seed.kink_sides ?? {});
  return have.length !== want.size || have.some((k) => !want.has(k));
}

/**
 * Fields and kink domains added after a character was made: her butt, what she wears
 * underneath and to bed, her grooming, and a stance on every kink domain she has none for.
 * Rolled with her own style, build and persona in the context so they lean the way they would
 * for a new character. A new domain she already has a fetish from counts as one she is into,
 * so an existing "going all the way" does not end up under an oral hard no. Persisted once.
 */
function backfillIntimateDetails(characterId: string, seed: CharacterSeed): CharacterSeed {
  const domains = byCategory('kink_domain');
  const missingDomains = domains.filter((d) => !seed.kink_map?.[d.id]);
  // Every two-ended domain she is open to needs her end of it (see rollKinkSides).
  const sidesDue = kinkSidesDue(seed);
  if (seed.butt_size && seed.lingerie_style && seed.sleepwear && seed.intimate_grooming && !missingDomains.length && !sidesDue) return seed;
  if (!byCategory('lingerie_style').length) return seed; // attribute table not seeded yet
  const ctx = newContext();
  for (const id of [seed.body_type, seed.height, seed.clothing_style, seed.sexual_persona, seed.archetype]) if (id) ctx.drawn.add(id);
  for (const [id, m] of Object.entries(find('sexual_persona', seed.sexual_persona)?.extra?.weights ?? {})) {
    ctx.weights[id] = (ctx.weights[id] ?? 1) * Number(m);
  }
  const fill = (field: 'butt_size' | 'lingerie_style' | 'sleepwear' | 'intimate_grooming') => {
    if (seed[field] && find(field, seed[field])) return;
    const a = roll(field, ctx);
    if (a) seed[field] = a.id;
    if (a && field === 'butt_size' && a.image_prompt) {
      seed.appearance_prompt = [seed.appearance_prompt, a.image_prompt].filter(Boolean).join(', ');
    }
  };
  fill('butt_size');
  fill('lingerie_style');
  fill('sleepwear');
  fill('intimate_grooming');
  if (missingDomains.length) {
    const bias = (find('sexual_persona', seed.sexual_persona)?.extra?.kink_bias ?? {}) as Record<string, number>;
    const fetishes = new Set(seed.fetishes ?? []);
    seed.kink_map = { ...(seed.kink_map ?? {}) };
    for (const d of missingDomains) {
      const owned = ((d.extra?.fetishes as string[]) ?? []).some((f) => fetishes.has(f));
      seed.kink_map[d.id] = owned ? 'into' : rollDomainStance(seed.freak ?? 2.5, d, Number(bias[d.id] ?? 0));
    }
  }
  // After the new domains have a stance, so they get a side too. Taken from the fetishes she
  // already has wherever they say, so an existing "worshipping his feet" makes her side 'his'.
  seed.kink_sides = rollKinkSides({
    kink_map: seed.kink_map ?? {},
    dom_sub_leaning: seed.dom_sub_leaning ?? 0,
    fetishes: seed.fetishes,
    kink_sides: seed.kink_sides,
    side_bias: find('sexual_persona', seed.sexual_persona)?.extra?.side_bias as any,
  });
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Her core (profilecard.ts), picked once and stored. Characters made before cores existed get
 * theirs on first load, keyed on their id so the pick is the one their card already showed;
 * one from the three-trait days is extended to her 3-5 rather than re-picked.
 */
function backfillCore(characterId: string, seed: CharacterSeed): CharacterSeed {
  // v3 is Core-first at creation; never replace that causal Core with the legacy
  // retrospective picker when the freshly generated character is first hydrated.
  if (seed.core?.length && Number(seed.core_v ?? 0) >= 2) return seed;
  if (!byCategory('archetype').length) return seed; // attribute table not seeded yet
  // A core from the three-trait days keeps its three and grows to her count (3-5).
  seed.core = pickCore(seed, characterId, seed.core ?? []);
  seed.core_v = 2;
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Everyone generated before the gender table existed is recorded as cis - never re-rolled: her
 * body is already established in every chat she has had. A power rolled for an old character
 * by backfillSpecies() gets the hero role it needs, the same way a new one does.
 */
function backfillIdentity(characterId: string, seed: CharacterSeed): CharacterSeed {
  const needsGender = !seed.transgender;
  // Layers (layers.ts) are 'none' for everyone generated before them - never added after the
  // fact to a woman whose life is already established in a chat.
  const needsLayers = !seed.double_life || !seed.era || !seed.curse || !seed.duo;
  const species = seed.species ? find('species', seed.species) : undefined;
  const needsRole = species?.extra?.kind === 'power' && !seed.hero_role;
  if (!needsGender && !needsRole && !needsLayers) return seed;
  if (!byCategory('transgender').length) return seed; // attribute table not seeded yet
  if (needsGender) seed.transgender = 'cis_woman';
  seed.double_life ??= 'none';
  seed.era ??= 'none';
  seed.curse ??= 'none';
  // Same for a duo: a partner never appears out of nowhere in a chat that already exists.
  seed.duo ??= 'none';
  if (needsRole) {
    const role = roll('hero_role', newContext(), { ignoreArchetype: true });
    if (role) seed.hero_role = role.id;
  }
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * A closet (wardrobe.ts) for anyone generated before wardrobes. Safe to add later: she always
 * owned clothes, the table only names them. Two things move with it:
 * - clothing-like accessories (thigh-high socks, platform boots, a varsity jacket...) became
 *   wardrobe pieces under the same ids, so hers leave her accessories and join her closet;
 * - her fixed look is rebuilt without the clothing style's stock outfit line, which used to
 *   be in every photo of her.
 */
function backfillWardrobe(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.wardrobe) return seed;
  if (!byCategory('wardrobe_item').length) return seed; // attribute table not seeded yet
  const moved = (seed.accessories ?? []).filter((id) => !find('accessory', id) && find('wardrobe_item', id));
  seed.accessories = (seed.accessories ?? []).filter((id) => !moved.includes(id));
  seed.wardrobe = rollWardrobe(seed);
  for (const id of moved) {
    const slot = find('wardrobe_item', id)!.extra?.slot as keyof NonNullable<CharacterSeed['wardrobe']>;
    const owned = seed.wardrobe[slot] ?? [];
    if (!owned.includes(id)) seed.wardrobe[slot] = [id, ...owned];
  }
  seed.appearance_prompt = buildAppearancePrompt(seed);
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Fairies and giants used to carry two contradictory facts: their species prompt named a
 * hand-sized or nine-foot body while the independent height roll still said 1.65m. Once per
 * affected existing character, replace that generic row with one from her species' dedicated
 * scale pool and rebuild the derived appearance prompt around the corrected source of truth.
 */
function backfillSpeciesHeight(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (heightFitsSpecies(seed.height, seed.species)) return seed;
  if (!byCategory('height').length) return seed;
  const ctx = newContext();
  for (const id of [seed.species, seed.body_type, seed.ethnicity]) if (id) ctx.drawn.add(id);
  const chosen = rollHeight(seed.species, ctx);
  if (!chosen) return seed;
  seed.height = chosen.id;
  seed.appearance_prompt = buildAppearancePrompt(seed);
  // Rebuild at the normal end-of-hydration stage, after any other legacy fields were filled.
  delete seed.blueprint;
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/** Existing characters gain a blueprint made only from their established attributes. */
function backfillBlueprint(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.blueprint?.version === 2) return seed;
  seed.blueprint = buildCharacterBlueprint(seed);
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/** Preserve old faces: record only appearance anchors the character already had, never roll new geometry. */
function backfillVisualCore(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.visual_core?.version === 1) return seed;
  seed.visual_core = buildVisualCore(seed);
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Permanent piercing records and wardrobe accessories used to describe the same metal twice.
 * Existing records become owned body jewellery, so outfit state is the sole image source.
 */
function backfillPiercingsToWardrobe(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (!seed.wardrobe || !(seed.piercings ?? []).length) return seed;
  const byPosition: Record<string, string> = {
    earlobe: 'small_gold_hoops', second_lobe: 'small_gold_hoops', third_lobe: 'small_gold_hoops',
    high_lobe: 'cartilage_hoop_jewellery', upper_lobe_stack: 'cartilage_hoop_jewellery',
    helix: 'cartilage_hoop_jewellery', forward_helix: 'cartilage_hoop_jewellery',
    tragus: 'cartilage_hoop_jewellery', industrial: 'cartilage_hoop_jewellery',
    conch: 'cartilage_hoop_jewellery', outer_conch: 'cartilage_hoop_jewellery',
    inner_conch: 'cartilage_hoop_jewellery', daith: 'cartilage_hoop_jewellery',
    rook: 'cartilage_hoop_jewellery', orbital: 'cartilage_hoop_jewellery',
    snug: 'cartilage_hoop_jewellery', flat: 'cartilage_hoop_jewellery',
    nose: 'nose_ring_delicate', nasallang: 'nose_ring_delicate', bridge: 'nose_ring_delicate',
    septum: 'septum_ring_jewelry', eyebrow: 'eyebrow_bar_jewellery', anti_eyebrow: 'eyebrow_bar_jewellery',
    lip: 'lip_ring_jewellery', medusa: 'lip_ring_jewellery', monroe: 'lip_ring_jewellery',
    smiley: 'lip_ring_jewellery', vertical_labret: 'lip_ring_jewellery', dahlia: 'lip_ring_jewellery',
    tongue: 'tongue_bar_jewellery', navel: 'navel_bar_jewellery', bellybutton_double: 'navel_bar_jewellery',
    nipple: 'nipple_bar_jewellery', clavicle: 'clavicle_dermal_jewellery',
  };
  const jewellery = [...(seed.wardrobe.jewellery ?? [])];
  for (const piercing of seed.piercings) {
    const id = byPosition[piercing.position] ?? 'cartilage_hoop_jewellery';
    if (find('wardrobe_item', id) && !jewellery.includes(id)) jewellery.push(id);
  }
  seed.wardrobe.jewellery = jewellery;
  seed.piercings = [];
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * The accessory split: jewellery and hair pieces moved into the wardrobe, bags and keys into
 * what she carries, and only what is always on her stayed. Everyone's old accessory ids move
 * with them (same ids), a closet from before jewellery gets its jewellery, and her fixed look
 * is rebuilt when anything left it. Idempotent: it only acts on ids that no longer are
 * accessories and on fields that are missing.
 */
function backfillAccessorySplit(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (!seed.wardrobe || !byCategory('carried_item').length) return seed;
  const moved = (seed.accessories ?? []).filter((id) => !find('accessory', id) || WARDROBE_ACCESSORY_IDS.has(id));
  const needsJewellery = !seed.wardrobe.jewellery;
  const needsCarries = !seed.carries;
  if (!moved.length && !needsJewellery && !needsCarries) return seed;
  if (needsJewellery) seed.wardrobe.jewellery = rollWardrobe(seed, ['jewellery']).jewellery ?? [];
  seed.carries ??= [];
  for (const id of moved) {
    const piece = find('wardrobe_item', id);
    if (piece) {
      const slot = piece.extra?.slot as keyof NonNullable<CharacterSeed['wardrobe']>;
      if (!(seed.wardrobe[slot] ?? []).includes(id)) seed.wardrobe[slot] = [id, ...(seed.wardrobe[slot] ?? [])];
    } else if (find('carried_item', id) && !seed.carries.includes(id)) {
      seed.carries.push(id);
    }
  }
  seed.accessories = (seed.accessories ?? []).filter((id) => !moved.includes(id));
  if (moved.length) seed.appearance_prompt = buildAppearancePrompt(seed);
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Costumes (cosplay.ts) for anyone generated before the reference table. Unlike a layer this is
 * safe to add later: a woman who already cosplays already owns costumes, the table only names
 * them. Everyone else gets an empty list, so this runs once per character.
 */
function backfillCosplays(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.cosplays) return seed;
  if (!byCategory('cosplay_character').length) return seed; // attribute table not seeded yet
  seed.cosplays = rollMany('cosplay_character', newContext(), cosplayCount(seed), { ignoreArchetype: true }).map((a) => a.id);
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

/**
 * Characters made before conversation_starter existed get one on first load. Seeded with her
 * archetype, fetishes and non-'none' layers so the same affinities a fresh roll would use (a
 * hypnosis fetish leaning toward "will hypnotize you via text", an era layer toward "stuck
 * here from another time") apply here too, not a flat random pick disconnected from who she
 * already is.
 */
function backfillConversationStarter(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.conversation_starter && find('conversation_starter', seed.conversation_starter)) return seed;
  if (!byCategory('conversation_starter').length) return seed; // attribute table not seeded yet
  const ctx = newContext();
  for (const id of [seed.archetype, seed.double_life, seed.era, seed.curse, ...(seed.fetishes ?? [])]) {
    if (id && id !== 'none') ctx.drawn.add(id);
  }
  const chosen = roll('conversation_starter', ctx) ?? byCategory('conversation_starter')[0];
  if (chosen) {
    seed.conversation_starter = chosen.id;
    seed.hints = { ...(seed.hints ?? {}), conversation_starter: chosen.prompt_hint };
    db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  }
  return seed;
}

/** Existing characters gain a photo format without changing their established identity. */
function backfillProfilePhotoFormat(characterId: string, seed: CharacterSeed): CharacterSeed {
  if (seed.profile_photo_format && find('profile_photo_format', seed.profile_photo_format)) return seed;
  if (!byCategory('profile_photo_format').length) return seed;
  const chosen = roll('profile_photo_format', newContext(), { ignoreArchetype: true });
  if (chosen) {
    seed.profile_photo_format = chosen.id;
    db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  }
  return seed;
}

function hydrateCharacter(row: any): Character {
  let seed = backfillSpecies(row.id, JSON.parse(row.seed) as CharacterSeed);
  seed = backfillSpeciesHeight(row.id, seed);
  seed = backfillBreastSize(row.id, seed);
  seed = backfillIdentity(row.id, seed);
  seed = backfillCommStyles(row.id, seed);
  seed = backfillSexualProfile(row.id, seed);
  seed = backfillIntimateDetails(row.id, seed);
  seed = backfillCore(row.id, seed);
  seed = backfillWardrobe(row.id, seed);
  seed = backfillPiercingsToWardrobe(row.id, seed);
  seed = backfillAccessorySplit(row.id, seed);
  seed = backfillCosplays(row.id, seed);
  seed = backfillConversationStarter(row.id, seed);
  seed = backfillProfilePhotoFormat(row.id, seed);
  seed = backfillBlueprint(row.id, seed);
  seed = backfillVisualCore(row.id, seed);
  return {
    id: row.id,
    username: row.username,
    real_name: row.real_name,
    bio: row.bio,
    created_at: row.created_at,
    state: row.state as CharacterState,
    seed,
    reappear_at: row.reappear_at,
    rejection_count: row.rejection_count,
    matched_at: row.matched_at,
  };
}

/**
 * Handles are unique on a platform, and a cheap model will happily hand out the same one
 * twice. Characters are generated concurrently, so the check only holds if it happens in
 * the same synchronous step as the insert. Mutates c.username when it has to.
 */
function claimUsername(base: string): string {
  const taken = (name: string) => !!db.prepare('SELECT 1 FROM characters WHERE username = ?').get(name);
  if (!taken(base)) return base;
  for (let i = 0; i < 50; i++) {
    const suffix = String(2 + Math.floor(Math.random() * 9998));
    const candidate = `${base.slice(0, Math.max(1, 18 - suffix.length))}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base.slice(0, 10)}${Date.now().toString(36)}`;
}

export function insertCharacter(c: Character): void {
  db.transaction(() => {
    c.username = claimUsername(c.username);
    db.prepare(
      `INSERT INTO characters (id, username, real_name, bio, created_at, state, seed, reappear_at, rejection_count, matched_at)
       VALUES (@id, @username, @real_name, @bio, @created_at, @state, @seed, @reappear_at, @rejection_count, @matched_at)`,
    ).run({ ...c, seed: JSON.stringify(c.seed) });
  })();
}

export function getCharacter(id: string): Character | null {
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as any;
  return row ? hydrateCharacter(row) : null;
}

export function setCharacterState(id: string, state: CharacterState, extra: Partial<Character> = {}): void {
  const sets: string[] = ['state = @state'];
  const params: any = { id, state };
  if ('reappear_at' in extra) { sets.push('reappear_at = @reappear_at'); params.reappear_at = extra.reappear_at ?? null; }
  if ('rejection_count' in extra) { sets.push('rejection_count = @rejection_count'); params.rejection_count = extra.rejection_count; }
  if ('matched_at' in extra) { sets.push('matched_at = @matched_at'); params.matched_at = extra.matched_at ?? null; }
  db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function updateCharacterProfile(id: string, fields: { username?: string; real_name?: string; bio?: string }): void {
  const sets: string[] = [];
  const params: any = { id };
  for (const k of ['username', 'real_name', 'bio'] as const) {
    if (fields[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = fields[k]; }
  }
  if (sets.length) db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function updateCharacterSeed(id: string, seed: CharacterSeed): void {
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), id);
}

/** The swipe stack: pool characters plus rejected ones whose cooldown has expired. */
export function swipeStack(limit = 10): Character[] {
  const band = preferredAgeRange();
  const ok = compatibleOrientationIds();
  const rows = db
    .prepare(
      `SELECT * FROM characters
       WHERE (state = 'pool'
          OR (state = 'swiped_left' AND rejection_count < 2 AND reappear_at IS NOT NULL AND reappear_at <= ?))
         AND json_extract(seed, '$.age') BETWEEN ? AND ?
         AND (json_extract(seed, '$.orientation') IS NULL
              OR json_extract(seed, '$.orientation') IN (SELECT value FROM json_each(?)))
       ORDER BY discover_order ASC, created_at ASC LIMIT ?`,
    )
    .all(nowIso(), band.min, band.max, JSON.stringify(ok), limit) as any[];
  return rows.map(hydrateCharacter);
}

export function countPoolAvailable(): number {
  const band = preferredAgeRange();
  const ok = compatibleOrientationIds();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM characters
       WHERE (state = 'pool'
          OR (state = 'swiped_left' AND rejection_count < 2 AND reappear_at IS NOT NULL AND reappear_at <= ?))
         AND json_extract(seed, '$.age') BETWEEN ? AND ?
         AND (json_extract(seed, '$.orientation') IS NULL
              OR json_extract(seed, '$.orientation') IN (SELECT value FROM json_each(?)))`,
    )
    .get(nowIso(), band.min, band.max, JSON.stringify(ok)) as { n: number };
  return row.n;
}

export function listMatches(): Character[] {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE state IN ('matched','blocked_by_user') ORDER BY matched_at DESC`)
    .all() as any[];
  return rows.map(hydrateCharacter);
}

export function listActiveMatches(): Character[] {
  const rows = db.prepare(`SELECT * FROM characters WHERE state = 'matched'`).all() as any[];
  return rows.map(hydrateCharacter);
}

/** Matches whose delayed-match timestamp has arrived, newest matches first. */
export function listVisibleMatches(at = nowIso()): Character[] {
  const rows = db
    .prepare(
      `SELECT * FROM characters
       WHERE state IN ('matched','blocked_by_user')
         AND (matched_at IS NULL OR matched_at <= ?)
       ORDER BY matched_at DESC`,
    )
    .all(at) as any[];
  return rows.map(hydrateCharacter);
}

/** Move a profile behind every other Discover candidate without rejecting or changing her. */
export function moveToEndOfSwipeStack(characterId: string): boolean {
  const result = db.prepare(
    `UPDATE characters
     SET discover_order = (SELECT COALESCE(MAX(discover_order), 0) + 1 FROM characters)
     WHERE id = ? AND state IN ('pool', 'swiped_left')`,
  ).run(characterId);
  return result.changes > 0;
}

/** The first successfully rendered profile picture is her stable visual reference. */
export function profilePicturePath(characterId: string): string | null {
  const row = db
    .prepare("SELECT path FROM images WHERE character_id = ? AND kind = 'profile' AND status = 'done' ORDER BY rowid ASC LIMIT 1")
    .get(characterId) as { path: string } | undefined;
  return row?.path ?? null;
}

/**
 * Deletes a character outright, so a cluttered chat list can actually be cleaned up. The
 * relationship, messages, wakeups, dates and image rows all reference the character with
 * ON DELETE CASCADE, so one delete here takes the whole thing with it - the caller only
 * needs to know which image files on disk go with it, which is why this hands them back
 * before they become unreachable.
 */
export function deleteCharacter(id: string): string[] {
  const generated = db
    .prepare(`SELECT path FROM images WHERE character_id = ? AND path IS NOT NULL`)
    .all(id) as { path: string }[];
  const uploads = db
    .prepare(
      `SELECT json_extract(meta, '$.path') AS path FROM messages
       WHERE character_id = ? AND sender = 'user' AND kind = 'image'
         AND json_extract(meta, '$.path') IS NOT NULL`,
    )
    .all(id) as { path: string }[];
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  return [...new Set([...generated, ...uploads].map((r) => r.path))];
}

// ---------------------------------------------------------------- relationships

const EMPTY_LEDGER: Ledger = {
  facts: { about_user: [], about_her: [] },
  events: [],
  open_threads: [],
  director_notes: { intent: '', plans: [] },
};

const EMPTY_FLAGS: Flags = { state: {} };

function hydrateRelationship(row: any): Relationship {
  const storedFlags = JSON.parse(row.flags ?? '{}');
  return {
    character_id: row.character_id,
    mood: JSON.parse(row.mood),
    arousal: row.arousal ?? 0,
    discovered: JSON.parse(row.discovered ?? '{}'),
    last_contact_at: row.last_contact_at,
    last_decay_at: row.last_decay_at,
    // Older saves also carry `events` and `negative` flag groups from when she could be
    // won or lost. Only `state` is read now; the rest is dropped on the next save.
    flags: { state: { ...(storedFlags.state ?? {}) } },
    ledger: { ...EMPTY_LEDGER, ...JSON.parse(row.ledger) },
    active_direction: row.active_direction ? (JSON.parse(row.active_direction) as Direction) : null,
    direction_set_at: row.direction_set_at,
  };
}

export function createRelationship(characterId: string, seedLedger?: Partial<Ledger>): Relationship {
  db.prepare(
    `INSERT OR IGNORE INTO relationships (character_id, flags, ledger, last_contact_at, last_decay_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    characterId,
    JSON.stringify(EMPTY_FLAGS),
    JSON.stringify({ ...EMPTY_LEDGER, ...seedLedger }),
    nowIso(),
    nowIso(),
  );
  return getRelationship(characterId)!;
}

export function getRelationship(characterId: string): Relationship | null {
  const row = db.prepare('SELECT * FROM relationships WHERE character_id = ?').get(characterId) as any;
  // Old mood.game_clock_ms values are intentionally left intact: clock.ts reads the newest one
  // once when migrating to the shared world clock. New relationships need no per-chat clock.
  return row ? hydrateRelationship(row) : null;
}

export function saveRelationship(r: Relationship): void {
  db.prepare(
    `UPDATE relationships SET mood=@mood, arousal=@arousal, discovered=@discovered,
       last_contact_at=@last_contact_at, last_decay_at=@last_decay_at,
       flags=@flags, ledger=@ledger, active_direction=@active_direction,
       direction_set_at=@direction_set_at
     WHERE character_id=@character_id`,
  ).run({
    ...r,
    mood: JSON.stringify(r.mood),
    discovered: JSON.stringify(r.discovered ?? {}),
    flags: JSON.stringify(r.flags),
    ledger: JSON.stringify(r.ledger),
    active_direction: r.active_direction ? JSON.stringify(r.active_direction) : null,
  });
}

// ---------------------------------------------------------------- messages

export interface StoredMessage {
  id: number;
  character_id: string;
  sender: 'user' | 'character' | 'system';
  text: string;
  kind: 'text' | 'voice' | 'image';
  meta: Record<string, any>;
  sent_at: string;
  read_at: string | null;
  /** null for the text chat; a dates.id for a line spoken in person during that date. */
  date_id: string | null;
  /**
   * Shared world-clock time (engine/clock.ts) at the moment this message was sent - null for a
   * date beat (dates run on real time, not the text chat's clock) and for anything predating
   * this field. The chat screen displays this instead of `sent_at` when it has one.
   */
  game_clock_ms: number | null;
}

function hydrateMessage(row: any): StoredMessage {
  return { ...row, meta: JSON.parse(row.meta) };
}

export function addMessage(m: {
  character_id: string;
  sender: 'user' | 'character' | 'system';
  text: string;
  kind?: 'text' | 'voice' | 'image';
  meta?: Record<string, any>;
  sent_at?: string;
  /** Omit to use the default; pass null explicitly to leave a message unread. */
  read_at?: string | null;
  /** Omit for the text chat. Set to put this line in a date's own transcript instead. */
  date_id?: string | null;
  /** Shared world-clock time (engine/clock.ts) at the moment of sending. */
  game_clock_ms?: number | null;
}): StoredMessage {
  const info = db
    .prepare(
      `INSERT INTO messages (character_id, sender, text, kind, meta, sent_at, read_at, date_id, game_clock_ms)
       VALUES (@character_id, @sender, @text, @kind, @meta, @sent_at, @read_at, @date_id, @game_clock_ms)`,
    )
    .run({
      character_id: m.character_id,
      sender: m.sender,
      text: m.text,
      kind: m.kind ?? 'text',
      meta: JSON.stringify(m.meta ?? {}),
      sent_at: m.sent_at ?? nowIso(),
      // `null` is a meaningful value here (unread), so only fall back when the
      // caller left it out entirely.
      read_at: 'read_at' in m ? m.read_at ?? null : m.sender === 'character' ? nowIso() : null,
      date_id: m.date_id ?? null,
      game_clock_ms: m.game_clock_ms ?? null,
    });
  return getMessage(Number(info.lastInsertRowid))!;
}

export function getMessage(id: number): StoredMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  return row ? hydrateMessage(row) : null;
}

/**
 * The chat bubble that delivered a given image job, if it ever reached the chat - used by
 * regenerateImage() to bump its meta so the browser reloads the new bytes at the same path
 * instead of showing what it already cached under that URL.
 */
export function findMessageByImageId(imageId: string): StoredMessage | null {
  const row = db
    .prepare("SELECT * FROM messages WHERE json_extract(meta, '$.image_id') = ? ORDER BY id DESC LIMIT 1")
    .get(imageId) as any;
  return row ? hydrateMessage(row) : null;
}

/** The placeholders of one "which one?" photo choice, in the order she offered them. */
export function messagesInChoiceGroup(group: string): StoredMessage[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE json_extract(meta, '$.choice_group') = ? ORDER BY id ASC")
    .all(group) as any[];
  return rows.map(hydrateMessage);
}

/** Merges into a message's existing meta - used to resolve a photo-offer card in place. */
export function updateMessageMeta(id: number, patch: Record<string, any>): StoredMessage | null {
  const existing = getMessage(id);
  if (!existing) return null;
  db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(
    JSON.stringify({ ...existing.meta, ...patch }),
    id,
  );
  return getMessage(id);
}

/** Used by regenerate: removes specific messages outright, not a soft delete. */
export function deleteMessages(ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids).changes;
}

/**
 * Everything below reads the TEXT chat only - `date_id IS NULL`. What was said in person on
 * a date is its own transcript (see dateMessages), and letting the two mix would put an
 * evening of in-person roleplay into the texting history the Actor is shown, which is the
 * one thing keeping the two registers apart.
 */
export function recentMessages(characterId: string, limit = 40): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE character_id = ? AND date_id IS NULL ORDER BY id DESC LIMIT ?')
    .all(characterId, limit) as any[];
  return rows.reverse().map(hydrateMessage);
}

/**
 * The photos she has sent him in the text chat since `sinceIso`, oldest first. Two she offered
 * as a choice count as one send, and the one he did not pick is left out.
 */
export function herPhotosSince(characterId: string, sinceIso: string): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE character_id = ? AND date_id IS NULL AND kind = 'image'
         AND sender = 'character' AND sent_at >= ? ORDER BY id ASC`,
    )
    .all(characterId, sinceIso) as any[];
  const seen = new Set<string>();
  return rows.map(hydrateMessage).filter((m) => {
    if (m.meta?.declined) return false;
    const group = m.meta?.choice_group as string | undefined;
    if (!group) return true;
    if (seen.has(group)) return false;
    seen.add(group);
    return true;
  });
}

/** Failed recovery bubbles and system bookkeeping are not a first conversation. */
export function hasRealChatMessages(characterId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM messages WHERE character_id = ? AND date_id IS NULL
    AND sender IN ('user', 'character') AND COALESCE(json_extract(meta, '$.failed'), 0) = 0 LIMIT 1`).get(characterId);
}

export function hasUserMessageAfter(characterId: string, historyThroughId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM messages WHERE character_id = ? AND date_id IS NULL
    AND sender = 'user' AND id > ? AND COALESCE(json_extract(meta, '$.failed'), 0) = 0 LIMIT 1`)
    .get(characterId, historyThroughId);
}

export function messagesSince(characterId: string, sinceId: number): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE character_id = ? AND date_id IS NULL AND id > ? ORDER BY id ASC')
    .all(characterId, sinceId) as any[];
  return rows.map(hydrateMessage);
}

export function lastMessage(characterId: string): StoredMessage | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE character_id = ? AND date_id IS NULL ORDER BY id DESC LIMIT 1')
    .get(characterId) as any;
  return row ? hydrateMessage(row) : null;
}

export function unreadCount(characterId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE character_id = ? AND date_id IS NULL AND sender = 'character' AND read_at IS NULL`,
    )
    .get(characterId) as { n: number };
  return row.n;
}

/** Messages he has sent that she has not seen yet, because she was offline. */
export function pendingUserMessageCount(characterId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE character_id = ? AND date_id IS NULL AND sender = 'user' AND read_at IS NULL`,
    )
    .get(characterId) as { n: number };
  return row.n;
}

/** Mark the user's messages as seen by her. Only ever called while she is online. */
export function markUserMessagesRead(characterId: string, throughId = Number.MAX_SAFE_INTEGER): number {
  return db
    .prepare(
      `UPDATE messages SET read_at = ?
       WHERE character_id = ? AND date_id IS NULL AND sender = 'user' AND read_at IS NULL AND id <= ?`,
    )
    .run(nowIso(), characterId, throughId).changes;
}

/** Returns how many messages this actually marked, so callers can tell a no-op apart. */
export function markCharacterMessagesRead(characterId: string): number {
  return db
    .prepare(
      `UPDATE messages SET read_at = ?
       WHERE character_id = ? AND date_id IS NULL AND sender = 'character' AND read_at IS NULL`,
    )
    .run(nowIso(), characterId).changes;
}

/** One date's transcript, oldest first. The texting history never includes any of this. */
export function dateMessages(dateId: string): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE date_id = ? ORDER BY id ASC')
    .all(dateId) as any[];
  return rows.map(hydrateMessage);
}

// ---------------------------------------------------------------- locations

function hydrateLocation(row: any): Location {
  let affordances = {
    sensory: [], private_spaces: [], background_people: [], social_openings: [],
    interruptions: [], transitions: [], constraints: [],
  } as Location['affordances'];
  try {
    const raw = JSON.parse(row.affordances ?? '{}');
    const list = (key: keyof Location['affordances']) => Array.isArray(raw[key])
      ? raw[key].map((v: unknown) => String(v).trim()).filter(Boolean).slice(0, 8)
      : [];
    affordances = {
      sensory: list('sensory'), private_spaces: list('private_spaces'),
      background_people: list('background_people'), social_openings: list('social_openings'),
      interruptions: list('interruptions'), transitions: list('transitions'), constraints: list('constraints'),
    };
  } catch { /* an old malformed row simply has no affordances */ }
  return { ...row, image_path: row.image_path ?? null, affordances };
}

export function listLocations(): Location[] {
  const rows = db.prepare('SELECT * FROM locations ORDER BY name COLLATE NOCASE ASC').all() as any[];
  return rows.map(hydrateLocation);
}

export function getLocation(id: string): Location | null {
  const row = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as any;
  return row ? hydrateLocation(row) : null;
}

export function saveLocation(l: {
  id: string;
  name: string;
  description: string;
  image_path?: string | null;
  affordances?: Location['affordances'];
}): Location {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO locations (id, name, description, image_path, affordances, created_at, updated_at)
     VALUES (@id, @name, @description, @image_path, @affordances, @ts, @ts)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
       -- Only replaced when a new one is actually supplied, so editing the description of a
       -- place does not silently drop the backdrop already generated for it.
       image_path = COALESCE(excluded.image_path, locations.image_path),
       affordances = excluded.affordances,
       updated_at = excluded.updated_at`,
  ).run({
    id: l.id,
    name: l.name,
    description: l.description,
    image_path: l.image_path ?? null,
    affordances: JSON.stringify(l.affordances ?? getLocation(l.id)?.affordances ?? {
      sensory: [], private_spaces: [], background_people: [], social_openings: [],
      interruptions: [], transitions: [], constraints: [],
    }),
    ts,
  });
  return getLocation(l.id)!;
}

export function deleteLocation(id: string): void {
  db.prepare('DELETE FROM locations WHERE id = ?').run(id);
}

/**
 * The places themselves are his own writing and survive a world reset - but their backdrops
 * live in the images directory, which that reset empties. Without this the locations come
 * back pointing at files that are no longer there.
 */
export function clearLocationImages(): number {
  return db.prepare('UPDATE locations SET image_path = NULL WHERE image_path IS NOT NULL').run().changes;
}

// ---------------------------------------------------------------- dates

function hydrateDate(row: any): DateSession {
  return {
    id: row.id,
    character_id: row.character_id,
    kind: row.kind === 'call' ? 'call' : 'date',
    status: row.status === 'scheduled' ? 'scheduled' : row.status === 'active' ? 'active' : 'ended',
    when_at: row.when_at ?? '',
    scheduled_at_ms: row.scheduled_at_ms == null || !Number.isFinite(Number(row.scheduled_at_ms))
      ? null
      : Number(row.scheduled_at_ms),
    reminder_sent: !!row.reminder_sent,
    where_at: row.where_at ?? '',
    location_id: row.location_id ?? null,
    summary: row.summary ?? null,
    duration_minutes: row.duration_minutes == null || !Number.isFinite(Number(row.duration_minutes))
      ? null
      : Number(row.duration_minutes),
    outfit: row.outfit ?? null,
    outfit_state: row.outfit_state ? JSON.parse(row.outfit_state) : null,
    npcs: JSON.parse(row.npcs ?? '[]'),
    company: row.company ?? '',
    created_at: row.created_at,
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
  };
}

export function createDate(d: {
  id: string;
  character_id: string;
  kind?: 'date' | 'call';
  when_at: string;
  where_at: string;
  location_id: string | null;
  company?: string;
  status?: 'scheduled' | 'active';
  scheduled_at_ms?: number | null;
}): DateSession {
  db.prepare(
    `INSERT INTO dates (id, character_id, kind, status, when_at, scheduled_at_ms, where_at, location_id, company, created_at, started_at)
     VALUES (@id, @character_id, @kind, @status, @when_at, @scheduled_at_ms, @where_at, @location_id, @company, @created_at, @started_at)`,
  ).run({
    ...d,
    kind: d.kind ?? 'date',
    status: d.status ?? 'active',
    scheduled_at_ms: d.scheduled_at_ms ?? null,
    company: d.company ?? '',
    created_at: nowIso(),
    started_at: (d.status ?? 'active') === 'active' ? nowIso() : null,
  });
  return getDate(d.id)!;
}

export function getDate(id: string): DateSession | null {
  const row = db.prepare('SELECT * FROM dates WHERE id = ?').get(id) as any;
  return row ? hydrateDate(row) : null;
}

/** What she decided to wear tonight, set once as the date opens. */
export function setDateOutfit(id: string, outfit: string, state?: unknown): void {
  db.prepare('UPDATE dates SET outfit = ?, outfit_state = ? WHERE id = ?').run(outfit, state ? JSON.stringify(state) : null, id);
}

export function setDateNpcs(id: string, npcs: DateNpc[]): void {
  db.prepare('UPDATE dates SET npcs = ? WHERE id = ?').run(JSON.stringify(npcs), id);
}

/**
 * The people from her life he has met on dates: her friend, her girlfriend, the rest of her
 * polycule. Kept in its own column rather than on the Relationship object, so the many
 * read-modify-write saves of a relationship can never drop it.
 */
export function getCircle(characterId: string): DateNpc[] {
  const row = db.prepare('SELECT circle FROM relationships WHERE character_id = ?').get(characterId) as any;
  try {
    return JSON.parse(row?.circle ?? '[]');
  } catch {
    return [];
  }
}

export function setCircle(characterId: string, circle: DateNpc[]): void {
  db.prepare('UPDATE relationships SET circle = ? WHERE character_id = ?').run(JSON.stringify(circle), characterId);
}

/** Her storylines (engine/life.ts). Its own column, like the circle, for the same reason. */
export function getLife(characterId: string): LifeThread[] {
  const row = db.prepare('SELECT life FROM relationships WHERE character_id = ?').get(characterId) as any;
  try {
    return JSON.parse(row?.life ?? '[]');
  } catch {
    return [];
  }
}

export function setLife(characterId: string, threads: LifeThread[]): void {
  db.prepare('UPDATE relationships SET life = ? WHERE character_id = ?').run(JSON.stringify(threads), characterId);
}

/**
 * The one live date or call currently running for this character, if any. Everything that
 * has to stand still while she is with him - texting, wakeups, the scheduler's proactive
 * passes - checks this first. The old name is retained because it is the public repository API.
 */
export function activeDate(characterId: string): DateSession | null {
  const row = db
    .prepare("SELECT * FROM dates WHERE character_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(characterId) as any;
  return row ? hydrateDate(row) : null;
}

/** Any character currently in a live date or call, for the scheduler's per-tick sweep. */
export function characterIdsOnDate(): Set<string> {
  const rows = db.prepare("SELECT DISTINCT character_id FROM dates WHERE status = 'active'").all() as any[];
  return new Set(rows.map((r) => r.character_id as string));
}

/** The next agreed future date. It does not lock chat until explicitly entered. */
export function scheduledDate(characterId: string): DateSession | null {
  const row = db.prepare(
    "SELECT * FROM dates WHERE character_id = ? AND kind = 'date' AND status = 'scheduled' ORDER BY scheduled_at_ms ASC LIMIT 1",
  ).get(characterId) as any;
  return row ? hydrateDate(row) : null;
}

export function dueScheduledDates(nowMs: number): DateSession[] {
  return (db.prepare(
    "SELECT * FROM dates WHERE kind = 'date' AND status = 'scheduled' AND reminder_sent = 0 AND scheduled_at_ms <= ? ORDER BY scheduled_at_ms",
  ).all(nowMs + 10 * 60_000) as any[]).map(hydrateDate);
}

export function markDateReminderSent(id: string): DateSession | null {
  db.prepare("UPDATE dates SET reminder_sent = 1 WHERE id = ? AND status = 'scheduled'").run(id);
  return getDate(id);
}

export function activateScheduledDate(id: string): DateSession | null {
  db.prepare("UPDATE dates SET status = 'active', reminder_sent = 1, started_at = ? WHERE id = ? AND status = 'scheduled'")
    .run(nowIso(), id);
  return getDate(id);
}

export function cancelScheduledDate(id: string): boolean {
  return db.prepare("DELETE FROM dates WHERE id = ? AND status = 'scheduled'").run(id).changes > 0;
}

/** Which live register each busy character is in, for accurate chat-list labels. */
export function activeSessionKinds(): Map<string, 'date' | 'call'> {
  const rows = db.prepare("SELECT character_id, kind FROM dates WHERE status = 'active'").all() as any[];
  return new Map(rows.map((r) => [String(r.character_id), r.kind === 'call' ? 'call' as const : 'date' as const]));
}

export function listDates(characterId: string): DateSession[] {
  const rows = db
    .prepare('SELECT * FROM dates WHERE character_id = ? ORDER BY created_at DESC')
    .all(characterId) as any[];
  return rows.map(hydrateDate);
}

/** When the very first date with her began, if there has been one - for the anniversary check. */
export function firstDateStartedAt(characterId: string): string | null {
  const row = db
    .prepare("SELECT COALESCE(started_at, created_at) AS at FROM dates WHERE character_id = ? AND kind = 'date' AND status != 'scheduled' ORDER BY COALESCE(started_at, created_at) ASC LIMIT 1")
    .get(characterId) as { at: string } | undefined;
  return row?.at ?? null;
}

export function finishDate(id: string, summary: string, durationMinutes: number): DateSession | null {
  db.prepare("UPDATE dates SET status = 'ended', summary = ?, duration_minutes = ?, ended_at = ? WHERE id = ?")
    .run(summary, durationMinutes, nowIso(), id);
  return getDate(id);
}

// ---------------------------------------------------------------- wakeups

export interface Wakeup {
  character_id: string;
  scheduled_at: string;
  reason: string;
  cancel_if_user_writes: boolean;
}

export function setWakeup(w: Wakeup): void {
  db.prepare(
    `INSERT INTO wakeups (character_id, scheduled_at, reason, cancel_if_user_writes)
     VALUES (@character_id, @scheduled_at, @reason, @cancel)
     ON CONFLICT(character_id) DO UPDATE SET scheduled_at = excluded.scheduled_at,
       reason = excluded.reason, cancel_if_user_writes = excluded.cancel_if_user_writes`,
  ).run({ ...w, cancel: w.cancel_if_user_writes ? 1 : 0 });
}

export function clearWakeup(characterId: string): void {
  db.prepare('DELETE FROM wakeups WHERE character_id = ?').run(characterId);
}

export function getWakeup(characterId: string): Wakeup | null {
  const row = db.prepare('SELECT * FROM wakeups WHERE character_id = ?').get(characterId) as any;
  return row ? { ...row, cancel_if_user_writes: !!row.cancel_if_user_writes } : null;
}

export function dueWakeups(at = nowIso()): Wakeup[] {
  const rows = db.prepare('SELECT * FROM wakeups WHERE scheduled_at <= ?').all(at) as any[];
  return rows.map((r) => ({ ...r, cancel_if_user_writes: !!r.cancel_if_user_writes }));
}

export function allWakeups(): Wakeup[] {
  const rows = db.prepare('SELECT * FROM wakeups').all() as any[];
  return rows.map((r) => ({ ...r, cancel_if_user_writes: !!r.cancel_if_user_writes }));
}

// ---------------------------------------------------------------- logs

export function queryLogs(opts: { scope?: string; level?: string; q?: string; limit?: number; before?: number; id?: number }) {
  const where: string[] = [];
  const params: any[] = [];
  // An exact id, for exporting the single entry someone is looking at.
  if (opts.id) { where.push('id = ?'); params.push(opts.id); }
  if (opts.scope) { where.push('scope = ?'); params.push(opts.scope); }
  if (opts.level) { where.push('level = ?'); params.push(opts.level); }
  if (opts.q) { where.push('(message LIKE ? OR payload LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`); }
  if (opts.before) { where.push('id < ?'); params.push(opts.before); }
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(opts.limit ?? 50, 200));
  return (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
