import { db, nowIso } from './db/index.js';
import { byCategory, find } from './db/attributes.js';
import { newContext, roll } from './engine/dice.js';
import { rollChatGames, rollDomainStance, rollKinkSides, wrongEnd } from './engine/kinks.js';
import type {
  Character, CharacterSeed, CharacterState, DateNpc, DateSession, Direction, Flags, KinkSide, Ledger,
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
  // A game that was removed from the table leaves a hole in her four, and so does one about the
  // other end of a kink from hers ("Make me beg" for a woman who does the edging); she gets a
  // new one in its place.
  const keepGame = (id: string) => {
    const g = find('chat_game', id);
    return !!g && !wrongEnd(g, seed.kink_sides);
  };
  const staleGames = (seed.chat_games ?? []).some((id) => !keepGame(id));
  // Every two-ended domain she is open to needs her end of it (see rollKinkSides).
  const sidesDue = kinkSidesDue(seed);
  if (seed.butt_size && seed.lingerie_style && seed.sleepwear && seed.intimate_grooming && !missingDomains.length && seed.chat_games?.length && !staleGames && !sidesDue) return seed;
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
  if ((!seed.chat_games?.length || staleGames) && byCategory('chat_game').length) {
    const kept = (seed.chat_games ?? []).filter(keepGame);
    const fresh = rollChatGames({ kink_map: seed.kink_map ?? {}, dom_sub_leaning: seed.dom_sub_leaning ?? 0, sexual_persona: seed.sexual_persona, kink_sides: seed.kink_sides });
    seed.chat_games = [...kept, ...fresh.filter((id) => !kept.includes(id))].slice(0, Math.max(fresh.length, kept.length));
  }
  db.prepare('UPDATE characters SET seed = ? WHERE id = ?').run(JSON.stringify(seed), characterId);
  return seed;
}

function hydrateCharacter(row: any): Character {
  let seed = backfillBreastSize(row.id, JSON.parse(row.seed) as CharacterSeed);
  seed = backfillSpecies(row.id, seed);
  seed = backfillCommStyles(row.id, seed);
  seed = backfillSexualProfile(row.id, seed);
  seed = backfillIntimateDetails(row.id, seed);
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
       ORDER BY created_at ASC LIMIT ?`,
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

/**
 * Deletes a character outright, so a cluttered chat list can actually be cleaned up. The
 * relationship, messages, wakeups, dates and image rows all reference the character with
 * ON DELETE CASCADE, so one delete here takes the whole thing with it - the caller only
 * needs to know which image files on disk go with it, which is why this hands them back
 * before they become unreachable.
 */
export function deleteCharacter(id: string): string[] {
  const rows = db
    .prepare(`SELECT path FROM images WHERE character_id = ? AND path IS NOT NULL`)
    .all(id) as { path: string }[];
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  return rows.map((r) => r.path);
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
}): StoredMessage {
  const info = db
    .prepare(
      `INSERT INTO messages (character_id, sender, text, kind, meta, sent_at, read_at, date_id)
       VALUES (@character_id, @sender, @text, @kind, @meta, @sent_at, @read_at, @date_id)`,
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
export function markUserMessagesRead(characterId: string): number {
  return db
    .prepare(
      `UPDATE messages SET read_at = ?
       WHERE character_id = ? AND date_id IS NULL AND sender = 'user' AND read_at IS NULL`,
    )
    .run(nowIso(), characterId).changes;
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
  return { ...row, image_path: row.image_path ?? null };
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
}): Location {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO locations (id, name, description, image_path, created_at, updated_at)
     VALUES (@id, @name, @description, @image_path, @ts, @ts)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
       -- Only replaced when a new one is actually supplied, so editing the description of a
       -- place does not silently drop the backdrop already generated for it.
       image_path = COALESCE(excluded.image_path, locations.image_path),
       updated_at = excluded.updated_at`,
  ).run({
    id: l.id,
    name: l.name,
    description: l.description,
    image_path: l.image_path ?? null,
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
    status: row.status === 'active' ? 'active' : 'ended',
    when_at: row.when_at ?? '',
    where_at: row.where_at ?? '',
    location_id: row.location_id ?? null,
    summary: row.summary ?? null,
    outfit: row.outfit ?? null,
    npcs: JSON.parse(row.npcs ?? '[]'),
    company: row.company ?? '',
    created_at: row.created_at,
    ended_at: row.ended_at ?? null,
  };
}

export function createDate(d: {
  id: string;
  character_id: string;
  when_at: string;
  where_at: string;
  location_id: string | null;
  company?: string;
}): DateSession {
  db.prepare(
    `INSERT INTO dates (id, character_id, status, when_at, where_at, location_id, company, created_at)
     VALUES (@id, @character_id, 'active', @when_at, @where_at, @location_id, @company, @created_at)`,
  ).run({ ...d, company: d.company ?? '', created_at: nowIso() });
  return getDate(d.id)!;
}

export function getDate(id: string): DateSession | null {
  const row = db.prepare('SELECT * FROM dates WHERE id = ?').get(id) as any;
  return row ? hydrateDate(row) : null;
}

/** What she decided to wear tonight, set once as the date opens. */
export function setDateOutfit(id: string, outfit: string): void {
  db.prepare('UPDATE dates SET outfit = ? WHERE id = ?').run(outfit, id);
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

/**
 * The one date currently running for this character, if any. Everything that has to stand
 * still while she is out with him - texting, wakeups, the scheduler's proactive passes -
 * checks this first.
 */
export function activeDate(characterId: string): DateSession | null {
  const row = db
    .prepare("SELECT * FROM dates WHERE character_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(characterId) as any;
  return row ? hydrateDate(row) : null;
}

/** Any character currently mid-date, for the scheduler's per-tick sweep. */
export function characterIdsOnDate(): Set<string> {
  const rows = db.prepare("SELECT DISTINCT character_id FROM dates WHERE status = 'active'").all() as any[];
  return new Set(rows.map((r) => r.character_id as string));
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
    .prepare('SELECT created_at FROM dates WHERE character_id = ? ORDER BY created_at ASC LIMIT 1')
    .get(characterId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function finishDate(id: string, summary: string): DateSession | null {
  db.prepare("UPDATE dates SET status = 'ended', summary = ?, ended_at = ? WHERE id = ?")
    .run(summary, nowIso(), id);
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
