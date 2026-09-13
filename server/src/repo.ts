import { db, nowIso } from './db/index.js';
import type {
  Character, CharacterSeed, CharacterState, Direction, Flags, Ledger,
  Relationship, UserProfile,
} from './types.js';

// ---------------------------------------------------------------- user profile

export function getUserProfile(): UserProfile | null {
  const row = db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as any;
  if (!row) return null;
  return {
    display_name: row.display_name,
    age: row.age,
    bio: row.bio,
    photos: JSON.parse(row.photos),
    gender: row.gender,
    seeking: row.seeking,
  };
}

export function saveUserProfile(p: UserProfile): UserProfile {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO user_profile (id, display_name, age, bio, photos, gender, seeking, created_at, updated_at)
     VALUES (1, @display_name, @age, @bio, @photos, @gender, @seeking, @ts, @ts)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, age = excluded.age,
       bio = excluded.bio, photos = excluded.photos, gender = excluded.gender,
       seeking = excluded.seeking, updated_at = excluded.updated_at`,
  ).run({ ...p, photos: JSON.stringify(p.photos ?? []), ts });
  return getUserProfile()!;
}

// ---------------------------------------------------------------- characters

function hydrateCharacter(row: any): Character {
  return {
    id: row.id,
    username: row.username,
    real_name: row.real_name,
    bio: row.bio,
    created_at: row.created_at,
    state: row.state as CharacterState,
    seed: JSON.parse(row.seed) as CharacterSeed,
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

/** The swipe stack: pool characters plus rejected ones whose cooldown has expired. */
export function swipeStack(limit = 10): Character[] {
  const rows = db
    .prepare(
      `SELECT * FROM characters
       WHERE state = 'pool'
          OR (state = 'swiped_left' AND rejection_count < 2 AND reappear_at IS NOT NULL AND reappear_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(nowIso(), limit) as any[];
  return rows.map(hydrateCharacter);
}

export function countPoolAvailable(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM characters
       WHERE state = 'pool'
          OR (state = 'swiped_left' AND rejection_count < 2 AND reappear_at IS NOT NULL AND reappear_at <= ?)`,
    )
    .get(nowIso()) as { n: number };
  return row.n;
}

export function listMatches(): Character[] {
  const rows = db
    .prepare(`SELECT * FROM characters WHERE state IN ('matched','blocked_by_char','blocked_by_user') ORDER BY matched_at DESC`)
    .all() as any[];
  return rows.map(hydrateCharacter);
}

export function listActiveMatches(): Character[] {
  const rows = db.prepare(`SELECT * FROM characters WHERE state = 'matched'`).all() as any[];
  return rows.map(hydrateCharacter);
}

// ---------------------------------------------------------------- relationships

const EMPTY_LEDGER: Ledger = {
  facts: { about_user: [], about_her: [] },
  events: [],
  open_threads: [],
  director_notes: { intent: '', plans: [] },
};

const EMPTY_FLAGS: Flags = { state: {}, events: {}, negative: {} };

function hydrateRelationship(row: any): Relationship {
  return {
    character_id: row.character_id,
    trust: row.trust,
    spark: row.spark,
    investment: row.investment,
    reciprocity: row.reciprocity,
    pressure: row.pressure,
    mood: JSON.parse(row.mood),
    her_tension: row.her_tension,
    user_tension: row.user_tension,
    arousal: row.arousal ?? 0,
    discovered: JSON.parse(row.discovered ?? '{}'),
    last_contact_at: row.last_contact_at,
    last_decay_at: row.last_decay_at,
    flags: { ...EMPTY_FLAGS, ...JSON.parse(row.flags) },
    ledger: { ...EMPTY_LEDGER, ...JSON.parse(row.ledger) },
    active_direction: row.active_direction ? (JSON.parse(row.active_direction) as Direction) : null,
    direction_set_at: row.direction_set_at,
    ghosted_at: row.ghosted_at,
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
    `UPDATE relationships SET trust=@trust, spark=@spark, investment=@investment,
       reciprocity=@reciprocity, pressure=@pressure, mood=@mood, her_tension=@her_tension,
       user_tension=@user_tension, arousal=@arousal, discovered=@discovered,
       last_contact_at=@last_contact_at, last_decay_at=@last_decay_at,
       flags=@flags, ledger=@ledger, active_direction=@active_direction,
       direction_set_at=@direction_set_at, ghosted_at=@ghosted_at
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
}): StoredMessage {
  const info = db
    .prepare(
      `INSERT INTO messages (character_id, sender, text, kind, meta, sent_at, read_at)
       VALUES (@character_id, @sender, @text, @kind, @meta, @sent_at, @read_at)`,
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
    });
  return getMessage(Number(info.lastInsertRowid))!;
}

export function getMessage(id: number): StoredMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  return row ? hydrateMessage(row) : null;
}

export function recentMessages(characterId: string, limit = 40): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT ?')
    .all(characterId, limit) as any[];
  return rows.reverse().map(hydrateMessage);
}

export function messagesSince(characterId: string, sinceId: number): StoredMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE character_id = ? AND id > ? ORDER BY id ASC')
    .all(characterId, sinceId) as any[];
  return rows.map(hydrateMessage);
}

export function lastMessage(characterId: string): StoredMessage | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT 1')
    .get(characterId) as any;
  return row ? hydrateMessage(row) : null;
}

export function unreadCount(characterId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE character_id = ? AND sender = 'character' AND read_at IS NULL")
    .get(characterId) as { n: number };
  return row.n;
}

/** Messages he has sent that she has not seen yet, because she was offline. */
export function pendingUserMessageCount(characterId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE character_id = ? AND sender = 'user' AND read_at IS NULL")
    .get(characterId) as { n: number };
  return row.n;
}

/** Mark the user's messages as seen by her. Only ever called while she is online. */
export function markUserMessagesRead(characterId: string): number {
  return db
    .prepare("UPDATE messages SET read_at = ? WHERE character_id = ? AND sender = 'user' AND read_at IS NULL")
    .run(nowIso(), characterId).changes;
}

export function markCharacterMessagesRead(characterId: string): void {
  db.prepare("UPDATE messages SET read_at = ? WHERE character_id = ? AND sender = 'character' AND read_at IS NULL")
    .run(nowIso(), characterId);
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

export function queryLogs(opts: { scope?: string; level?: string; q?: string; limit?: number; before?: number }) {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.scope) { where.push('scope = ?'); params.push(opts.scope); }
  if (opts.level) { where.push('level = ?'); params.push(opts.level); }
  if (opts.q) { where.push('(message LIKE ? OR payload LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`); }
  if (opts.before) { where.push('id < ?'); params.push(opts.before); }
  const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(opts.limit ?? 50, 200));
  return (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
