import { find } from '../db/attributes.js';
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
    what: 'They have barely spoken. She swiped on him for a reason and is curious by default, not already unimpressed - this is a new match, not a chore. She can still lose interest fast if he turns out dull, and nothing is owed yet by either of them, but the starting posture is interest, not suspicion. She knows what he is here for because it is what she is here for.',
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

/**
 * How fast this particular woman moves through the arc, not just how she talks along the
 * way. A `daredevil` and a `shy` character used to hit "warming up" at literally the same
 * bond number - two very differently-written women progressing on an identical schedule,
 * which is exactly the sameness this exists to break. `extra.pace` on an archetype (only
 * set where it clearly should differ from the default) scales the thresholds below: above
 * 1 reaches each stage sooner, below 1 takes longer. Left undefined, an archetype changes
 * nothing here - most of them still shouldn't.
 */
function pacingFor(character: Character | undefined): number {
  if (!character) return 1;
  const p = find('archetype', character.seed.archetype)?.extra?.pace;
  return typeof p === 'number' && p > 0 ? p : 1;
}

export function currentStage(rel: Relationship, character?: Character): Stage {
  const f = rel.flags.state;
  const bond = (rel.trust + rel.spark + rel.investment) / 3;
  const pace = pacingFor(character);

  // The flag alone is the signal: the Director sets it when she has actually agreed she
  // wants to meet him. Requiring a trust number on top of her own stated position meant a
  // character could say yes and the phase would refuse to follow her. Deliberately not
  // pace-scaled: agreeing to meet is her own judgment call each turn, the same "no hidden
  // thresholds" rule the rest of the unlock system already follows, not a race she can run
  // faster or slower.
  if (f.allows_date_requests) return STAGES.meeting;
  if (f.sexual_topics_allowed) return STAGES.intimate;
  // Attraction carries most of the weight on a hookup app; trust is a much smaller gate
  // here than it would be on a relationship site, because less is being asked of it.
  if (rel.spark >= 40 / pace && rel.trust >= 20 / pace) return STAGES.flirting;
  if (bond >= 26 / pace || f.real_name_known) return STAGES.warming;
  if (bond >= 18 / pace) return STAGES.curious;
  return STAGES.opening;
}

/**
 * How hot she plausibly runs, as a sentence for the Director rather than a number that
 * clamps her.
 *
 * There used to be a hard ceiling here, and the half of it keyed on spark capped her at 40
 * early on - below the 45 the sexting guidance needs and nowhere near the 70 that reads as
 * openly wanting him. So a character could be handed exactly the thing she is into and the
 * formula would throw the reaction away, which is the opposite of what this app is for. Two
 * people hitting it off immediately is not unusual on a hookup app, and nothing should make
 * it impossible.
 *
 * Her seed still matters - a low-libido character running to 90 is out of character - but
 * that is a judgement the Director makes with the numbers in front of it, not a lid.
 */
export function describeAppetite(character: Character): string {
  const { libido, sexting_readiness, sexual_confidence } = character.seed;
  const appetite = (libido + sexting_readiness) / 2;
  if (appetite >= 4.2) {
    return `libido ${libido}/5, sexting readiness ${sexting_readiness}/5 - she runs hot easily and has no problem showing it. Do not be shy with this number when he earns it.`;
  }
  if (appetite >= 3) {
    return `libido ${libido}/5, sexting readiness ${sexting_readiness}/5 - she gets there readily enough when something actually lands.`;
  }
  if (appetite >= 2) {
    return `libido ${libido}/5, sexting readiness ${sexting_readiness}/5 - it takes something specific to her, but when it happens it is real.`;
  }
  return `libido ${libido}/5, sexting readiness ${sexting_readiness}/5 - she does not run hot often, and when she does it is quiet rather than loud. Sexual confidence ${sexual_confidence}/5.`;
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
