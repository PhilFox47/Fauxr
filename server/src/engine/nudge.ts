import type { Character, Ledger, Relationship } from '../types.js';

/**
 * A per-turn push on the shape of her reply.
 *
 * Left alone, a model answers every message the same way: address what he said, add a
 * line, hand the turn back. Do that twenty times and it reads as an interview. Real
 * conversations lurch - someone goes quiet, someone ignores the question and talks about
 * their day, someone circles back to a thing from Tuesday.
 *
 * Most turns get nothing. The nudges are there to break the pattern, not to script her.
 */

export interface Nudge {
  id: string;
  text: string;
}

function chance(p: number): boolean {
  return Math.random() < p;
}

export function pickNudge(character: Character, rel: Relationship): Nudge | null {
  const seed = character.seed;
  const energy = { low: -0.12, medium: 0, high: 0.14 }[seed.social_energy] ?? 0;
  const warmth = rel.investment / 100;

  // How likely she is to bring her own material rather than only answering.
  const initiative = 0.3 + energy + warmth * 0.25 + (seed.openness_curve === 'fast_then_plateau' ? 0.1 : 0);

  const openThreads: Ledger['open_threads'] = rel.ledger?.open_threads ?? [];

  if (openThreads.length && chance(0.18)) {
    const thread = openThreads[Math.floor(Math.random() * openThreads.length)];
    return {
      id: 'callback',
      text: `Come back to something that was left hanging: "${thread.text}". People do this - they return to things days later, out of nowhere, without explaining why they are bringing it up.`,
    };
  }

  if (chance(initiative)) {
    return {
      id: 'volunteer',
      text:
        'Do not only answer him this turn. Bring something of your own into it - something from your actual day, ' +
        'a thought you were already having, a thing that annoyed you. It does not have to connect to what he said. ' +
        'You are not waiting for prompts; you have your own evening going on.',
    };
  }

  if (chance(0.12)) {
    return {
      id: 'half_present',
      text:
        'You are half paying attention this turn. You are in the middle of something else. Reply short, a bit off, ' +
        'maybe answer only part of what he said. Do not apologise for it or explain it.',
    };
  }

  if (chance(0.14)) {
    return {
      id: 'no_question',
      text:
        'Do not ask him anything this turn. Say your piece and leave it with him. Not every message needs to hand ' +
        'the conversation back.',
    };
  }

  if (seed.message_length !== 'one_liner' && chance(0.1)) {
    return {
      id: 'unprompted_detail',
      text:
        'Overshare slightly this turn. Give him more detail than the question deserved, the way people do when they ' +
        'are comfortable or when something is on their mind.',
    };
  }

  return null;
}
