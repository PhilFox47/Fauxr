import type { Character, OpenThread, Relationship } from '../types.js';
import { freshThreads } from './state.js';

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
  /** Set when the nudge points at a specific open thread, so it can be burned down. */
  threadId?: string;
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

  // Only threads she has not just been on about, so a callback cannot become a fixation.
  const openThreads: OpenThread[] = freshThreads(rel.ledger?.open_threads ?? []);

  /**
   * She has to make moves too. "Getting flirted at" does not happen if every advance has
   * to come from him first, and a character who is visibly keen but never acts on it is
   * the most common way this kind of app falls flat.
   */
  const open = rel.flags?.state?.sexual_topics_allowed;
  const boldness = (seed.sexual_confidence - 2) * 0.06;

  if (open && rel.arousal >= 60 && chance(0.45 + boldness)) {
    return {
      id: 'escalate',
      text:
        'You are the one pushing this turn. Do not wait for him to take it somewhere - take it there ' +
        'yourself, say the specific thing you have been thinking about, or ask him something you ' +
        'genuinely want the answer to. Be direct. You are past being coy about it.',
    };
  }

  if (rel.arousal >= 35 && chance(0.3 + boldness)) {
    return {
      id: 'flirt',
      text:
        'Flirt with him this turn, and mean it. Not a polite compliment - something with an edge, ' +
        'a double meaning, a line that makes him work out whether you meant it. You are interested ' +
        'and you are allowed to let that show.',
    };
  }

  // She hints at something she is into without naming it, and waits to see if he catches it.
  const hiddenFetishes = (seed.fetishes ?? []).filter((f) => !(rel.discovered ?? {})[`fetish:${f}`]);
  if (open && hiddenFetishes.length && rel.arousal >= 45 && chance(0.3)) {
    return {
      id: 'hint_fetish',
      text:
        'Steer towards something you are into that he has not worked out yet. Do not announce it - ' +
        'circle it. A leading question, a detail you did not have to include, a joke you could take ' +
        'back if he does not pick it up. See whether he notices.',
    };
  }

  if (openThreads.length && chance(0.12)) {
    const thread = openThreads[Math.floor(Math.random() * openThreads.length)];
    return {
      id: 'callback',
      threadId: thread.id,
      text:
        `Come back to something that was left hanging: "${thread.text}". People do this - they return to ` +
        'things days later, out of nowhere, without explaining why. Mention it once, in passing, and then ' +
        'let the conversation go wherever he takes it. If he does not pick it up, that is the end of it.',
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
