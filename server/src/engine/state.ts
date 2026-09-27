import { nowIso } from '../db/index.js';
import { gameClockMs } from './clock.js';
import { logger } from '../log.js';
import { saveRelationship } from '../repo.js';
import type { Character, Ledger, OpenThread, Relationship } from '../types.js';
import { buildCatalogue, recordDiscoveries } from './discovery.js';
import { fantasyList } from './blocks.js';
import { markPlayed } from './fantasies.js';

/**
 * What the Director can change after a turn. There is nothing here to win or lose: no
 * trust, no spark, no flags that open doors. What remains is how turned on she is, what
 * he has found out about her, and what she remembers.
 */
export interface DirectorUpdate {
  arousal_delta?: number;
  /** Fact keys from engine/discovery.ts that he genuinely learned this exchange. */
  discovered?: string[];
  /** True on the turn her big secret (if she has one) actually came out. */
  big_secret_revealed?: boolean;
  /** 1-based numbers of her fantasies they actually acted out - sexting it through or on a date. */
  fantasies_played?: number[];
  reason?: string;
  ledger?: {
    facts_about_user?: string[];
    facts_about_her?: string[];
    events?: string[];
    what_landed?: string[];
    pinned_add?: string[];
    pinned_remove?: string[];
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
/**
 * Deliberately small: this list is shown to the Actor in FULL on every turn (never windowed
 * like `facts`), so its whole value is staying short enough to actually read that way. A
 * relationship genuinely accumulating more than this many permanent, never-forget facts -
 * nicknames, running deals, real milestones - is the rare exception, not the norm.
 */
const MAX_PINNED = 15;
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
export function pruneThreads(threads: OpenThread[], now: number): OpenThread[] {
  return threads
    .filter((t) => (t.raised ?? 0) < MAX_RAISES)
    .filter((t) => {
      const age = now - Date.parse(t.created_at ?? new Date(now).toISOString());
      return !Number.isFinite(age) || age < THREAD_MAX_AGE_HOURS * 3_600_000;
    })
    .slice(-MAX_THREADS);
}

/** Record that she actually brought a thread up, so it burns down instead of recurring. */
export function markThreadRaised(rel: Relationship, threadId: string): void {
  const thread = rel.ledger.open_threads?.find((t) => t.id === threadId);
  if (!thread) return;
  const now = gameClockMs(rel);
  thread.raised = (thread.raised ?? 0) + 1;
  thread.last_raised_at = new Date(now).toISOString();
  rel.ledger.open_threads = pruneThreads(rel.ledger.open_threads, now);
}

/** Threads she has not touched recently, i.e. the ones worth coming back to. */
export function freshThreads(threads: OpenThread[], now: number, cooldownHours = 8): OpenThread[] {
  return pruneThreads(threads, now).filter((t) => {
    if (!t.last_raised_at) return true;
    return now - Date.parse(t.last_raised_at) > cooldownHours * 3_600_000;
  });
}

function mergeLedger(ledger: Ledger, patch: DirectorUpdate['ledger'], now: number): Ledger {
  if (!patch) return ledger;
  const next: Ledger = {
    facts: {
      about_user: [...(ledger.facts?.about_user ?? [])],
      about_her: [...(ledger.facts?.about_her ?? [])],
    },
    events: [...(ledger.events ?? [])],
    what_landed: [...(ledger.what_landed ?? [])],
    pinned: [...(ledger.pinned ?? [])],
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
  pushUnique(next.pinned as string[], patch.pinned_add);

  // Retiring a pinned fact (a nickname that changed, a deal that concluded) works the same
  // way closing an open thread does: match on the text itself, case-insensitive.
  const unpinning = new Set((patch.pinned_remove ?? []).map((s) => String(s).trim().toLowerCase()));
  if (unpinning.size) {
    next.pinned = (next.pinned ?? []).filter((p) => !unpinning.has(p.trim().toLowerCase()));
  }

  for (const t of patch.open_threads_add ?? []) {
    const text = String(t?.text ?? '').trim();
    if (!text || next.open_threads.some((x) => x.text === text)) continue;
    next.open_threads.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      expires_when: t.expires_when ?? 'when it comes up',
      created_at: new Date(now).toISOString(),
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

  next.open_threads = pruneThreads(next.open_threads, now);
  next.facts.about_user = next.facts.about_user.slice(-MAX_FACTS);
  next.facts.about_her = next.facts.about_her.slice(-MAX_FACTS);
  next.events = next.events.slice(-MAX_EVENTS);
  next.what_landed = (next.what_landed ?? []).slice(-MAX_LANDED);
  next.pinned = (next.pinned ?? []).slice(-MAX_PINNED);
  next.open_threads = next.open_threads.slice(-MAX_THREADS);
  return next;
}

/** Apply a Director update to the relationship and save it. */
export function applyUpdate(character: Character, rel: Relationship, update: DirectorUpdate): void {
  // Guard against a model inventing a huge swing in one go.
  const arousalDelta = Math.max(-40, Math.min(35, Number(update.arousal_delta ?? 0) || 0));
  rel.arousal = Math.max(0, Math.min(100, rel.arousal + arousalDelta));

  if (update.discovered?.length) {
    const valid = new Set(buildCatalogue(character).map((f) => f.key));
    const added = recordDiscoveries(rel, update.discovered, valid);
    if (added.length) logger.info('director', `${character.username} revealed: ${added.join(', ')}`);
  }
  if (update.big_secret_revealed && character.seed.big_secret && character.seed.big_secret !== 'none') {
    rel.flags.state.big_secret_known = true;
  }

  if (Array.isArray(update.fantasies_played)) {
    const list = fantasyList(character.seed);
    for (const n of update.fantasies_played) {
      const text = list[Number(n) - 1];
      if (text) markPlayed(rel, text);
    }
  }

  rel.ledger = mergeLedger(rel.ledger, update.ledger, gameClockMs(rel));
  if (update.reason) rel.mood = { ...rel.mood, last_reason: update.reason };
  saveRelationship(rel);

  logger.info('director', `update ${character.username}`, {
    arousal: rel.arousal,
    arousal_delta: arousalDelta,
    reason: update.reason,
  });
}
