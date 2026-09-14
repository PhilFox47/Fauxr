import { nowIso } from '../db/index.js';
import { logger } from '../log.js';
import { saveRelationship, setCharacterState, clearWakeup } from '../repo.js';
import type { Character, Ledger, OpenThread, Relationship, StateFlags } from '../types.js';
import { applyModifiers, clampStat, type Deltas } from './modifiers.js';
import { buildCatalogue, recordDiscoveries } from './discovery.js';

export const STATE_FLAGS: (keyof StateFlags)[] = [
  'real_name_known',
  'profile_picture_sent',
  'personal_photos_allowed',
  'sexual_topics_allowed',
  'spicy_photos_allowed',
  'allows_date_requests',
  'has_had_first_date',
];

export const EVENT_FLAGS = [
  'first_compliment_accepted',
  'first_personal_story_told',
  'first_conflict_resolved',
  'first_time_she_initiated',
  'first_rejection_survived',
  'first_voice_message',
];

/** Negative flags expire on their own; this is how long each one lingers. */
export const NEGATIVE_FLAG_HOURS: Record<string, number> = {
  boundary_crossed_recent: 48,
  came_on_too_strong: 36,
  caught_in_inconsistency: 96,
  ghosted_by_user: 168,
  dealbreaker_hit: 8760,
};

export interface DirectorUpdate {
  trust_delta?: number;
  spark_delta?: number;
  investment_delta?: number;
  her_tension?: number;
  arousal_delta?: number;
  /** Fact keys from engine/discovery.ts that he genuinely learned this exchange. */
  discovered?: string[];
  reason?: string;
  set_flags?: string[];
  clear_flags?: string[];
  event_flags?: string[];
  negative_flags?: string[];
  escalate?: string;
  ledger?: {
    facts_about_user?: string[];
    facts_about_her?: string[];
    events?: string[];
    what_landed?: string[];
    open_threads_add?: { text: string; expires_when?: string }[];
    open_threads_close?: string[];
    director_notes?: { intent?: string; plans?: { text: string; expires_when?: string }[] };
  };
}

const MAX_FACTS = 60;
const MAX_EVENTS = 50;
/** Short on purpose: this is the shortlist she reaches back into, not a transcript. */
const MAX_LANDED = 12;
const MAX_THREADS = 4;
/** A thread she has raised this many times is spent, whether or not he engaged. */
const MAX_RAISES = 2;
const THREAD_MAX_AGE_HOURS = 72;

/**
 * Threads expire on their own.
 *
 * `expires_when` was recorded and then never acted on, so nothing ever left the list: a
 * thread stayed in the ledger, in every actor prompt and in the callback pool forever.
 * The result was a character who brought up the same anecdote every few messages and
 * started keeping score of whether he had engaged with it. A thread gets a couple of
 * outings and a few days, then it is done, engaged with or not - which is how it works
 * when a person mentions something and the other person does not bite.
 */
export function pruneThreads(threads: OpenThread[]): OpenThread[] {
  const now = Date.now();
  return threads
    .filter((t) => (t.raised ?? 0) < MAX_RAISES)
    .filter((t) => {
      const age = now - Date.parse(t.created_at ?? new Date().toISOString());
      return !Number.isFinite(age) || age < THREAD_MAX_AGE_HOURS * 3_600_000;
    })
    .slice(-MAX_THREADS);
}

/** Record that she actually brought a thread up, so it burns down instead of recurring. */
export function markThreadRaised(rel: Relationship, threadId: string): void {
  const thread = rel.ledger.open_threads?.find((t) => t.id === threadId);
  if (!thread) return;
  thread.raised = (thread.raised ?? 0) + 1;
  thread.last_raised_at = nowIso();
  rel.ledger.open_threads = pruneThreads(rel.ledger.open_threads);
}

/** Threads she has not touched recently, i.e. the ones worth coming back to. */
export function freshThreads(threads: OpenThread[], cooldownHours = 8): OpenThread[] {
  const now = Date.now();
  return pruneThreads(threads).filter((t) => {
    if (!t.last_raised_at) return true;
    return now - Date.parse(t.last_raised_at) > cooldownHours * 3_600_000;
  });
}

function mergeLedger(ledger: Ledger, patch: DirectorUpdate['ledger']): Ledger {
  if (!patch) return ledger;
  const next: Ledger = {
    facts: {
      about_user: [...(ledger.facts?.about_user ?? [])],
      about_her: [...(ledger.facts?.about_her ?? [])],
    },
    events: [...(ledger.events ?? [])],
    what_landed: [...(ledger.what_landed ?? [])],
    open_threads: [...(ledger.open_threads ?? [])],
    director_notes: {
      intent: ledger.director_notes?.intent ?? '',
      plans: [...(ledger.director_notes?.plans ?? [])],
    },
  };

  const pushUnique = (arr: string[], items: string[] | undefined) => {
    for (const item of items ?? []) {
      const t = String(item).trim();
      if (t && !arr.includes(t)) arr.push(t);
    }
  };
  pushUnique(next.facts.about_user, patch.facts_about_user);
  pushUnique(next.facts.about_her, patch.facts_about_her);
  pushUnique(next.events, patch.events);
  pushUnique(next.what_landed as string[], patch.what_landed);

  for (const t of patch.open_threads_add ?? []) {
    const text = String(t?.text ?? '').trim();
    if (!text || next.open_threads.some((x) => x.text === text)) continue;
    next.open_threads.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      expires_when: t.expires_when ?? 'when it comes up',
      created_at: nowIso(),
    });
  }
  const closing = new Set((patch.open_threads_close ?? []).map((s) => String(s).trim().toLowerCase()));
  if (closing.size) {
    next.open_threads = next.open_threads.filter(
      (t) => !closing.has(t.id.toLowerCase()) && !closing.has(t.text.trim().toLowerCase()),
    );
  }

  if (patch.director_notes?.intent) next.director_notes.intent = patch.director_notes.intent;
  if (patch.director_notes?.plans) {
    next.director_notes.plans = patch.director_notes.plans
      .filter((p) => p?.text)
      .slice(0, 4)
      .map((p) => ({ text: p.text, expires_when: p.expires_when ?? 'soon' }));
  }

  next.open_threads = pruneThreads(next.open_threads);
  next.facts.about_user = next.facts.about_user.slice(-MAX_FACTS);
  next.facts.about_her = next.facts.about_her.slice(-MAX_FACTS);
  next.events = next.events.slice(-MAX_EVENTS);
  next.what_landed = (next.what_landed ?? []).slice(-MAX_LANDED);
  next.open_threads = next.open_threads.slice(-MAX_THREADS);
  return next;
}

