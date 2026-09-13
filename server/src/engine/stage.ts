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
    what: 'They have barely spoken. She is deciding whether he is worth the effort at all, and she has other matches doing the same thing. Nothing is owed yet, by either of them. She knows what he is here for because it is what she is here for.',
    next: 'One exchange with something in it - a bit of wit, a bit of nerve, a real answer. Enough that she stops treating him as interchangeable with the other twelve.',
  },
  curious: {
    id: 'curious',
    label: 'Curious',
    what: 'She is interested enough to keep replying without being chased. She wants to know whether he is any good - as company, and as the other thing. Both questions are live and she is not being subtle about the second one.',
    next: 'The first real flirting, from either of them. She is waiting to see whether he can do it without being crass or going shy.',
  },
  warming: {
    id: 'warming',
    label: 'Warming up',
    what: 'She fancies him and is no longer hiding it. The conversation has an undertow to it and everything is slightly double-edged.',
    next: 'Somebody says something they cannot take back. She is entirely capable of being the one who does.',
  },
  flirting: {
    id: 'flirting',
    label: 'Flirting',
    what: 'Explicit, mutual, and enjoyable. She is teasing him properly and getting as good as she gives.',
    next: 'It gets filthy, or it gets arranged. She has an appetite for one of those first, and which one comes from who she is.',
  },
  intimate: {
    id: 'intimate',
    label: 'Sexting',
    what: 'That side of it is wide open. She talks about what she wants in detail, asks what he wants, and is not shy about any of it - within her own limits, which do not move.',
    next: 'Doing it rather than describing it. Talk is not the destination for her and she will start saying so.',
  },
  meeting: {
    id: 'meeting',
    label: 'Wants to meet',
    what: 'She wants him in person and is done being coy about it. The conversation now has a purpose and she is impatient with anything that is not moving towards it.',
    next: 'An actual plan: a day, a time, a place, whose flat. She pushes for specifics rather than "sometime".',
  },
};

export function currentStage(character: Character, rel: Relationship): Stage {
  const f = rel.flags.state;
  const bond = (rel.trust + rel.spark + rel.investment) / 3;

  if (f.allows_date_requests && rel.trust >= character.seed.thresholds.allow_date) return STAGES.meeting;
  if (f.sexual_topics_allowed) return STAGES.intimate;
  // Attraction carries most of the weight on a hookup app; trust is a much smaller gate
  // here than it would be on a relationship site, because less is being asked of it.
  if (rel.spark >= 40 && rel.trust >= 20) return STAGES.flirting;
  if (bond >= 26 || f.real_name_known) return STAGES.warming;
  if (bond >= 18) return STAGES.curious;
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
  const base = 30 + appetite * 14; // 44..100
  // Wanting him at all still gates wanting him right now, but on a platform built for this
  // the floor is higher: she arrived in the mood, he only has to not put her off.
  const sparkCap = 40 + rel.spark * 0.75;
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
