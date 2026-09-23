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
import { takeTurn } from './chat.js';
import { randInt } from './dice.js';
import { ensureStack } from './matching.js';
import { decayArousal } from './stage.js';

const TICK_MS = 60_000;

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
 * was built to avoid. It only clears once he actually replies - see handleUserMessage() -
 * which is why it alone is not enough: see `UNPROMPTED_COOLDOWN_MS` below for the daily
 * ceiling that holds even across a reply in between.
 */
const DOUBLE_TEXT_AFTER_MS = 30 * 60_000;

/**
 * The hard daily ceiling on top of `followed_up_unanswered`. That flag only guarantees at
 * most one unprompted ping per silence, but it clears the moment he replies - see
 * handleUserMessage() - so a day with several natural back-and-forth gaps could still rack
 * up a double-text in the morning, a reply from him at lunch, and a proactive check-in that
 * evening, each individually fine and together reading as exactly the spam this exists to
 * stop. `rel.mood.last_unprompted_at` is a real timestamp rather than a boolean precisely
 * so it survives a reply in between - it only ever moves forward in time, never resets.
 */
const UNPROMPTED_COOLDOWN_MS = 24 * 3_600_000;

/** True while either an unanswered follow-up is still open or today's one has already gone out. */
function unpromptedOnCooldown(rel: { mood: Record<string, unknown> }): boolean {
  if ((rel.mood as any)?.followed_up_unanswered) return true;
  const last = (rel.mood as any)?.last_unprompted_at;
  return typeof last === 'string' && Date.now() - Date.parse(last) < UNPROMPTED_COOLDOWN_MS;
}

export function maybeDoubleText(): void {
  for (const character of contactableMatches()) {
    const rel = getRelationship(character.id);
    if (!rel) continue;
    if (getWakeup(character.id)) continue; // something is already going to wake her
    if (unpromptedOnCooldown(rel)) continue; // already followed up on this silence, or already sent one today

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
    rel.mood = { ...rel.mood, followed_up_unanswered: true, last_unprompted_at: nowIso() };
    saveRelationship(rel);
    logger.debug('scheduler', `double-text queued for ${character.username}`, { at: at.toISOString() });
  }
}

/**
 * A safety net: a message of his that somehow never got a reply (a failed turn, a restart
 * mid-turn) gets picked up a few minutes later instead of sitting there forever.
 */
function answerPendingMessages(): void {
  for (const character of contactableMatches()) {
    if (getWakeup(character.id)) continue; // a wakeup is already going to wake her
    if (pendingUserMessageCount(character.id) === 0) continue;
    const last = lastMessage(character.id);
    // Give a normal turn time to finish before treating the message as missed.
    if (!last || last.sender !== 'user' || Date.now() - Date.parse(last.sent_at) < 3 * 60_000) continue;

    setWakeup({
      character_id: character.id,
      scheduled_at: new Date(Date.now() + randInt(0, 2) * 60_000).toISOString(),
      reason: 'she has unread messages from him',
      cancel_if_user_writes: true,
    });
    logger.debug('scheduler', `${character.username} has unanswered messages`);
  }
}

/** Arousal is a session mood, not a trait: it fades in hours. Nothing else decays. */
function decayPass(): void {
  const now = Date.now();
  for (const character of listActiveMatches()) {
    const rel = getRelationship(character.id);
    if (!rel) continue;
    const since = Date.parse(rel.last_decay_at ?? rel.last_contact_at ?? nowIso());
    const hours = (now - since) / 3_600_000;
    if (hours < 1) continue;
    rel.arousal = decayArousal(rel.arousal, hours);
    rel.last_decay_at = nowIso();
    saveRelationship(rel);
  }
}

/**
 * A character who only ever reacts feels like a chatbot. Frequency scales with her social
 * energy and libido, and the whole thing is multiplied by the global activity slider.
 */
export function maybeBeProactive(): void {
  const settings = getSettings();
  const scheduled = new Set(allWakeups().map((w) => w.character_id));

  for (const character of contactableMatches()) {
    if (scheduled.has(character.id)) continue;
    const rel = getRelationship(character.id);
    if (!rel) continue;
    // See maybeDoubleText() above - shared with it so a long absence cannot rack up a
    // double-text AND, hours later, a proactive check-in on top of it, and so the two
    // together still cannot exceed one unprompted ping in any rolling 24 hours.
    if (unpromptedOnCooldown(rel)) continue;

    const hoursSilent = rel.last_contact_at ? (Date.now() - Date.parse(rel.last_contact_at)) / 3_600_000 : 99;
    if (hoursSilent < 2) continue;

    // Off the attribute row, not a literal id switch - see nudge.ts for why.
    const energy = Number(find('social_energy', character.seed.social_energy)?.extra?.pace ?? 1);
    // Per-minute probability; deliberately small, the slider is what opens the tap.
    const appetite = 0.5 + character.seed.libido / 5;
    const p = 0.0025 * settings.activity * energy * appetite * Math.min(3, hoursSilent / 4);
    if (Math.random() > p) continue;

    const at = new Date(Date.now() + randInt(1, 45) * 60_000);
    setWakeup({
      character_id: character.id,
      scheduled_at: at.toISOString(),
      reason: 'she felt like getting in touch - something on her mind, maybe one of her fantasies, maybe a photo',
      cancel_if_user_writes: true,
    });
    rel.mood = { ...rel.mood, followed_up_unanswered: true, last_unprompted_at: nowIso() };
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
    if (!rel) continue;
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

      const at = new Date(Date.now() + randInt(1, 45) * 60_000);
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

/**
 * Runs on every server start: overdue wakeups get spread out instead of all firing at once,
 * and arousal is decayed for the time the server was off.
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
    // Never fire a backlog at once: stagger it over the next half hour.
    const base = new Date(Date.now() + randInt(1, 30) * 60_000);
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
