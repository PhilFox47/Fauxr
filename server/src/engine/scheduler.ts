import { getSettings } from '../config.js';
import { find } from '../db/attributes.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  allWakeups, clearWakeup, dueWakeups, firstDateStartedAt, getCharacter, getRelationship, getWakeup,
  characterIdsOnDate, lastMessage, listActiveMatches, pendingUserMessageCount, saveRelationship, setWakeup,
} from '../repo.js';
import type { Character } from '../types.js';
import { isAway, takeTurn } from './chat.js';
import { randInt } from './dice.js';
import { ensureStack } from './matching.js';
import { isOnline, nextOnlineAt, serverWindowOpen } from './presence.js';
import { clampStat } from './modifiers.js';
import { decayArousal } from './stage.js';
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

/**
 * Everyone the scheduler is allowed to make text him. A character who is out on a date is
 * not one of them - see engine/dates.ts - and leaving her in the sweeps would have her
 * double-texting him from across the table.
 */
function contactableMatches(): Character[] {
  const onDate = characterIdsOnDate();
  return listActiveMatches().filter((c) => !onDate.has(c.id));
}

/** The one table the server polls. One row per character, checked once a minute. */
export async function tick(): Promise<void> {
  if (!serverWindowOpen()) return;

  const onDate = characterIdsOnDate();
  for (const w of dueWakeups()) {
    const character = getCharacter(w.character_id);
    if (!character || character.state !== 'matched') {
      clearWakeup(w.character_id);
      continue;
    }
    // Left due rather than cleared: whatever she meant to say is still worth saying once
    // the evening is over, so it simply fires on a tick after the date ends.
    if (onDate.has(character.id)) continue;
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

  answerPendingMessages();
  decayPass();
  maybeDoubleText();
  maybeBeProactive();
  maybeCelebrateMilestone();
  void ensureStack();
  emitPresence();
}

/**
 * A real person who sent something and got no reply for a while will often follow up once -
 * not because he owes her a reply, just because she has more to say or wants to check the
 * message actually landed. This is deliberately separate from maybeBeProactive() below,
 * which reopens a conversation after real distance (hours) has passed: this is the much
 * quicker, much smaller "hey, you still there?" that happens mid-conversation.
 *
 * Both this and maybeBeProactive() share one flag (`rel.mood.followed_up_unanswered`) so at
 * most one unprompted follow-up of EITHER kind goes out per silence, not one of each -
 * without that, a long enough absence used to let a double-text fire and then, hours later,
 * a proactive check-in on top of it, and the two together read as exactly the nagging this
 * was built to avoid. It only clears once he actually replies - see handleUserMessage().
 */
const DOUBLE_TEXT_AFTER_MS = 30 * 60_000;

export function maybeDoubleText(): void {
  for (const character of contactableMatches()) {
    const rel = getRelationship(character.id);
    if (!rel || rel.ghosted_at) continue;
    if (getWakeup(character.id)) continue; // something is already going to wake her
    if ((rel.mood as any)?.followed_up_unanswered) continue; // already followed up once on this silence

    const last = lastMessage(character.id);
    // Only when SHE is the one waiting on a reply - if he spoke last, a turn is either
    // already running or about to be, and there is nothing to follow up on.
    if (!last || last.sender !== 'character') continue;
    if (Date.now() - Date.parse(last.sent_at) < DOUBLE_TEXT_AFTER_MS) continue;

    const at = new Date(Date.now() + randInt(0, 10) * 60_000);
    setWakeup({
      character_id: character.id,
      scheduled_at: at.toISOString(),
      // This exact phrasing reaches the Director as the reason for the turn (see
      // runDirector's actor_report fallback) - the "never annoyed" instruction is stated
      // once, generally, in director_direction.md, but it costs nothing to say it again
      // right where the trigger itself is described.
      reason:
        'a while has passed since her last message and he has not replied yet - if it still ' +
        'feels natural, she can send a quick, low-key follow-up. Never annoyed, hurt or ' +
        'guilt-tripping about the silence - people get busy, that is just normal, not a slight.',
      cancel_if_user_writes: true,
    });
    rel.mood = { ...rel.mood, followed_up_unanswered: true };
    saveRelationship(rel);
    logger.debug('scheduler', `double-text queued for ${character.username}`, { at: at.toISOString() });
  }
}

/**
 * Messages sent while she was offline are read and answered once she is back. Without
 * this nothing ever picks them up: a turn only starts from a due wakeup or from a message
 * arriving while she is already online, so anything written into an empty window sat
 * there until an unrelated wakeup happened to fire.
 *
 * It queues a wakeup a few minutes out rather than replying on the spot, so she does not
 * answer in the same second her window opens.
 */
function answerPendingMessages(): void {
  for (const character of contactableMatches()) {
    if (!isOnline(character)) continue;
    const rel = getRelationship(character.id);
    if (!rel || rel.ghosted_at || isAway(rel)) continue;
    if (getWakeup(character.id)) continue; // a wakeup is already going to wake her
    if (pendingUserMessageCount(character.id) === 0) continue;

    setWakeup({
      character_id: character.id,
      scheduled_at: new Date(Date.now() + randInt(1, 10) * 60_000).toISOString(),
      reason: 'she is back and has unread messages',
      cancel_if_user_writes: true,
    });
    logger.debug('scheduler', `${character.username} is back with unread messages`);
  }
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
    // Arousal is a session mood, not a trait: it is gone in hours, not days.
    rel.arousal = decayArousal(rel.arousal, days * 24);
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
export function maybeBeProactive(): void {
  const settings = getSettings();
  const scheduled = new Set(allWakeups().map((w) => w.character_id));

  for (const character of contactableMatches()) {
    if (scheduled.has(character.id)) continue;
    const rel = getRelationship(character.id);
    if (!rel || rel.ghosted_at) continue;
    // See maybeDoubleText() above - shared with it so a long absence cannot rack up a
    // double-text AND, hours later, a proactive check-in on top of it.
    if ((rel.mood as any)?.followed_up_unanswered) continue;

    const hoursSilent = rel.last_contact_at ? (Date.now() - Date.parse(rel.last_contact_at)) / 3_600_000 : 99;
    if (hoursSilent < 2) continue;

    // Off the attribute row, not a literal id switch - see nudge.ts for why.
    const energy = Number(find('social_energy', character.seed.social_energy)?.extra?.pace ?? 1);
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
    rel.mood = { ...rel.mood, followed_up_unanswered: true };
    saveRelationship(rel);
    logger.debug('scheduler', `proactive wakeup queued for ${character.username}`, { at: at.toISOString() });
  }
}

/**
 * Round day-counts worth marking, and the phrase for each - past the first year it just keeps
 * counting in whole years, so a match that somehow lasts that long is not left with nothing.
 */
const MILESTONE_DAYS: [number, string][] = [
  [7, 'one week'], [30, 'one month'], [90, 'three months'], [180, 'six months'], [365, 'one year'],
];

function milestoneLabel(days: number): string | null {
  const exact = MILESTONE_DAYS.find(([d]) => d === days);
  if (exact) return exact[1];
  if (days > 365 && days % 365 === 0) return `${days / 365} years`;
  return null;
}

/**
 * Real anniversaries, tracked from real timestamps already sitting in the database -
 * `character.matched_at` and the first date's own `created_at` - rather than something the
 * Director has to remember to bring up on its own. This is what makes a milestone "tracked"
 * instead of just occasionally mentioned: the day actually arrives whether or not he happens
 * to message her that day, the same way maybeBeProactive() above already reopens a
 * conversation after real silence rather than waiting to be asked.
 *
 * Already-celebrated milestones live in `rel.mood.milestones_celebrated` (a plain array of
 * "which anchor, which day-count" keys) rather than a new column - mood is already the
 * scheduler's own loose scratch space for exactly this kind of cross-tick memory (see
 * `followed_up_unanswered` above), and a milestone flag has no more claim to a real schema
 * field than that one did.
 */
export function maybeCelebrateMilestone(): void {
  for (const character of contactableMatches()) {
    const rel = getRelationship(character.id);
    if (!rel || rel.ghosted_at) continue;
    if (getWakeup(character.id)) continue; // something is already going to wake her

    const anchors: { key: string; at: string | null; occasion: string }[] = [
      { key: 'matched', at: character.matched_at, occasion: 'you two matched' },
      { key: 'first_date', at: firstDateStartedAt(character.id), occasion: 'your first date' },
    ];
    const celebrated: string[] = (rel.mood as any)?.milestones_celebrated ?? [];

    for (const anchor of anchors) {
      if (!anchor.at) continue;
      const days = Math.floor((Date.now() - Date.parse(anchor.at)) / 86_400_000);
      const label = milestoneLabel(days);
      if (!label) continue;
      const key = `${anchor.key}:${days}`;
      if (celebrated.includes(key)) continue;

      const at = nextOnlineAt(character, new Date(Date.now() + randInt(1, 45) * 60_000));
      if (!at) continue;
      setWakeup({
        character_id: character.id,
        scheduled_at: at.toISOString(),
        reason:
          `today marks exactly ${label} since ${anchor.occasion} - if it feels like her to ` +
          `bring it up, she can, in whatever way actually fits who she is: a big deal, a ` +
          `passing remark, teasing him for probably forgetting. Not mandatory, and never ` +
          `guilt-tripping if he does not react the way she might have hoped.`,
        cancel_if_user_writes: true,
      });
      rel.mood = { ...rel.mood, milestones_celebrated: [...celebrated, key] };
      saveRelationship(rel);
      logger.debug('scheduler', `milestone wakeup queued for ${character.username}`, { milestone: key, at: at.toISOString() });
      // One milestone per tick is plenty - if both anchors somehow land on the same day, the
      // other is still uncelebrated and simply queues on the next tick once this wakeup clears.
      break;
    }
  }
}

let lastPresence = new Map<string, boolean>();

export function clearPresenceCache(): void {
  lastPresence = new Map();
}

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
