import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { completeJson } from '../llm/client.js';
import { logger } from '../log.js';
import { getUserProfile, recentMessages, saveRelationship, setWakeup, clearWakeup, type StoredMessage } from '../repo.js';
import { render } from '../prompts/render.js';
import type { ActorHidden, Character, Direction, Relationship } from '../types.js';
import {
  directionBlock, flagsBlock, historyBlock, ledgerBlock, seedBlock,
  spiceDirective, touchstoneHint, userBlock,
} from './blocks.js';
import { describeOnlineTimes, nextOnlineAt, onlineUntil } from './presence.js';
import { currentStage, describeAppetite, describeArousal } from './stage.js';
import { describeFetishProgress, describeHim, describeKinkHits, detectKinkHits, herCuriosity, undiscoveredKeys } from './discovery.js';
import { applyUpdate, type DirectorUpdate } from './state.js';
import { randInt } from './dice.js';

export interface DirectorResult {
  direction: Direction;
  escalation: string;
}

const DEFAULT_DIRECTION: Direction = {
  valid_for: 2,
  expires_on: [],
  mood: 'neutral, a bit distracted',
  energy: 'normal',
  goal: 'find out whether he is interesting',
  stance: 'polite but not warm yet',
  forbidden: ['give out your real name', 'agree to meet', 'go anywhere sexual'],
  bring_up: null,
  unlock: null,
  offline_in_minutes: null,
  length: 'short, 1-2 messages',
  context_blocks: [],
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
    unlock: raw?.unlock ? String(raw.unlock) : null,
    offline_in_minutes:
      typeof raw?.offline_in_minutes === 'number' && raw.offline_in_minutes > 0
        ? Math.min(600, Math.round(raw.offline_in_minutes))
        : null,
    length: String(raw?.length ?? DEFAULT_DIRECTION.length),
    context_blocks: arr(raw?.context_blocks),
  };
}

export interface RunDirectorOptions {
  reason: string;
  actorReport?: ActorHidden | null;
  /** Extra context for the Director that is not in the message history. */
  event?: string;
}

/**
 * One Director pass: score what happened, update stats, flags and ledger, write the next
 * direction and schedule the single wakeup this character is allowed.
 */
