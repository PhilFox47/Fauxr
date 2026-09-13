import { db, nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  countPoolAvailable, getCharacter, getRelationship, saveRelationship,
  setCharacterState, setWakeup, swipeStack,
} from '../repo.js';
import type { Character } from '../types.js';
import { generateCharacter } from './generator.js';
import { randInt } from './dice.js';
import { nextOnlineAt } from './presence.js';

export const STACK_SIZE = 10;

let generating = 0;

export function stack(): Character[] {
  return swipeStack(STACK_SIZE);
}

/** Keep ten swipeable profiles available. Generation runs in the background. */
export async function ensureStack(): Promise<void> {
  const missing = STACK_SIZE - countPoolAvailable() - generating;
  if (missing <= 0) return;
  for (let i = 0; i < missing; i++) void generateOne();
}

async function generateOne(): Promise<void> {
  generating++;
  bus.emitEvent({ type: 'generating', count: generating });
  try {
    await generateCharacter();
    bus.emitEvent({ type: 'stack', count: countPoolAvailable() });
  } catch (err) {
    logger.error('generator', 'character generation failed', { error: String(err) });
  } finally {
    generating--;
    bus.emitEvent({ type: 'generating', count: generating });
  }
}

export function generatingCount(): number {
  return generating;
}

export interface MatchResult {
  matched: true;
  instant: boolean;
  /** When the match becomes visible. Equal to now for instant matches. */
  at: string;
  who_writes_first: 'user' | 'character';
}

/**
 * Every right swipe matches, but not at the same speed. An instant match means she had
 * already liked him - so the ball is in his court. A delayed match means she saw him after
 * the fact, and she opens.
 */
export function swipeRight(characterId: string): MatchResult {
  const character = getCharacter(characterId);
  if (!character) throw new Error('character not found');

  const instant = Math.random() < 0.4;
  const delayMinutes = instant ? 0 : randInt(1, 5);
  const at = new Date(Date.now() + delayMinutes * 60_000);

  setCharacterState(characterId, 'matched', { matched_at: at.toISOString(), reappear_at: null });

  if (!instant) {
    // She writes first, once the match lands and she is online.
    const online = nextOnlineAt(character, at) ?? at;
    setWakeup({
      character_id: characterId,
      scheduled_at: online.toISOString(),
      reason: 'match_opener',
      cancel_if_user_writes: false,
    });
  }

  const rel = getRelationship(characterId);
  if (rel) {
    rel.last_contact_at = nowIso();
    rel.last_decay_at = nowIso();
    saveRelationship(rel);
  }

  logger.info('app', `matched ${character.username} (${instant ? 'instant' : `delayed ${delayMinutes}min`})`);
  if (instant) bus.emitEvent({ type: 'match', character_id: characterId });
  void ensureStack();

  return {
    matched: true,
    instant,
    at: at.toISOString(),
    who_writes_first: instant ? 'user' : 'character',
  };
}

/** Rejected profiles come back once after three to seven days, then never again. */
export function swipeLeft(characterId: string): { gone: boolean; reappear_at: string | null } {
  const character = getCharacter(characterId);
  if (!character) throw new Error('character not found');
  const count = character.rejection_count + 1;

  if (count >= 2) {
    setCharacterState(characterId, 'swiped_left', { rejection_count: count, reappear_at: null });
    void ensureStack();
    return { gone: true, reappear_at: null };
  }

  const at = new Date(Date.now() + randInt(3, 7) * 24 * 3_600_000);
  setCharacterState(characterId, 'swiped_left', { rejection_count: count, reappear_at: at.toISOString() });
  void ensureStack();
  return { gone: false, reappear_at: at.toISOString() };
}

/** Matches whose delay has elapsed. Delayed matches are invisible until then. */
export function visibleMatches(): Character[] {
  const rows = db
    .prepare(
      `SELECT id FROM characters
       WHERE state IN ('matched','blocked_by_char','blocked_by_user')
         AND (matched_at IS NULL OR matched_at <= ?)
       ORDER BY matched_at DESC`,
    )
    .all(nowIso()) as { id: string }[];
  return rows.map((r) => getCharacter(r.id)!).filter(Boolean);
}
