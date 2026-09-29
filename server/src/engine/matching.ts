import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { logger } from '../log.js';
import {
  countPoolAvailable, getCharacter, getRelationship, saveRelationship,
  listVisibleMatches, setCharacterState, setWakeup, swipeStack,
} from '../repo.js';
import type { Character } from '../types.js';
import { generateCharacter } from './generator.js';
import { randInt } from './dice.js';
import { coreTraits } from './profilecard.js';
import { gameNowIso } from './clock.js';
import { takeTurn } from './chat.js';

export const STACK_SIZE = 10;

let queued = 0;
let draining = false;

export function stack(): Character[] {
  return swipeStack(STACK_SIZE);
}

/**
 * Keep ten swipeable profiles available. Generation runs in the background and strictly
 * one at a time: each character is written knowing the bios already in the stack, which
 * is what stops them converging on one joke. It also keeps the API load flat.
 */
export async function ensureStack(): Promise<void> {
  const missing = STACK_SIZE - countPoolAvailable() - queued;
  if (missing <= 0) return;
  queued += missing;
  bus.emitEvent({ type: 'generating', count: queued });
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queued > 0) {
      try {
        await generateCharacter();
        bus.emitEvent({ type: 'stack', count: countPoolAvailable() });
      } catch (err) {
        logger.error('generator', 'character generation failed', { error: String(err) });
      } finally {
        queued--;
        bus.emitEvent({ type: 'generating', count: queued });
      }
    }
  } finally {
    draining = false;
  }
}

export function generatingCount(): number {
  return queued;
}

/** Drop any queued generation work. The in-flight character, if any, is discarded. */
export function resetGenerationQueue(): void {
  queued = 0;
}

export interface MatchResult {
  matched: true;
  instant: boolean;
  /** When the match becomes visible. Equal to now for instant matches. */
  at: string;
}

/**
 * Every right swipe matches, but not at the same speed - and either way, she is the one who
 * opens (see AGENTS.md: characters drive, they do not wait to be spoken to). An instant match
 * means she had already liked him, so she is quick about it - the opener fires right away
 * rather than waiting for the scheduler's own once-a-minute tick, since a "she already liked
 * you" match reading as instant matters more here than anywhere else. A delayed match means
 * she saw him after the fact: the match itself stays invisible until then, and she opens the
 * moment it lands, exactly as before.
 */
export function swipeRight(characterId: string): MatchResult {
  const character = getCharacter(characterId);
  if (!character) throw new Error('character not found');

  const instant = Math.random() < 0.4;
  const delayMinutes = instant ? 0 : randInt(1, 5);
  const at = new Date(Date.now() + delayMinutes * 60_000);

  setCharacterState(characterId, 'matched', { matched_at: at.toISOString(), reappear_at: null });

  if (instant) {
    void takeTurn(characterId, { trigger: 'match_opener', forceDirector: true }).catch((err) =>
      logger.error('actor', 'match opener turn failed', { error: String(err) }),
    );
  } else {
    // She writes first, once the match lands.
    setWakeup({
      character_id: characterId,
      scheduled_at: at.toISOString(),
      reason: 'match_opener',
      cancel_if_user_writes: false,
    });
  }

  const rel = getRelationship(characterId);
  if (rel) {
    rel.last_contact_at = gameNowIso(rel);
    rel.last_decay_at = gameNowIso(rel);
    // Whatever intimate thing her card showed (who she is in bed, her signature kink) he
    // swiped knowing, so it counts as found out rather than something she has to reveal.
    for (const t of coreTraits(character.seed, character.id)) {
      if (t.intimate && !rel.discovered?.[t.key]) rel.discovered = { ...(rel.discovered ?? {}), [t.key]: nowIso() };
    }
    saveRelationship(rel);
  }

  logger.info('app', `matched ${character.username} (${instant ? 'instant' : `delayed ${delayMinutes}min`})`);
  if (instant) bus.emitEvent({ type: 'match', character_id: characterId });
  void ensureStack();

  return {
    matched: true,
    instant,
    at: at.toISOString(),
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
  return listVisibleMatches(nowIso());
}
