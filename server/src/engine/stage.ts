import { find } from '../db/attributes.js';
import type { Character } from '../types.js';

/**
 * How fast this particular woman moves, as a sentence for the Director and Actor.
 *
 * Nobody has to be won over, but not everyone is the same either: some are all-in from the
 * first message, some like a slow burn and enjoy the build. That is decided by who she is -
 * her libido, how ready she is to sext, how confident she is, and her archetype's pace - and
 * it describes her taste, never a gate he has to get past.
 */
function pacingFor(character: Character): number {
  // Her sexual persona decides this when it says anything; her everyday archetype is the
  // fallback. An insatiable persona runs hot whatever her day-to-day temperament is.
  const persona = find('sexual_persona', character.seed.sexual_persona)?.extra?.pace;
  if (typeof persona === 'number' && persona > 0) return persona;
  const p = find('archetype', character.seed.archetype)?.extra?.pace;
  return typeof p === 'number' && p > 0 ? p : 1;
}

export function describePace(character: Character): string {
  const { libido, sexting_readiness, sexual_confidence } = character.seed;
  const score = ((libido + sexting_readiness + sexual_confidence) / 3) * pacingFor(character);
  const stats = `libido ${libido}/5, sexting readiness ${sexting_readiness}/5, sexual confidence ${sexual_confidence}/5`;
  if (score >= 4) {
    return `${stats}. All in from the start: she matched with him because she wants him and sees no reason to pretend otherwise. She goes there first, often.`;
  }
  if (score >= 3) {
    return `${stats}. Quick to warm up: a bit of flirting and she is already steering it somewhere dirty.`;
  }
  if (score >= 2) {
    return `${stats}. Likes a bit of build-up: she teases, lets the tension grow, and enjoys making it last before she lets go. It is a taste, not a test - she is not waiting for him to earn anything.`;
  }
  return `${stats}. A slow burn: she likes it simmering, suggestive and sideways, for a while. When she does let go it is intense precisely because of the wait. She is still into him from the start.`;
}

export function describeArousal(value: number): string {
  if (value < 15) return 'not remotely in that headspace';
  if (value < 35) return 'warm, not thinking about it particularly';
  if (value < 55) return 'aware of the pull, would not say so unprompted';
  if (value < 75) return 'definitely thinking about it';
  return 'openly wants him, and is bad at hiding it';
}

/** Arousal falls away on its own; nobody stays at a simmer for a day and a half. */
export function decayArousal(value: number, hoursElapsed: number): number {
  const HALF_LIFE_HOURS = 3;
  return Math.round(value * Math.pow(0.5, Math.max(0, hoursElapsed) / HALF_LIFE_HOURS));
}
