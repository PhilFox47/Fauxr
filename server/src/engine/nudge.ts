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

export interface NudgeContext {
  /** Something is still in play, so this is not the turn to start a second topic. */
  somethingLive: boolean;
}

export function pickNudge(
  character: Character,
  rel: Relationship,
  ctx: NudgeContext = { somethingLive: false },
): Nudge | null {
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
  /**
   * Gating her first move behind arousal alone was a chicken-and-egg problem: arousal is a
   * transient, reactive stat that mostly climbs once something sexual has already happened,
   * so a character waiting on it could never be the one to start it - everything had to
   * come from the user first. A character built forward on her seed (confident, high
   * libido) does not need permission from her own mood stat to act like herself; arousal
   * still lowers the bar further once it exists, it just stops being the only way in.
   */
  const forward = seed.sexual_confidence >= 4 || seed.libido >= 4;

  if (
    open &&
    (rel.arousal >= 60 || (forward && seed.sexting_readiness >= 4 && rel.arousal >= 30)) &&
    chance(0.45 + boldness)
  ) {
    return {
      id: 'escalate',
      text:
        'You are the one pushing this turn. Do not wait for him to take it somewhere - take it there ' +
        'yourself, say the specific thing you have been thinking about, or ask him something you ' +
        'genuinely want the answer to. Be direct. You are past being coy about it.',
    };
  }

  if (
    (rel.arousal >= 35 || rel.spark >= 30 || (forward && rel.spark >= 25)) &&
    chance(0.3 + boldness + (forward ? 0.1 : 0))
  ) {
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
  if (open && hiddenFetishes.length && (rel.arousal >= 45 || (forward && rel.arousal >= 30)) && chance(0.3)) {
    return {
      id: 'hint_fetish',
      text:
        'Steer towards something you are into that he has not worked out yet. Do not announce it - ' +
        'circle it. A leading question, a detail you did not have to include, a joke you could take ' +
        'back if he does not pick it up. See whether he notices.',
    };
  }

  /**
   * While a topic is unfinished, nothing may open a second one.
   *
   * The nudges that introduce material used to fire regardless of what was already going
   * on, which produced conversations running two threads in parallel: he starts a guessing
   * game, she answers a guess AND tells an unrelated story about her day, in every message,
   * and neither goes anywhere. The nudges that only change her manner still apply.
   */
  if (ctx.somethingLive) {
    if (chance(0.16)) {
      return {
        id: 'half_present',
        text:
          'You are half paying attention this turn. Reply short, a bit off, maybe answer only part of ' +
          'what he said. Do not apologise for it or explain it.',
      };
    }
    if (chance(0.2)) {
      return {
        id: 'stay_on_it',
        text:
          'Stay on what is already going on. Do not introduce anything new this turn - no stories from ' +
          'your day, no change of subject. Whatever is in play between you right now is the whole message.',
      };
    }
    return null;
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

  /**
   * Curiosity about him, specifically - not sexual, not about her own day. She matched him
   * for a reason and the nudges above only ever bring HER material or push things physically;
   * nothing here pushes her to actually want to know something about him, which "acting
   * interested" needs at least as much as flirting does.
   */
  if (chance(0.22 + energy)) {
    return {
      id: 'curious',
      text:
        'Ask him something real about himself - not small talk, something you actually want to know. Pull on ' +
        'something he already said if there is a thread worth following, rather than starting from nothing.',
    };
  }

  if (chance(initiative)) {
    return {
      id: 'volunteer',
      text:
        'Nothing much is hanging in the air, so bring something of your own into it rather than just ' +
        'answering - something from your actual day, a thought you were already having, a thing that ' +
        'annoyed you, or a question you actually want the answer to. You are not waiting for prompts.',
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
