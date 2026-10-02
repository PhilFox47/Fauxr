/**
 * The Reconciler: reads her finished reply and records what it made true - where she is, what
 * she has on, whether a photo is going to him now, a fantasy she pitched, a sign-off.
 *
 * Today the Actor reports all of that itself, in the `hidden` half of its JSON. That is the
 * reason the Actor has to be a model that writes clean JSON: the creative call doubles as the
 * bookkeeping call. Splitting the two lets the writer be any model that writes her well, with a
 * manager model doing this narrow extraction afterwards. Before anything relies on it, it runs in
 * shadow: next to every text turn, compared field by field with the Actor's own report, applied
 * to nothing (`shadowReconcile`). `reconcileTurn` and `toActorHidden` are the parts a split
 * pipeline would call for real.
 *
 * The one field it cannot recover from text is `react` (a tapback on his message never appears
 * in her words), and it does not invent her private `thoughts`; both belong to whatever plans
 * the turn, not to whatever reads it afterwards.
 */
import { getSettings } from '../config.js';
import { db, nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { RECONCILER_TURN } from '../llm/schemas.js';
import { isObj } from '../llm/shape.js';
import { logger } from '../log.js';
import { render } from '../prompts/render.js';
import { getUserProfile, type StoredMessage } from '../repo.js';
import type { ActorHidden, Character, Relationship, RoleplayScene } from '../types.js';
import { normalizeOutfitChanges } from './actor.js';
import { fantasyList, historyBlock } from './blocks.js';
import { normalizeScene } from './roleplay.js';
import { applyOutfitChanges, currentOutfit, outfitLines, type Outfit, WORN_SLOTS } from './wardrobe.js';

export type PhotoStatus = 'sent_now' | 'offered' | 'mentioned' | 'none';

export interface TurnRecord {
  mood: string;
  location: string;
  activity: string;
  outfit_changes: { slot: string; state: string | null; item: string | null }[];
  scene: RoleplayScene;
  photo: {
    status: PhotoStatus;
    kind: 'chat' | 'spicy' | null;
    situation: string | null;
    aspect: 'square' | 'portrait' | 'landscape' | null;
    shows_face: boolean | null;
    options: string[] | null;
  };
  fantasy_pitched: number | null;
  new_fantasy: string | null;
  callback_used: string | null;
  in_the_act: boolean;
  ending: 'soft_close' | null;
}

/** Her continuity as it stood when the turn was written - what both reports are read against. */
export interface PreTurnState {
  location: string;
  activity: string;
  outfit: Outfit;
  scene: RoleplayScene;
  callbacks: string[];
  /** A photo she offered on an earlier turn and has not sent yet (split pipeline only). */
  offered: PhotoOffer | null;
}

/** An offered photo, kept as continuity until she sends it or the moment passes. */
export interface PhotoOffer { kind: 'chat' | 'spicy'; situation: string | null; turns_left: number }

export function pendingOffer(rel: Relationship): PhotoOffer | null {
  const o = (rel.mood as any)?.photo_offered;
  return o && (o.kind === 'chat' || o.kind === 'spicy') && o.turns_left > 0 ? o : null;
}

export function snapshotState(rel: Relationship, character: Character): PreTurnState {
  const mood = (rel.mood ?? {}) as Record<string, unknown>;
  const outfit = currentOutfit(rel, character.seed);
  return {
    location: String(mood.location ?? '').trim(),
    activity: String(mood.activity ?? '').trim(),
    outfit: { pieces: outfit.pieces.map((p) => ({ ...p })) },
    scene: normalizeScene(mood.scene),
    callbacks: [...(rel.ledger.callbacks ?? [])],
    offered: pendingOffer(rel),
  };
}

export interface ReconcileInput {
  character: Character;
  before: PreTurnState;
  photosAvailable: boolean;
  /** Messages before this turn, for resolving "this one" and "the one you asked for". */
  context: StoredMessage[];
  /** What he wrote since her last reply; empty when she is texting first. */
  his: string[];
  /** Her visible messages this turn, in order. */
  hers: { text: string; from?: string }[];
  /** She is texting first (opener or initiative): there is nothing of his to answer. */
  turnNote?: string;
  /** A shadow run never holds up a real reply; a live pipeline would be interactive. */
  priority?: 'interactive' | 'background';
  timeoutMs?: number;
}

const PHOTO_STATUSES = new Set<PhotoStatus>(['sent_now', 'offered', 'mentioned', 'none']);
const ASPECTS = new Set(['square', 'portrait', 'landscape']);
const clip = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

/**
 * Into the exact shape, from whatever came back. Mirrors normalizeHidden in actor.ts so the two
 * reports are compared on equal terms, not on which model bent the schema more.
 */
export function normalizeTurnRecord(raw: any, fantasyCount = Infinity): TurnRecord {
  const r = isObj(raw) ? raw : {};
  const p: any = isObj(r.photo) ? r.photo : { status: typeof r.photo === 'string' ? r.photo : r.photo_status };
  const status: PhotoStatus = PHOTO_STATUSES.has(p.status) ? p.status : 'none';
  const kind = p.kind === 'spicy' ? 'spicy' : p.kind === 'chat' ? 'chat' : null;
  // Details only mean something for a photo that exists or is on the table. A sent photo with
  // no kind is still sent; the image step decides the shot, as it does for the Actor today.
  const live = status === 'sent_now' || status === 'offered';
  const options = Array.isArray(p.options)
    ? p.options.map((o: unknown) => clip(o, 300)).filter(Boolean)
    : [];
  const pitched = Number(r.fantasy_pitched);
  return {
    mood: clip(r.mood, 200),
    location: clip(r.location, 200),
    activity: clip(r.activity, 200),
    outfit_changes: normalizeOutfitChanges(r.outfit_changes),
    scene: normalizeScene(r.scene),
    photo: {
      status,
      kind: live ? kind ?? 'chat' : null,
      situation: live ? clip(p.situation, 300) || null : null,
      aspect: live && ASPECTS.has(p.aspect) ? p.aspect : null,
      shows_face: live && typeof p.shows_face === 'boolean' ? p.shows_face : null,
      options: live && options.length === 2 ? options : null,
    },
    fantasy_pitched: Number.isInteger(pitched) && pitched > 0 && pitched <= fantasyCount ? pitched : null,
    new_fantasy: clip(r.new_fantasy, 400) || null,
    callback_used: clip(r.callback_used, 300) || null,
    in_the_act: r.in_the_act === true,
    ending: r.ending === 'soft_close' ? 'soft_close' : null,
  };
}

/** Models wrap the answer ({"record": {...}}) more often than they break JSON. */
function unwrap(value: any): any {
  if (!isObj(value) || 'photo' in value || 'location' in value) return value;
  const inner = Object.values(value).find((v) => isObj(v) && ('photo' in v || 'location' in v));
  return inner ?? value;
}

function stateBlock(before: PreTurnState) {
  const outfit = outfitLines(before.outfit);
  const scene = Object.entries(before.scene).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  return {
    location: before.location || '(not established)',
    activity: before.activity || '(not established)',
    outfit: outfit.length ? outfit.join('\n') : '- nothing',
    scene: scene.length ? `Physical scene:\n${scene.join('\n')}` : 'Physical scene: nothing established.',
  };
}

export function buildReconcilerPrompt(input: ReconcileInput): string {
  const fantasies = fantasyList(input.character.seed);
  const name = input.character.real_name;
  return render('reconciler_turn', {
    char_name: name,
    ...stateBlock(input.before),
    photo_status: input.photosAvailable
      ? 'she can send photos in this chat.'
      : 'the app cannot send her photos right now. Still record what her words say.',
    pending_offer: input.before.offered
      ? `a ${input.before.offered.kind} photo${input.before.offered.situation ? ` - ${input.before.offered.situation}` : ''}`
      : '',
    fantasies: fantasies.length ? fantasies.map((f, i) => `${i + 1}. ${f}`).join('\n') : '(none)',
    callbacks: input.before.callbacks.length ? input.before.callbacks.map((c) => `- ${c}`).join('\n') : '(none)',
    context: historyBlock(input.context, input.character, getUserProfile()),
    his_messages: input.his.map((t) => `- ${t}`).join('\n'),
    turn_note: input.turnNote ?? '',
    her_messages: input.hers.map((m) => `- ${m.from ? `(${m.from}) ` : ''}${m.text}`).join('\n'),
  });
}

export async function reconcileTurn(input: ReconcileInput): Promise<TurnRecord> {
  const settings = getSettings();
  const raw = await completeJson({
    scope: 'director',
    label: `reconcile:${input.character.username}`,
    schema: RECONCILER_TURN,
    config: settings.models.reconciler,
    priority: input.priority ?? 'interactive',
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    require: ['photo'],
    normalize: unwrap,
    messages: [{ role: 'user', content: buildReconcilerPrompt(input) }],
  });
  return normalizeTurnRecord(raw, fantasyList(input.character.seed).length);
}

/**
 * The record as the Actor's own report, for code that applies one (chat.ts). Only a photo that
 * goes out now becomes `photo_offer`; an offered one is continuity for the next turn to act on.
 */
export function toActorHidden(record: TurnRecord, extras: { thoughts?: string; react?: string | null } = {}): ActorHidden {
  const sent = record.photo.status === 'sent_now';
  return {
    thoughts: extras.thoughts ?? '',
    mood: record.mood,
    location: record.location,
    outfit_changes: record.outfit_changes,
    activity: record.activity,
    scene: record.scene,
    callback_used: record.callback_used,
    photo_offer: sent ? record.photo.kind ?? 'chat' : null,
    photo_situation: sent ? record.photo.situation : null,
    photo_aspect: sent ? record.photo.aspect : null,
    photo_shows_face: sent ? record.photo.shows_face : null,
    fantasy_pitched: record.fantasy_pitched,
    new_fantasy: record.new_fantasy,
    react: extras.react ?? null,
    photo_options: sent ? record.photo.options : null,
    in_the_act: record.in_the_act,
    ending: record.ending,
  };
}

// ---------------------------------------------------------------------------------------------
// Shadow mode: compare, store, report.
// ---------------------------------------------------------------------------------------------

/** `agree` is null where the field does not apply to this turn (no photo to compare a kind of). */
export interface FieldResult { agree: boolean | null; actor: unknown; reconciler: unknown }
export type Comparison = Record<string, FieldResult>;

/** Scored fields, in the order the report lists them. mood and scene are stored, not scored. */
export const SCORED_FIELDS = [
  'photo_sent', 'photo_kind', 'photo_choice', 'outfit', 'location', 'activity',
  'fantasy', 'callback', 'in_the_act', 'ending',
] as const;

const STOP = new Set(['a', 'an', 'the', 'my', 'her', 'his', 'at', 'in', 'on', 'of', 'to', 'with', 'and', 'by', 'for', 'from', 'just', 'still', 'now', 'right', 'is', 'she', 'i', 'im', 'having', 'doing', 'getting', 'being', 'some']);
/** Crude stem, enough that "having a smoke" and "smoking" share a word. */
const stem = (w: string) => w.replace(/'s$/, '').replace(/(ing|ed|es|s|e)$/, '');
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1));
}
/** Shared words over the shorter phrase: "my couch" and "the couch in her living room" match. */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size);
}

