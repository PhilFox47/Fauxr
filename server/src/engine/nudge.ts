import { find } from '../db/attributes.js';

/**
 * What she is told on a turn nothing of his set off.
 *
 * There used to be a per-turn nudge on every reply as well: a dice roll that told her to
 * flirt, pitch fantasy number three, start one of her chat games, tell a story from her day,
 * be half-present, not ask a question. It was built to break the answer-and-hand-back rhythm,
 * and it did - by replacing it with the software's rhythm. Every character ran the same
 * repertoire at the same odds, so a shy one and a brat both "started a game with him this
 * turn", and the games in particular came out as the thing every chat kept circling. Where a
 * conversation goes is now hers: her personality and what defines her (coreBlock), read by a
 * model that can see the whole conversation, decide what she brings and when.
 *
 * What is left is the one turn that needs framing to make sense at all: "Your move", where he
 * pressed a button and she has to experience texting first as her own impulse.
 */
export interface Nudge {
  id: string;
  text: string;
}

/**
 * "Your move": he pressed the button, so she texts first. Nothing in here may read as "he asked
 * you to write", and nothing picks what she says - that comes from who she is.
 */
export function initiativeNudge(): Nudge {
  return {
    id: 'initiative',
    text:
      'You are texting him first, right now, because you feel like it. He has not sent anything new ' +
      'and nothing he did set this off. Do not answer an old message as if it were new, and never say ' +
      'or imply that he asked you to write. What you send is whatever someone like you would actually ' +
      'send out of nowhere - it comes from what defines you and from ' +
      'where things stand between you, not from a list.',
  };
}

/**
 * Her very first message to him, right after matching - see CharacterSeed.conversation_starter
 * (rolled in generator.ts, last of the cascade so it can react to anything about her). This is
 * the one turn where the app decides the flavour of her opener rather than leaving it to
 * whatever the model reaches for by default, which is what made everyone's first message read
 * as the same "hey :)" regardless of who she was.
 */
export function openerNudge(seed: { conversation_starter: string }): Nudge {
  const starter = find('conversation_starter', seed.conversation_starter);
  const hint = starter?.prompt_hint || 'opens however feels most like her - no script for this one.';
  return {
    id: 'opener',
    text:
      'This is the very first message you have ever sent him - there is no history, and he has not ' +
      `written anything yet. You reach out entirely on your own. How you tend to break the ice: ${hint} ` +
      'Make it land like this is genuinely how you open, in your own words and your own voice, not a ' +
      'line recited from a script - one beat is enough, you do not owe him your whole personality in ' +
      'message one. Everything else about you (how you write, your pace, your hard limits) still ' +
      'governs it; this only decides where you start.',
  };
}
