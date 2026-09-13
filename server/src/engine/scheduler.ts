import { getSettings } from '../config.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  allWakeups, clearWakeup, dueWakeups, getCharacter, getRelationship,
  listActiveMatches, saveRelationship, setWakeup,
} from '../repo.js';
import type { Character, Relationship } from '../types.js';
import { takeTurn } from './chat.js';
import { randInt } from './dice.js';
import { ensureStack } from './matching.js';
import { isOnline, nextOnlineAt, serverWindowOpen } from './presence.js';
import { clampStat } from './modifiers.js';
import { clearExpiredNegativeFlags } from './state.js';

const TICK_MS = 60_000;
/** Investment bleeds away when nothing happens. Roughly this much per day of silence. */
const INVESTMENT_DECAY_PER_DAY = 6;

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  void catchUp().catch((err) => logger.error('scheduler', 'catch-up failed', { error: String(err) }));
  timer = setInterval(() => {
    void tick().catch((err) => logger.error('scheduler', 'tick failed', { error: String(err) }));
  }, TICK_MS);
  logger.info('scheduler', 'scheduler started');
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The one table the server polls. One row per character, checked once a minute. */
export async function tick(): Promise<void> {
  if (!serverWindowOpen()) return;

  for (const w of dueWakeups()) {
    const character = getCharacter(w.character_id);
    if (!character || character.state !== 'matched') {
      clearWakeup(w.character_id);
      continue;
    }
    if (!isOnline(character)) {
      reschedule(character, w.reason, w.cancel_if_user_writes);
      continue;
    }
    clearWakeup(character.id);
    if (w.reason === 'match_opener') {
      bus.emitEvent({ type: 'match', character_id: character.id });
    }
    logger.info('scheduler', `wakeup fired for ${character.username}`, { reason: w.reason });
    void takeTurn(character.id, {
      trigger: w.reason === 'match_opener' ? 'match_opener' : 'wakeup',
      reason: w.reason,
      forceDirector: true,
    }).catch((err) => logger.error('scheduler', 'wakeup turn failed', { error: String(err) }));
  }

  decayPass();
  maybeBeProactive();
  void ensureStack();
  emitPresence();
}

function reschedule(character: Character, reason: string, cancelIfUserWrites: boolean): void {
  const next = nextOnlineAt(character, new Date());
  if (!next) {
    clearWakeup(character.id);
    return;
  }
  // Random offset so the whole cast does not message the moment the window opens.
  const at = new Date(next.getTime() + randInt(2, 90) * 60_000);
  const settled = nextOnlineAt(character, at) ?? next;
  setWakeup({
    character_id: character.id,
    scheduled_at: settled.toISOString(),
    reason,
    cancel_if_user_writes: cancelIfUserWrites,
  });
}

/** Investment decays with time. Trust and spark do not - they need events to move. */
function decayPass(): void {
  const now = Date.now();
  for (const character of listActiveMatches()) {
    const rel = getRelationship(character.id);
    if (!rel) continue;
    const since = Date.parse(rel.last_decay_at ?? rel.last_contact_at ?? nowIso());
    const days = (now - since) / 86_400_000;
    if (days < 0.25) continue;

    const silenceDays = rel.last_contact_at ? (now - Date.parse(rel.last_contact_at)) / 86_400_000 : 0;
    // Decay accelerates the longer the silence lasts.
    const rate = INVESTMENT_DECAY_PER_DAY * (1 + Math.min(2, silenceDays / 3));
    const before = rel.investment;
    rel.investment = clampStat(rel.investment - rate * days);
    rel.last_decay_at = nowIso();
    if (clearExpiredNegativeFlags(rel)) logger.debug('scheduler', `negative flags expired for ${character.username}`);

    if (rel.investment <= 0 && !rel.ghosted_at) {
      rel.ghosted_at = nowIso();
      clearWakeup(character.id);
      logger.info('scheduler', `${character.username} lost interest and is ghosting`);
    }
    saveRelationship(rel);
    if (before !== rel.investment) {
      logger.debug('scheduler', `investment decay ${character.username}: ${before} -> ${rel.investment}`);
    }
  }
}

/**
 * A character who only ever reacts feels like a chatbot. Frequency scales with investment
 * and social energy, and the whole thing is multiplied by the global activity slider.
 */
function maybeBeProactive(): void {
  const settings = getSettings();
  const scheduled = new Set(allWakeups().map((w) => w.character_id));

  for (const character of listActiveMatches()) {
    if (scheduled.has(character.id)) continue;
    const rel = getRelationship(character.id);
    if (!rel || rel.ghosted_at) continue;

    const hoursSilent = rel.last_contact_at ? (Date.now() - Date.parse(rel.last_contact_at)) / 3_600_000 : 99;
    if (hoursSilent < 2) continue;

    const energy = { low: 0.5, medium: 1, high: 1.6 }[character.seed.social_energy] ?? 1;
    // Per-minute probability; deliberately small, the slider is what opens the tap.
    const p =
      0.0025 * settings.activity * energy * (0.3 + rel.investment / 100) * Math.min(3, hoursSilent / 4);
    if (Math.random() > p) continue;

    const at = nextOnlineAt(character, new Date(Date.now() + randInt(1, 45) * 60_000));
    if (!at) continue;
    setWakeup({
      character_id: character.id,
      scheduled_at: at.toISOString(),
      reason: 'she felt like getting in touch',
      cancel_if_user_writes: true,
    });
    logger.debug('scheduler', `proactive wakeup queued for ${character.username}`, { at: at.toISOString() });
  }
}

let lastPresence = new Map<string, boolean>();

function emitPresence(): void {
  const next = new Map<string, boolean>();
  for (const character of listActiveMatches()) {
    const online = isOnline(character);
    next.set(character.id, online);
    if (lastPresence.get(character.id) !== online) {
      bus.emitEvent({ type: 'presence', character_id: character.id, online });
    }
  }
  lastPresence = next;
}

/**
 * Runs on every server start. The machine is off between 02:00 and 06:00, so on boot the
 * world has to be brought forward: overdue wakeups get spread out instead of all firing,
 * time-based decay is applied, stale negative flags are dropped and anyone whose
 * investment ran out starts ghosting.
 */
export async function catchUp(): Promise<void> {
  const overdue = dueWakeups();
  logger.info('scheduler', `catch-up: ${overdue.length} overdue wakeup(s)`);

  for (const w of overdue) {
    const character = getCharacter(w.character_id);
    if (!character || character.state !== 'matched') {
      clearWakeup(w.character_id);
      continue;
    }
    // Never fire a backlog at once: everyone gets pushed into the next window, staggered.
    const base = nextOnlineAt(character, new Date(Date.now() + randInt(3, 120) * 60_000));
    if (!base) {
      clearWakeup(character.id);
      continue;
    }
    setWakeup({
      character_id: character.id,
      scheduled_at: base.toISOString(),
      reason: w.reason,
      cancel_if_user_writes: w.cancel_if_user_writes,
    });
  }

  decayPass();
  await ensureStack();
  logger.info('scheduler', 'catch-up complete');
}

export function relationshipSummary(rel: Relationship) {
  return { trust: rel.trust, spark: rel.spark, investment: rel.investment };
}
