import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { getUserProfile, listDates, recentMessages, saveRelationship, setWakeup, clearWakeup, type StoredMessage } from '../repo.js';
import { render } from '../prompts/render.js';
import type { ActorHidden, Character, Direction, Relationship } from '../types.js';
import {
  coreBlock,
  dateHistoryFact, directionBlock, fantasiesBlock, historyBlock, ledgerBlock, seedBlock,
  spiceDirective, userBlock,
} from './blocks.js';
import { describeArousal, describePace } from './stage.js';
import { lifeBlockForDirector } from './life.js';
import { isObj, pick, unwrap } from '../llm/shape.js';

const UPDATE_KEYS = ['arousal_delta', 'reason', 'discovered', 'big_secret_revealed', 'fantasies_played'];
const LEDGER_KEYS = ['facts_about_user', 'facts_about_her', 'events', 'what_landed', 'open_threads_add', 'open_threads_close', 'director_notes'];
const DIRECTION_KEYS = ['valid_for', 'expires_on', 'mood', 'energy', 'goal', 'stance', 'forbidden', 'bring_up', 'length'];

/**
 * The Director's reply in {update, direction, wakeup} shape, from however it actually came
 * back. Seen in the log this was built from: update fields and ledger fields hoisted to the top
 * level with no "update" at all, and update fields dropped inside "direction". Every one of
 * those was retried as "empty" and often came back the same way.
 */
export function coerceDirectorReply(value: any): { update: any; direction: any; wakeup: any } {
  const p = unwrap(value, ['update', 'direction', 'goal', 'ledger']);
  const update: any = isObj(p.update) ? { ...p.update } : {};
  const direction: any = isObj(p.direction) ? { ...p.direction } : {};
  for (const k of UPDATE_KEYS) {
    if (update[k] === undefined) {
      const v = pick(p, [k]) ?? (k === 'reason' || k === 'mood' ? undefined : direction[k]);
      if (v !== undefined) update[k] = v;
    }
  }
  const ledger: any = isObj(update.ledger) ? { ...update.ledger } : isObj(p.ledger) ? { ...p.ledger } : {};
  for (const k of LEDGER_KEYS) {
    if (ledger[k] === undefined) {
      const v = p[k] ?? update[k] ?? direction[k];
      if (v !== undefined) ledger[k] = v;
    }
  }
  if (Object.keys(ledger).length) update.ledger = ledger;
  for (const k of DIRECTION_KEYS) {
    // "reason" belongs to the update; "mood" at the top level is the direction's.
    if (direction[k] === undefined && p[k] !== undefined && !(k in update)) direction[k] = p[k];
  }
  return { update, direction, wakeup: p.wakeup ?? null };
}
import { describeFetishProgress, describeHim, describeKinkHits, detectKinkHits, herCuriosity, undiscoveredKeys } from './discovery.js';
import { userCardFullBlock } from './usercard.js';
import { applyUpdate, type DirectorUpdate } from './state.js';
import { randInt } from './dice.js';
import { ensureFantasies } from './generator.js';
import { fantasyLog } from './fantasies.js';
import { hasSwapped } from './images.js';

export interface DirectorResult {
  direction: Direction;
}

/** Used when a Director call fails or comes back hollow, and per-field for a missing field. */
const DEFAULT_DIRECTION: Direction = {
  valid_for: 2,
  expires_on: [],
  mood: 'into him, playful',
  energy: 'normal',
  goal: 'get him going with something of hers - a thought, a confession, a fantasy',
  stance: 'warm, flirty, herself',
  forbidden: [],
  bring_up: null,
  length: 'short, 1-2 messages',
};

function sanitizeDirection(raw: any): Direction {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 8) : [];
  return {
    valid_for: Math.max(1, Math.min(6, Number(raw?.valid_for) || 2)),
    expires_on: arr(raw?.expires_on),
    mood: String(raw?.mood ?? DEFAULT_DIRECTION.mood),
    energy: String(raw?.energy ?? DEFAULT_DIRECTION.energy),
    goal: String(raw?.goal ?? DEFAULT_DIRECTION.goal),
    stance: String(raw?.stance ?? DEFAULT_DIRECTION.stance),
    forbidden: arr(raw?.forbidden),
    bring_up: raw?.bring_up ? String(raw.bring_up) : null,
    length: String(raw?.length ?? DEFAULT_DIRECTION.length),
  };
}

export interface RunDirectorOptions {
  reason: string;
  actorReport?: ActorHidden | null;
  /** Extra context for the Director that is not in the message history. */
  event?: string;
  /**
   * What the direction is being written for: a live exchange with him ('user'), or a moment
   * she is acting on her own ('unprompted' - her opener, a check-in). An unprompted direction
   * is about him being quiet, so it must not outlive his next message.
   */
  origin?: 'user' | 'unprompted';
}