/**
 * Whether a place/activity report says something new. Both models restate the current place in
 * fresh words on most turns, so a restatement counts as unchanged rather than as a move.
 */
function changedFrom(reported: string, before: string): boolean {
  return !!reported && (!before || overlap(reported, before) < 0.5);
}

function compareSituation(actor: string, rec: string, before: string): FieldResult {
  const a = changedFrom(actor, before);
  const r = changedFrom(rec, before);
  return {
    agree: a === r && (!a || overlap(actor, rec) >= 0.34),
    actor: a ? actor : '(unchanged)',
    reconciler: r ? rec : '(unchanged)',
  };
}

/** Per worn slot: what is there and in what state. Item wording is compared loosely. */
function outfitDiff(a: Outfit, b: Outfit): string[] {
  const differs: string[] = [];
  for (const slot of WORN_SLOTS) {
    const x = a.pieces.filter((p) => p.slot === slot);
    const y = b.pieces.filter((p) => p.slot === slot);
    if (x.length !== y.length) { differs.push(slot); continue; }
    const same = x.every((p, i) => {
      const q = y[i];
      if (p.state !== q.state) return false;
      if (p.id && q.id) return p.id === q.id;
      return p.text.toLowerCase() === q.text.toLowerCase() || overlap(p.text, q.text) >= 0.5;
    });
    if (!same) differs.push(slot);
  }
  return differs;
}

