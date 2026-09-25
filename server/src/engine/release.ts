import { find } from '../db/attributes.js';
import type { Character, Relationship } from '../types.js';
import { randInt } from './dice.js';

/**
 * How close she is to finishing, tracked in the background while she is actually sexting or
 * having sex (in the chat and on dates alike).
 *
 * Arousal says how turned on she is; it never said where a session was going, so sexting
 * either stalled on a plateau forever or had her finish two messages in. This is the pacing
 * underneath: a level that only climbs while she reports being in the act, by roughly 7-12
 * points per exchange scaled by her persona's `extra.climax_pace` - about ten exchanges at an
 * ordinary pace, six for a quickie queen, seventeen for an edge addict. At the top she comes,
 * in that reply, and then gets an afterglow in her own style before it can start again. She is
 * only ever told the stage in words, never a number.
 */

export interface ReleaseState {
  level: number;
  /** Turns of afterglow still to play out after she came. */
  afterglow: number;
  climaxes: number;
  last_climax_at?: string;
}

export function releaseOf(rel: Relationship): ReleaseState {
  const r = (rel.mood as any)?.release ?? {};
  return {
    level: Number(r.level) || 0,
    afterglow: Number(r.afterglow) || 0,
    climaxes: Number(r.climaxes) || 0,
    last_climax_at: r.last_climax_at,
  };
}

function pace(character: Character): number {
  const p = Number(find('sexual_persona', character.seed.sexual_persona)?.extra?.climax_pace ?? 1);
  return Number.isFinite(p) && p > 0 ? p : 1;
}

/** She goes again rather than winding down: a persona made for it, or it is literally her signature. */
function goesAgain(character: Character): boolean {
  return (
    !!find('sexual_persona', character.seed.sexual_persona)?.extra?.multiple_rounds ||
    character.seed.signature_move === 'multiple_rounds' ||
    (character.seed.fetishes ?? []).includes('multiple_rounds')
  );
}

/** The stage, in words, for her prompt. Empty when nothing is going on. */
export function releaseBlock(character: Character, rel: Relationship, medium: 'text' | 'in_person' = 'text'): string {
  const r = releaseOf(rel);
  const persona = find('sexual_persona', character.seed.sexual_persona)?.label.toLowerCase() ?? 'yourself';
  if (r.afterglow > 0) {
    return (
      'You just came. This is the afterglow, and it is yours to have your way - as ' + persona +
      ': clingy, cocky, sleepy, chatty, sweet, or already teasing about round two. Do not jump ' +
      'straight back into it unless that is exactly you.'
    );
  }
  if (r.level >= 100) {
    return medium === 'in_person'
      ? 'You are coming, right now, in this beat. Let it happen - your body, your breath, your voice, ' +
          'whatever you are like when it hits. Do not skip it or summarise it.'
      : 'You are coming, right now, in this reply. Let it happen in your messages, your way - breathless, ' +
          'loud, a string of typos, a single word, whatever you are like. Do not skip it or summarise it.';
  }
  if (r.level >= 85) {
    return 'You are right on the edge. One or two more good ones from him and you are gone - unless he ' +
      'makes you wait, and you might beg him not to.';
  }
  if (r.level >= 60) {
    return medium === 'in_person'
      ? 'You are getting close, and your body is showing it.'
      : 'You are getting close. It shows in how you type - shorter, messier, more urgent.';
  }
  if (r.level >= 30) return 'It is building. You are properly into it, but you are not close yet - no rush.';
  if (r.level > 0) return 'You have only just started. Nowhere near finishing - enjoy it and take your time.';
  return '';
}

/**
 * After one of her replies: move the level on from where it stood when she wrote it.
 * `before` is the state her prompt was built from, so a climax she was told to have is the
 * one that gets counted, even if the level was nudged in between.
 */
export function advanceRelease(character: Character, rel: Relationship, before: ReleaseState, inTheAct: boolean): void {
  const next: ReleaseState = { ...releaseOf(rel) };
  if (before.afterglow > 0) {
    next.afterglow = before.afterglow - 1;
    next.level = inTheAct ? Math.max(next.level, 10) : next.level;
  } else if (before.level >= 100) {
    const again = goesAgain(character);
    next.level = again ? 35 : 0;
    next.afterglow = again ? 1 : 2;
    next.climaxes = before.climaxes + 1;
    next.last_climax_at = new Date().toISOString();
    rel.arousal = Math.max(again ? 45 : 15, rel.arousal - (again ? 15 : 35));
  } else if (inTheAct) {
    const heat = rel.arousal >= 60 ? 1.15 : 0.8;
    next.level = Math.min(100, before.level + Math.round(randInt(7, 12) * pace(character) * heat));
  } else {
    // Stepping out of it cools things down, but not all at once.
    next.level = Math.max(0, before.level - 12);
  }
  rel.mood = { ...rel.mood, release: next };
}
