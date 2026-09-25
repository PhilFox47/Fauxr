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