function fantasyOf(h: { fantasy_pitched: number | null; new_fantasy: string | null }): string | null {
  return h.new_fantasy ? 'new' : h.fantasy_pitched ? `#${h.fantasy_pitched}` : null;
}

export function compareWithActor(character: Character, before: PreTurnState, actor: ActorHidden, rec: TurnRecord): Comparison {
  const actorSent = !!actor.photo_offer;
  const recSent = rec.photo.status === 'sent_now';
  const anyPhoto = actorSent || recSent;
  const outfitActor = applyOutfitChanges(character.seed, before.outfit, actor.outfit_changes);
  const outfitRec = applyOutfitChanges(character.seed, before.outfit, rec.outfit_changes);
  const outfitDiffers = outfitDiff(outfitActor, outfitRec);
  const actorCallback = (actor.callback_used ?? '').trim().toLowerCase() || null;
  const recCallback = (rec.callback_used ?? '').trim().toLowerCase() || null;
  return {
    photo_sent: {
      agree: actorSent === recSent,
      actor: actor.photo_offer ? `sent (${actor.photo_offer})` : 'none',
      reconciler: rec.photo.status === 'none' ? 'none' : `${rec.photo.status}${rec.photo.kind ? ` (${rec.photo.kind})` : ''}`,
    },
    photo_kind: {
      agree: actorSent && recSent ? actor.photo_offer === rec.photo.kind : null,
      actor: actor.photo_offer ? { kind: actor.photo_offer, situation: actor.photo_situation } : null,
      reconciler: rec.photo.kind ? { kind: rec.photo.kind, situation: rec.photo.situation } : null,
    },
    photo_choice: {
      agree: anyPhoto ? (actor.photo_options?.length === 2) === !!rec.photo.options : null,
      actor: actor.photo_options?.length === 2 ? actor.photo_options : null,
      reconciler: rec.photo.options,
    },
    outfit: {
      agree: outfitDiffers.length === 0,
      actor: actor.outfit_changes ?? [],
      reconciler: rec.outfit_changes.length || outfitDiffers.length
        ? { changes: rec.outfit_changes, differs: outfitDiffers }
        : [],
    },
    location: compareSituation(actor.location, rec.location, before.location),
    activity: compareSituation(actor.activity, rec.activity, before.activity),
    fantasy: { agree: fantasyOf(actor) === fantasyOf(rec), actor: fantasyOf(actor), reconciler: fantasyOf(rec) },
    callback: { agree: actorCallback === recCallback, actor: actor.callback_used, reconciler: rec.callback_used },
    in_the_act: { agree: actor.in_the_act === rec.in_the_act, actor: actor.in_the_act, reconciler: rec.in_the_act },
    ending: { agree: actor.ending === rec.ending, actor: actor.ending, reconciler: rec.ending },
    mood: { agree: null, actor: actor.mood, reconciler: rec.mood },
    scene: { agree: null, actor: actor.scene, reconciler: rec.scene },
  };
}

