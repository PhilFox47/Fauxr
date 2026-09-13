import type { Character, Relationship } from '../types.js';

/**
 * Where this conversation has got to, and what should be happening next.
 *
 * A chat with no sense of phase reads the same on message four and message eighty: both
 * people politely exchanging facts. Real dating chats have an arc - openers, actual
 * curiosity, the first flirting, the point where someone says what they want. The Director
 * gets told which phase it is in and what would move it on, so there is something pulling
 * the conversation forward instead of it circling.
 *
 * Derived in code from stats and flags, never chosen by a model.
 */

export type StageId = 'opening' | 'curious' | 'warming' | 'flirting' | 'intimate' | 'meeting';

export interface Stage {
  id: StageId;
  label: string;
  /** What this phase feels like, for the Director. */
  what: string;
  /** What would move it on. The Director is told to steer towards this. */
  next: string;
}

const STAGES: Record<StageId, Stage> = {
  opening: {
    id: 'opening',
    label: 'Opening',
    what: 'They have barely spoken. She is deciding whether this is worth her attention at all, and she has other matches. Nothing is owed yet, by either of them.',
    next: 'One real exchange instead of pleasantries. She finds out whether he is capable of being interesting, and lets him find out one thing about her.',
  },
  curious: {
    id: 'curious',
    label: 'Curious',
    what: 'She is interested enough to keep replying without being asked twice. This is the getting-to-know-you phase and she is an active participant in it - she wants to know about him too, not just answer questions.',
    next: 'Something personal from each of them. A real opinion, a story that costs something to tell, a question nobody else asks.',
  },
  warming: {
    id: 'warming',
    label: 'Warming up',
    what: 'There is something here and they both know it. She is comfortable, teases him, brings things up unprompted, and has started to look forward to his messages.',
    next: 'The first open acknowledgement of attraction. Flirting that is not deniable. She may make the first move on that.',
  },
  flirting: {
    id: 'flirting',
    label: 'Flirting',
    what: 'Mutual, explicit interest. The conversation has charge to it. She is enjoying this and is not pretending otherwise.',
    next: 'Either the conversation gets more intimate, or it gets real - meeting up. She has an appetite for one of those and it comes from who she is.',
  },
  intimate: {
    id: 'intimate',
    label: 'Intimate',
    what: 'That side of the conversation is open. She is candid about wanting him and about what she likes, within her own limits.',
    next: 'Meeting in person, if she wants that. Talk is not the destination for her.',
  },
  meeting: {
    id: 'meeting',
    label: 'Wants to meet',
    what: 'She is ready to see him in person and is no longer being coy about it.',
    next: 'An actual plan: a day, a time, a place. She will push for specifics rather than "sometime".',
  },
};

export function currentStage(character: Character, rel: Relationship): Stage {
  const f = rel.flags.state;
  const bond = (rel.trust + rel.spark + rel.investment) / 3;

  if (f.allows_date_requests && rel.trust >= character.seed.thresholds.allow_date) return STAGES.meeting;
  if (f.sexual_topics_allowed) return STAGES.intimate;
  if (rel.spark >= 55 && rel.trust >= 35) return STAGES.flirting;
  if (bond >= 35 || f.real_name_known) return STAGES.warming;
  if (bond >= 22) return STAGES.curious;
  return STAGES.opening;
}

/**
 * Session-level arousal. Separate from spark: spark is whether she fancies him, this is
 * whether she is in the mood right now. It moves fast and decays fast, and it is capped by
 * who she is - a low-libido character never runs hot just because the chat went well.
 */
export function arousalCeiling(character: Character, rel: Relationship): number {
  const { libido, sexting_readiness } = character.seed;
  const appetite = (libido + sexting_readiness) / 2; // 1..5
  const base = 20 + appetite * 16; // 36..100
  // Wanting him at all is a precondition for wanting him right now.
  const sparkCap = 25 + rel.spark * 0.85;
  return Math.round(Math.max(0, Math.min(100, Math.min(base, sparkCap))));
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