export async function runDirector(
  character: Character,
  rel: Relationship,
  opts: RunDirectorOptions,
): Promise<DirectorResult> {
  const settings = getSettings();
  const user = getUserProfile();
  const sinceId = Number((rel.mood as any)?.last_director_msg_id ?? 0);
  const all = recentMessages(character.id, settings.chat.context_messages);
  const since = sinceId ? all.filter((m) => m.id > sinceId) : all;
  const history = since.length ? since : all.slice(-8);
  const offlineAt = onlineUntil(character);

  const stage = currentStage(rel);
  const open = undiscoveredKeys(character, rel);

  const prompt = render('director_direction', {
    stage_label: stage.label,
    stage_what: stage.what,
    stage_next: stage.next,
    her_curiosity: herCuriosity(rel),
    fetish_block: describeFetishProgress(character, rel),
    his_side: describeHim(rel),
    // Only his side of the exchange: this is about what HE brought up, not what she said.
    kink_hits: describeKinkHits(
      detectKinkHits(character, history.filter((m) => m.sender === 'user').map((m) => m.text).join(' ')),
    ),
    arousal: rel.arousal,
    arousal_calibration: describeAppetite(character),
    arousal_description: describeArousal(rel.arousal),
    // Only what is still unknown, so the list shrinks as the profile fills in.
    undiscovered_keys: open.length
      ? open.slice(0, 40).map((f) => `- ${f.key} (${f.label}: ${f.value})`).join('\n')
      : '(he knows everything there is to know)',
    char_real_name: character.real_name,
    char_username: character.username,
    user_block: userBlock(user),
    seed_block: seedBlock(character),
    trust: rel.trust,
    spark: rel.spark,
    investment: rel.investment,
    reciprocity: rel.reciprocity.toFixed(2),
    pressure: rel.pressure.toFixed(2),
    her_tension: rel.her_tension,
    user_tension: rel.user_tension,
    last_contact: rel.last_contact_at ?? 'never',
    now: new Date().toLocaleString('en-GB'),
    offline_at: offlineAt ? offlineAt.toLocaleString('en-GB') : 'not tonight',
    flags_block: flagsBlock(rel.flags),
    spice_directive: spiceDirective(settings.spice),
    ledger_block: ledgerBlock(rel.ledger, { full: true }) || '(empty)',
    previous_direction: rel.active_direction ? directionBlock(rel.active_direction) : '(none yet)',
    actor_report: opts.actorReport
      ? JSON.stringify(opts.actorReport)
      : opts.event ?? `(no actor report - triggered by: ${opts.reason})`,
    history_block: historyBlock(history, character, user),
    touchstone_hint: touchstoneHint(character.seed),
    online_times: describeOnlineTimes(character),
  });

  let parsed: { update?: DirectorUpdate; direction?: any; wakeup?: any };
  try {
    parsed = await completeJson({
      scope: 'director',
      label: `direction:${character.username}:${opts.reason}`,
      config: settings.models.director,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    // Keep playing with the last valid direction rather than stalling the chat.
    logger.error('director', `director call failed for ${character.username}`, { error: String(err) });
    const fallback = rel.active_direction ?? DEFAULT_DIRECTION;
    fallback.valid_for = Math.min(6, fallback.valid_for + 1);
    rel.active_direction = fallback;
    rel.direction_set_at = nowIso();
    saveRelationship(rel);
    return { direction: fallback, escalation: 'none' };
  }

  const result = applyUpdate(character, rel, parsed.update ?? {});
  const direction = sanitizeDirection(parsed.direction);

  rel.active_direction = direction;
  rel.direction_set_at = nowIso();
  const lastId = all.length ? all[all.length - 1].id : sinceId;
  rel.mood = { ...rel.mood, last_director_msg_id: lastId };
  saveRelationship(rel);

  if (result.escalation === 'block' || result.escalation === 'ghost') {
    clearWakeup(character.id);
  } else {
    scheduleWakeup(character, rel, parsed.wakeup);
  }

  return { direction, escalation: result.escalation };
}

/**
 * At most one scheduled wakeup per character. Anything landing outside her online windows
 * is pushed to the next one, plus a random offset so the whole cast does not text at once.
 */
export function scheduleWakeup(character: Character, rel: Relationship, raw: any): void {
  if (!raw || typeof raw !== 'object') return;
  const minutes = Number(raw.in_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    clearWakeup(character.id);
    return;
  }

  const settings = getSettings();
  // The activity slider stretches or compresses how soon she reaches out.
  const activity = Math.max(0.05, settings.activity);
  const investmentBoost = 0.6 + (1 - rel.investment / 100) * 0.8;
  let scaled = (minutes / activity) * investmentBoost;
  scaled = Math.max(10, Math.min(60 * 24 * 5, scaled));

  let at = new Date(Date.now() + scaled * 60_000);
  const online = nextOnlineAt(character, at);
  if (!online) {
    clearWakeup(character.id);
    return;
  }
  if (online.getTime() !== at.getTime()) {
    at = new Date(online.getTime() + randInt(0, 75) * 60_000);
    const recheck = nextOnlineAt(character, at);
    at = recheck ?? online;
  } else {
    at = new Date(at.getTime() + randInt(-5, 20) * 60_000);
  }

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

/** Does this direction still cover the next turn? */
export function directionExpired(
  rel: Relationship,
  hidden: ActorHidden | null,
  events: string[] = [],
): { expired: boolean; reason: string } {
  const d = rel.active_direction;
  if (!d) return { expired: true, reason: 'no direction' };
  if (hidden?.boundary_touched) return { expired: true, reason: 'boundary_touched' };
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