export interface ShadowTurn {
  character: Character;
  before: PreTurnState;
  photosAvailable: boolean;
  /** The frozen history the Actor wrote from. */
  history: StoredMessage[];
  actor: ActorHidden;
  messages: { text: string; from?: string }[];
  opener?: boolean;
  initiative?: boolean;
}

/** His messages since her last reply, and the conversation before them. */
export function splitTurn(history: StoredMessage[]): { context: StoredMessage[]; his: string[] } {
  const usable = history.filter((m) => !m.meta?.failed);
  let start = usable.length;
  while (start > 0 && usable[start - 1].sender === 'user') start--;
  const his = usable.slice(start).map((m) => (m.kind === 'image'
    ? `[photo${m.meta?.description ? `: ${m.meta.description}` : ''}] ${m.text}`.trim()
    : m.text));
  return { context: usable.slice(Math.max(0, start - 10), start), his };
}

/**
 * Runs after the turn is delivered and applied, never in its way: errors are stored as rows
 * rather than thrown, and nothing here touches the relationship.
 */
export async function shadowReconcile(turn: ShadowTurn): Promise<void> {
  const settings = getSettings();
  const { context, his } = splitTurn(turn.history);
  const started = Date.now();
  let record: TurnRecord | null = null;
  let error = '';
  try {
    record = await reconcileTurn({
      character: turn.character,
      before: turn.before,
      photosAvailable: turn.photosAvailable,
      context,
      his: turn.opener || turn.initiative ? [] : his,
      hers: turn.messages,
      turnNote: turn.opener
        ? 'She is texting first: this is her very first message to him since they matched.'
        : turn.initiative ? 'She is texting first, on her own impulse.' : undefined,
      priority: 'background',
    });
  } catch (err) {
    error = String(err instanceof Error ? err.message : err).slice(0, 500);
    logger.warn('director', `reconciler shadow failed for ${turn.character.username}`, { error });
  }
  const comparison = record ? compareWithActor(turn.character, turn.before, turn.actor, record) : {};
  db.prepare(`
    INSERT INTO reconciler_shadow (character_id, created_at, model, latency_ms, error, turn, actor, reconciler, comparison)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    turn.character.id,
    nowIso(),
    settings.models.reconciler.model,
    Date.now() - started,
    error,
    JSON.stringify({ his: turn.opener || turn.initiative ? [] : his, hers: turn.messages.map((m) => m.text), before: { location: turn.before.location, activity: turn.before.activity } }),
    JSON.stringify(turn.actor),
    JSON.stringify(record ?? {}),
    JSON.stringify(comparison),
  );
  const misses = Object.entries(comparison).filter(([, f]) => f.agree === false).map(([k]) => k);
  if (record) logger.debug('director', `reconciler shadow for ${turn.character.username}: ${misses.length ? `disagrees on ${misses.join(', ')}` : 'agrees'}`);
}

export interface ShadowReport {
  enabled: boolean;
  model: string;
  turns: number;
  errors: number;
  avg_latency_ms: number;
  fields: { field: string; compared: number; agreed: number }[];
  /** Photo decisions crossed: what the Actor did against what the Reconciler read. */
  photo: { both_sent: number; actor_only: number; reconciler_only: number; neither: number; reconciler_offered: number; reconciler_mentioned: number };
  recent_disagreements: {
    id: number; created_at: string; character: string; fields: string[];
    his: string[]; hers: string[]; detail: Record<string, FieldResult>;
  }[];
}

export function shadowReport(limit = 500): ShadowReport {
  const settings = getSettings();
  const rows = db.prepare(`
    SELECT s.*, c.username AS username FROM reconciler_shadow s
    LEFT JOIN characters c ON c.id = s.character_id
    ORDER BY s.id DESC LIMIT ?
  `).all(Math.max(1, Math.min(limit, 5000))) as any[];
  const fields = new Map<string, { compared: number; agreed: number }>(SCORED_FIELDS.map((f) => [f, { compared: 0, agreed: 0 }]));
  const photo = { both_sent: 0, actor_only: 0, reconciler_only: 0, neither: 0, reconciler_offered: 0, reconciler_mentioned: 0 };
  const recent: ShadowReport['recent_disagreements'] = [];
  let errors = 0;
  let latency = 0;
  for (const row of rows) {
    latency += row.latency_ms;
    if (row.error) { errors++; continue; }
    const comparison = JSON.parse(row.comparison) as Comparison;
    const rec = JSON.parse(row.reconciler) as TurnRecord;
    const actor = JSON.parse(row.actor) as ActorHidden;
    for (const [field, tally] of fields) {
      const result = comparison[field];
      if (!result || result.agree === null) continue;
      tally.compared++;
      if (result.agree) tally.agreed++;
    }
    const a = !!actor.photo_offer;
    const r = rec.photo?.status === 'sent_now';
    if (a && r) photo.both_sent++;
    else if (a) photo.actor_only++;
    else if (r) photo.reconciler_only++;
    else photo.neither++;
    if (rec.photo?.status === 'offered') photo.reconciler_offered++;
    if (rec.photo?.status === 'mentioned') photo.reconciler_mentioned++;
    const missed = SCORED_FIELDS.filter((f) => comparison[f]?.agree === false);
    if (missed.length && recent.length < 25) {
      const turn = JSON.parse(row.turn);
      recent.push({
        id: row.id,
        created_at: row.created_at,
        character: row.username ?? row.character_id,
        fields: missed,
        his: turn.his ?? [],
        hers: turn.hers ?? [],
        detail: Object.fromEntries(missed.map((f) => [f, comparison[f]])),
      });
    }
  }
  return {
    enabled: settings.reconciler_shadow,
    model: settings.models.reconciler.model,
    turns: rows.length,
    errors,
    avg_latency_ms: rows.length ? Math.round(latency / rows.length) : 0,
    fields: [...fields].map(([field, t]) => ({ field, ...t })),
    photo,
    recent_disagreements: recent,
  };
}

export function clearShadowRecords(): void {
  db.exec('DELETE FROM reconciler_shadow');
}
