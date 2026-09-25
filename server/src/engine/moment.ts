import { find } from '../db/attributes.js';
import type { Character } from '../types.js';
import { coreTraits, isCore } from './profilecard.js';
import { lifeLinesForHer } from './life.js';

/**
 * What is going on in her life at this exact moment, assembled in code from the clock and
 * her seed. No model call.
 *
 * This exists because of a specific failure: a character with nothing concrete to talk
 * about can only react to whatever the user said, which is what makes a chat read as a
 * chatbot. Giving her a real time of day, a job with a shape to it and things she actually
 * does means she has somewhere to go when she wants to change the subject.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function partOfDay(hour: number): string {
  if (hour < 5) return 'the middle of the night';
  if (hour < 9) return 'early morning';
  if (hour < 12) return 'late morning';
  if (hour < 14) return 'lunchtime';
  if (hour < 17) return 'the afternoon';
  if (hour < 20) return 'early evening';
  if (hour < 23) return 'late evening';
  return 'late at night';
}

function dayShape(now: Date): string {
  const day = now.getDay();
  const hour = now.getHours();
  if (day === 0) return 'It is a Sunday, so the week is about to start again.';
  if (day === 6) return 'It is Saturday.';
  if (day === 5 && hour >= 17) return 'It is Friday evening.';
  if (day === 1 && hour < 12) return 'It is Monday morning.';
  return 'It is the middle of the working week.';
}

export function describeHerMoment(character: Character, now = new Date()): string {
  const seed = character.seed;
  const hour = now.getHours();
  const hint = (cat: string, id: string) => find(cat, id)?.prompt_hint || find(cat, id)?.label || id;

  const lines = [
    `Right now it is ${DAYS[now.getDay()]}, ${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} - ${partOfDay(hour)}. ${dayShape(now)}`,
    // Her work used to be spelled out here on every single turn, "the actual shift" and all,
    // which is a large part of why every character kept talking about her job. It is named
    // in full only when it is one of the things that define her.
    isCore(seed, 'occupation')
      ? `Your work: ${hint('occupation', seed.occupation)}`
      : `Your work, in the background: ${find('occupation', seed.occupation)?.label ?? seed.occupation}`,
    `Where you are living: ${find('living_situation', seed.living_situation)?.label ?? seed.living_situation}`,
  ];
  if (hour >= 23 || hour < 5) {
    lines.push('It is very late. Either you cannot sleep, or you are out, or you are about to go to bed. Whichever it is, it is true and it shows.');
  }

  const life = lifeLinesForHer(character.id);
  if (life) lines.push(life);
  const core = coreTraits(seed, character.id).map((t) => t.label.toLowerCase()).join(', ');
  lines.push(
    'You have been doing something with your day, and it did not stop when he messaged you. ' +
      `If you mention it, be specific, and let it be something that sounds like you${core ? ` (${core})` : ''} ` +
      'rather than a work report. Never invent a job or a life that contradicts the above.',
  );
  return lines.join('\n');
}