/**
 * One Director pass: note what happened (arousal, discoveries, ledger), write the next
 * direction and schedule the single wakeup this character is allowed.
 */
export async function runDirector(
  character: Character,
  rel: Relationship,
  opts: RunDirectorOptions,
): Promise<DirectorResult> {
  const settings = getSettings();
  const user = getUserProfile();
  // Older characters have no fantasies written yet; this writes them once, in the background.
  // Not awaited: it is a slow call, and a chat turn must never sit waiting on it - she simply
  // has them from the next pass on.
  void ensureFantasies(character);
  const sinceId = Number((rel.mood as any)?.last_director_msg_id ?? 0);
  const all = recentMessages(character.id, settings.chat.context_messages);
  const since = sinceId ? all.filter((m) => m.id > sinceId) : all;
  const history = since.length ? since : all.slice(-8);
  const open = undiscoveredKeys(character, rel);

  const prompt = render('director_direction', {
    pace: describePace(character),
    fantasies_block: fantasiesBlock(character.seed, fantasyLog(rel)) || '(none written yet - she makes them up as she goes, from her kinks)',
    her_curiosity: herCuriosity(character, rel),
    fetish_block: describeFetishProgress(character, rel),
    his_side: describeHim(rel),
    // Only his side of the exchange: this is about what HE brought up, not what she said.
    kink_hits: describeKinkHits(
      detectKinkHits(character, history.filter((m) => m.sender === 'user').map((m) => m.text).join(' ')),
    ),
    arousal: rel.arousal,
    arousal_description: describeArousal(rel.arousal),
    // Only what is still unknown, so the list shrinks as the profile fills in.
    undiscovered_keys: open.length
      ? open.slice(0, 40).map((f) => `- ${f.key} (${f.label}: ${f.value})`).join('\n')
      : '(he knows everything intimate there is to know)',
    char_real_name: character.real_name,
    char_username: character.username,
    user_block: [
      userBlock(user, hasSwapped(rel)),
      hasSwapped(rel) ? '' : 'They have not swapped profile pictures yet, so she cannot send photos until he does. Do not plan photos; teasing about the swap is fine.',
      user ? userCardFullBlock(user) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    seed_block: seedBlock(character),
    core_block: coreBlock(character),
    life_block: lifeBlockForDirector(character.id),
    last_contact: rel.last_contact_at ?? 'never',
    now: new Date().toLocaleString('en-GB'),
    spice_directive: spiceDirective(settings.spice),
    unprompted: settings.unprompted_messages ? '1' : '',
    replies_only: settings.unprompted_messages ? '' : '1',
    ledger_block: ledgerBlock(rel.ledger, { full: true }) || '(empty)',
    previous_direction: rel.active_direction ? directionBlock(rel.active_direction) : '(none yet)',
    actor_report: opts.actorReport
      ? JSON.stringify(opts.actorReport)
      : opts.event ?? `(no actor report - triggered by: ${opts.reason})`,
    history_block: historyBlock(history, character, user),
    date_history: dateHistoryFact(listDates(character.id)),
  });

  let parsed: { update?: DirectorUpdate; direction?: any; wakeup?: any };
  try {
    parsed = await completeJson({
      scope: 'director',
      label: `direction:${character.username}:${opts.reason}`,
      config: settings.models.director,
      messages: [{ role: 'user', content: prompt }],
      require: ['direction', 'update'],
      normalize: coerceDirectorReply,
    });
  } catch (err) {
    // Keep playing with the last valid direction rather than stalling the chat.
    logger.error('director', `director call failed for ${character.username}`, { error: String(err) });
    const fallback = rel.active_direction ?? DEFAULT_DIRECTION;
    fallback.valid_for = Math.min(6, fallback.valid_for + 1);
    rel.active_direction = fallback;
    rel.direction_set_at = nowIso();
    saveRelationship(rel);
    return { direction: fallback };
  }

  applyUpdate(character, rel, parsed.update ?? {});

  /**
   * "direction" being present is not the same as it being usable. `require` above catches
   * the key missing outright; it does not catch `direction: {}`, which parses as present.
   * A well-formed direction always has a "goal", so its absence means the call handed back
   * nothing to act on. sanitizeDirection() would silently fill every field with defaults and
   * that would become her real direction with no error anywhere. Falling back to the previous
   * direction, same as a hard exception above, keeps her in character instead.
   */
  if (!parsed.direction?.goal) {
    logger.error('director', `direction came back empty for ${character.username}`, {
      reason: opts.reason,
      raw: JSON.stringify(parsed.direction ?? null).slice(0, 300),
    });
    // Unlike the exception path above, the call itself did not fail - nothing here suggests
    // the provider is struggling, so there is no reason to back off. Force a retry on the
    // very next turn instead of extending valid_for: a repeat of this exact failure is one
    // bad turn, but stretching a stale direction out for several more (what actually
    // happened in the log this was found from) is the visible symptom that gets reported
    // as "worse than before".
    const fallback = rel.active_direction ?? DEFAULT_DIRECTION;
    fallback.valid_for = Math.min(fallback.valid_for, 1);
    rel.active_direction = fallback;
    rel.direction_set_at = nowIso();
    saveRelationship(rel);
    scheduleWakeup(character, parsed.wakeup);
    return { direction: fallback };
  }

  const direction = sanitizeDirection(parsed.direction);

  rel.active_direction = direction;
  rel.direction_set_at = nowIso();
  const lastId = all.length ? all[all.length - 1].id : sinceId;
  rel.mood = { ...rel.mood, last_director_msg_id: lastId, direction_origin: opts.origin ?? 'user' };
  saveRelationship(rel);
  scheduleWakeup(character, parsed.wakeup);
  return { direction };
}

/**
 * At most one scheduled wakeup per character, with a little jitter so the whole cast does not
 * text at once. She is always reachable, so there is no online window to push it into.
 */
export function scheduleWakeup(character: Character, raw: any): void {
  // With unprompted messages off she only ever answers him, so the Director's wakeup is moot.
  if (!getSettings().unprompted_messages) return;
  if (!raw || typeof raw !== 'object') return;
  const minutes = Number(raw.in_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    clearWakeup(character.id);
    return;
  }

  const settings = getSettings();
  // The activity slider stretches or compresses how soon she reaches out.
  const activity = Math.max(0.05, settings.activity);
  const scaled = Math.max(10, Math.min(60 * 24 * 5, minutes / activity));
  const at = new Date(Date.now() + (scaled + randInt(-5, 20)) * 60_000);

  setWakeup({
    character_id: character.id,
    scheduled_at: at.toISOString(),
    reason: String(raw.reason ?? 'she wants to get in touch'),
    cancel_if_user_writes: raw.cancel_if_user_writes !== false,
  });
  logger.debug('scheduler', `wakeup for ${character.username} at ${at.toISOString()}`, {
    reason: raw.reason,
  });
}

/**
 * A direction written for a different situation than the one his new message creates.
 *
 * Found in a real log: while he was quiet, a check-in had the Director write "no third
 * nudge - she talks about her evening instead, zero mention of the scene". When he finally
 * replied two hours later, that direction was still valid, so she ignored his message and
 * talked about her rice - four times, including three regenerations. A direction written while
 * he was silent expires the moment he writes, and any direction expires if he replies long
 * after it was written.
 */
const DIRECTION_REPLY_WINDOW_MS = 30 * 60_000;

export function directionOutdatedBy(rel: Relationship, userMessageAt: number): boolean {
  if (!rel.active_direction || !rel.direction_set_at) return true;
  const setAt = Date.parse(rel.direction_set_at);
  if (userMessageAt <= setAt) return false; // written after his message: it already covers it
  if ((rel.mood as any)?.direction_origin !== 'user') return true;
  return userMessageAt - setAt > DIRECTION_REPLY_WINDOW_MS;
}

/** Does this direction still cover the next turn? */
export function directionExpired(
  rel: Relationship,
  hidden: ActorHidden | null,
  events: string[] = [],
): { expired: boolean; reason: string } {
  const d = rel.active_direction;
  if (!d) return { expired: true, reason: 'no direction' };
  if (hidden?.director_needed) return { expired: true, reason: 'actor requested director' };
  if (d.valid_for <= 0) return { expired: true, reason: 'valid_for exhausted' };
  for (const e of events) {
    if (d.expires_on?.some((x) => x.toLowerCase() === e.toLowerCase())) {
      return { expired: true, reason: `expires_on ${e}` };
    }
  }
  return { expired: false, reason: '' };
}

/** Detect the expires_on conditions we can recognise in code. */
export function detectEvents(messages: StoredMessage[]): string[] {
  const events: string[] = [];
  const text = messages
    .filter((m) => m.sender === 'user')
    .slice(-2)
    .map((m) => m.text.toLowerCase())
    .join(' ');
  if (!text) return events;
  if (/\b(meet|drink|coffee|dinner|date|see you|come over|hang out)\b/.test(text)) events.push('date_proposal');
  if (/\b(pic|picture|photo|selfie|send me)\b/.test(text)) events.push('photo_request');
  if (/\b(job|work|career|what do you do)\b/.test(text)) events.push('topic:job');
  if (/\b(name|what's your name|whats your name)\b/.test(text)) events.push('topic:name');
  return events;
}