export interface ApplyResult {
  applied: Deltas;
  escalation: string;
}

/**
 * Apply a Director update to the relationship. The LLM deltas go through the code
 * modifiers first - the LLM never has the last word on the numbers.
 */
export function applyUpdate(
  character: Character,
  rel: Relationship,
  update: DirectorUpdate,
): ApplyResult {
  const raw: Deltas = {
    trust: Number(update.trust_delta ?? 0) || 0,
    spark: Number(update.spark_delta ?? 0) || 0,
    investment: Number(update.investment_delta ?? 0) || 0,
  };
  // Guard against a cheap model inventing a huge swing.
  const cap = (v: number) => Math.max(-25, Math.min(10, v));
  const capped: Deltas = { trust: cap(raw.trust), spark: cap(raw.spark), investment: cap(raw.investment) };
  const applied = applyModifiers(capped, rel.reciprocity, rel.pressure);

  rel.trust = clampStat(rel.trust + applied.trust);
  rel.spark = clampStat(rel.spark + applied.spark);
  rel.investment = clampStat(rel.investment + applied.investment);
  if (typeof update.her_tension === 'number') {
    rel.her_tension = Math.max(0, Math.min(10, Math.round(update.her_tension)));
  }

  // Arousal moves freely but never past what this character is capable of over text.
  const arousalDelta = Math.max(-40, Math.min(30, Number(update.arousal_delta ?? 0) || 0));
  rel.arousal = Math.max(0, Math.min(100, rel.arousal + arousalDelta));

  if (update.discovered?.length) {
    const valid = new Set(buildCatalogue(character).map((f) => f.key));
    const added = recordDiscoveries(rel, update.discovered, valid);
    if (added.length) logger.info('director', `${character.username} revealed: ${added.join(', ')}`);
  }

  for (const f of update.set_flags ?? []) {
    if (STATE_FLAGS.includes(f as keyof StateFlags)) (rel.flags.state as any)[f] = true;
  }
  for (const f of update.clear_flags ?? []) {
    if (STATE_FLAGS.includes(f as keyof StateFlags)) (rel.flags.state as any)[f] = false;
  }
  for (const f of update.event_flags ?? []) {
    if (EVENT_FLAGS.includes(f) && !(rel.flags.events as any)[f]) (rel.flags.events as any)[f] = nowIso();
  }
  for (const f of update.negative_flags ?? []) {
    const hours = NEGATIVE_FLAG_HOURS[f];
    if (!hours) continue;
    rel.flags.negative[f] = new Date(Date.now() + hours * 3600_000).toISOString();
  }

  rel.ledger = mergeLedger(rel.ledger, update.ledger);
  if (update.reason) {
    rel.mood = { ...rel.mood, last_reason: update.reason };
  }

  const escalation = String(update.escalate ?? 'none');
  applyEscalation(character, rel, escalation);
  saveRelationship(rel);

  logger.info('director', `stats ${character.username}`, {
    raw: capped,
    applied,
    reciprocity: rel.reciprocity,
    pressure: rel.pressure,
    trust: rel.trust,
    spark: rel.spark,
    investment: rel.investment,
    reason: update.reason,
    escalate: escalation,
  });
  return { applied, escalation };
}

/** Three-stage failure: cool off, ghost, block. */
export function applyEscalation(character: Character, rel: Relationship, escalation: string): void {
  switch (escalation) {
    case 'cool_off':
      rel.investment = clampStat(rel.investment - 8);
      rel.mood = { ...rel.mood, cooling: true };
      break;
    case 'ghost':
      rel.ghosted_at = nowIso();
      clearWakeup(character.id);
      logger.info('director', `${character.username} is ghosting the user`);
      break;
    case 'block':
      setCharacterState(character.id, 'blocked_by_char');
      clearWakeup(character.id);
      rel.ghosted_at = nowIso();
      logger.warn('director', `${character.username} blocked the user`);
      break;
    case 'warm':
      rel.mood = { ...rel.mood, cooling: false };
      rel.ghosted_at = null;
      break;
    default:
      break;
  }
}

export function clearExpiredNegativeFlags(rel: Relationship): boolean {
  const now = Date.now();
  let changed = false;
  for (const [flag, until] of Object.entries(rel.flags.negative ?? {})) {
    if (Date.parse(until) <= now) {
      delete rel.flags.negative[flag];
      changed = true;
    }
  }
  return changed;
}

export function hasActiveNegativeFlag(rel: Relationship): boolean {
  const now = Date.now();
  return Object.values(rel.flags.negative ?? {}).some((until) => Date.parse(until) > now);
}
