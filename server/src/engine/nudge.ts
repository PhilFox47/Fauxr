import { find } from '../db/attributes.js';
import type { Character, OpenThread, Relationship } from '../types.js';
import { freshThreads } from './state.js';
import { fantasyList } from './blocks.js';

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
  /** Set by pitch_fantasy: the exact fantasy she was told to pitch. */
  fantasy?: string;
  /** Set by start_game: the chat_game she was told to start, logged once she has. */
  game?: string;
}

/** At most one game every this long, whoever starts it. */
const GAME_COOLDOWN_MS = 20 * 3_600_000;
/** A game she has already played does not come back sooner than this, even once all are used. */
const GAME_REPEAT_MS = 5 * 24 * 3_600_000;

/**
 * A game she could start right now, or null. The two failure modes this guards against are a
 * character suggesting games every few messages and the same game coming back again and
 * again, so both are enforced here rather than left to the prompt: one game per cooldown,
 * never one she has played while her list still has others, and never within five days.
 * Hot games wait until she is worked up; photo games until you have swapped pictures.
 */
export function gameNudge(character: Character, rel: Relationship): Nudge | null {
  const log = ((rel.mood as any)?.games ?? {}) as { last_at?: string; played?: Record<string, string> };
  if (log.last_at && Date.now() - Date.parse(log.last_at) < GAME_COOLDOWN_MS) return null;
  const played = log.played ?? {};
  const swapped = !!(rel.flags?.state?.photos_exchanged || rel.flags?.state?.profile_picture_sent);
  const eligible = (character.seed.chat_games ?? [])
    .map((id) => find('chat_game', id))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .filter((g) => g.extra?.heat !== 'hot' || rel.arousal >= 40)
    .filter((g) => swapped || !((g.extra?.domains as string[] | undefined) ?? []).includes('recording'));
  const unplayed = eligible.filter((g) => !played[g.id]);
  const pool = unplayed.length
    ? unplayed
    : eligible.filter((g) => Date.now() - Date.parse(played[g.id]) > GAME_REPEAT_MS)
        .sort((a, b) => Date.parse(played[a.id]) - Date.parse(played[b.id]))
        .slice(0, 1);
  if (!pool.length) return null;
  const g = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: 'start_game',
    game: g.id,
    text:
      `Start a game with him this turn: ${g.label} - ${g.prompt_hint}. Set it up in your own words, ` +
      'with whatever rules you want, and make the first move yourself. It is your idea, so sell it.',
  };
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
  // Read off the attribute rows rather than switching on ids, so a new social_energy or
  // sexual_persona entry pulls its own weight: an insatiable or digital-tease persona starts
  // things far more often than a slow-burner does.
  const energy = Number(find('social_energy', seed.social_energy)?.extra?.initiative ?? 0);
  const personaBonus = Number(find('sexual_persona', seed.sexual_persona)?.extra?.initiative ?? 0);

  // How likely she is to bring her own material rather than only answering.
  const initiative = 0.4 + energy + personaBonus;

  // Only threads she has not just been on about, so a callback cannot become a fixation.
  const openThreads: OpenThread[] = freshThreads(rel.ledger?.open_threads ?? []);

  /**
   * She makes moves too. Nothing gates this on how far things have got: a forward character
   * comes onto him in the first message, a slow-burn one teases, and arousal lowers the bar
   * for everyone.
   */
  const boldness = (seed.sexual_confidence - 2) * 0.06 + personaBonus / 2;
  // Her own specifics, so the push to flirt or escalate comes out in her voice, not a stock one.
  const dirtyTalk = find('dirty_talk', seed.dirty_talk)?.label.toLowerCase() ?? '';
  const signature = find('signature_move', seed.signature_move)?.label.toLowerCase() ?? '';
  const personaLabel = find('sexual_persona', seed.sexual_persona)?.label.toLowerCase() ?? '';
  const pride = find('body_pride', seed.body_pride)?.label.toLowerCase() ?? '';
  const forward = seed.sexual_confidence >= 4 || seed.libido >= 4;

  if ((rel.arousal >= 55 || (forward && rel.arousal >= 25)) && chance(0.45 + boldness)) {
    return {
      id: 'escalate',
      text:
        'You are the one pushing this turn. Do not wait for him to take it somewhere - take it there ' +
        'yourself: say the specific thing you have been thinking about, or tell him exactly what you want' +
        (dirtyTalk ? `, the way you talk dirty (${dirtyTalk})` : '') +
        (signature ? `. Your signature is ${signature} - this could be the moment for it` : '') + '.',
    };
  }

  // Her own fantasies are the heart of this. She pitches one, or picks one back up.
  const fantasies = fantasyList(seed);
  if (fantasies.length && (!ctx.somethingLive || rel.arousal >= 45) && chance(0.14 + boldness / 2 + (forward ? 0.05 : 0))) {
    const pick = fantasies[Math.floor(Math.random() * fantasies.length)];
    return {
      id: 'pitch_fantasy',
      fantasy: pick,
      text:
        `Pitch him one of your fantasies this turn: ${pick}. Make it concrete and yours - set the ` +
        'scene in a line or two, tell him what you would want him to do, and ask if he is in. Tweak ' +
        'it to what you know about him. If you already pitched this one, move it forward instead.',
    };
  }

  // Now and then, a game of hers - gameNudge() holds the cooldown and the no-repeat rules.
  if (!ctx.somethingLive && chance(0.12)) {
    const game = gameNudge(character, rel);
    if (game) return game;
  }

  if (chance(0.3 + boldness + (forward ? 0.1 : 0))) {
    return {
      id: 'flirt',
      text:
        'Flirt with him this turn, and mean it - as yourself' +
        (personaLabel ? ` (in bed you are: ${personaLabel})` : '') +
        '. Not a polite compliment: something with an edge that only you would say' +
        (pride ? `, maybe drawing his attention to ${pride}` : '') + '.',
    };
  }

  // She lets out something she is into that he has not found yet.
  const hiddenFetishes = (seed.fetishes ?? []).filter((f) => !(rel.discovered ?? {})[`fetish:${f}`]);
  if (hiddenFetishes.length && (rel.arousal >= 35 || forward) && chance(0.3)) {
    return {
      id: 'hint_fetish',
      text:
        'Let him in on something you are into that he has not found out yet. Hint, suggest, or just ' +
        'say it - whichever is more you - and see what he does with it.',
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

  // Her, not him: a story, an opinion, a confession. This used to be a push to ask about him,
  // which across a dozen chats turned every character into the same interviewer.
  if (chance(0.1 + energy / 2)) {
    return {
      id: 'her_story',
      text:
        'Tell him something about you he does not know yet - a story, a strong opinion, something that ' +
        'happened this week, a confession, a thing only you would care about. Yours, specific, and told ' +
        'the way you tell things. No question at the end needed.',
    };
  }

  if (chance(initiative)) {
    return {
      id: 'volunteer',
      text:
        'Nothing much is hanging in the air, so bring something of your own into it rather than just ' +
        'answering - something from your actual day, a thought you were already having, a thing that ' +
        'annoyed you, a confession. You are not waiting for prompts.',
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

  const isTerse = (find('message_length', seed.message_length)?.extra?.bucket ?? 'medium') === 'short';
  if (!isTerse && chance(0.1)) {
    return {
      id: 'unprompted_detail',
      text:
        'Overshare slightly this turn. Give him more detail than the question deserved, the way people do when they ' +
        'are comfortable or when something is on their mind.',
    };
  }

  return null;
}

/**
 * "Your move": he pressed the button, so she texts first - and has to experience that as her
 * own impulse. Nothing in here may read as "he asked you to write": she has simply thought of
 * him, or of something she wants to say or show him, and is sending it. What she comes with
 * is drawn from her own material, weighted by what fits the moment.
 */
export function initiativeNudge(character: Character, rel: Relationship): Nudge {
  const seed = character.seed;
  const opener =
    'You are texting him first, right now, because you feel like it. He has not sent anything new ' +
    'and nothing he did set this off - he has been on your mind, or something just happened, or you ' +
    'want something. Do not answer an old message as if it were new, and never say or imply that he ' +
    'asked you to write. ';
  const options: { weight: number; build: () => Nudge }[] = [];

  const fantasies = fantasyList(seed);
  const pitched = new Set(Object.keys((rel.mood as any)?.fantasy_log ?? {}));
  const fresh = fantasies.filter((f) => !pitched.has(f));
  if (fantasies.length) {
    const pick = (fresh.length ? fresh : fantasies)[Math.floor(Math.random() * (fresh.length || fantasies.length))];
    options.push({
      weight: 2,
      build: () => ({
        id: 'initiative',
        fantasy: pick,
        text: opener + `Come to him with one of your fantasies - it has been on your mind: ${pick}. Set the scene and ask if he is in.`,
      }),
    });
  }
  const swapped = !!(rel.flags?.state?.photos_exchanged || rel.flags?.state?.profile_picture_sent);
  if (swapped) {
    options.push({
      weight: 1.5,
      build: () => ({
        id: 'initiative',
        text: opener + 'Send him a photo out of nowhere - what you are doing, what you have on, or something to tease him with - and a line with it.',
      }),
    });
  }
  const game = gameNudge(character, rel);
  if (game) {
    options.push({ weight: 1.2, build: () => ({ ...game, text: opener + game.text }) });
  }
  if (rel.arousal >= 40) {
    options.push({
      weight: 2,
      build: () => ({
        id: 'initiative',
        text: opener + 'You are still thinking about where things got to between you, and you want more. Pick it back up yourself, specifically.',
      }),
    });
  }
  options.push({
    weight: 1.5,
    build: () => ({
      id: 'initiative',
      text:
        opener +
        'Tell him something from right now - what you are doing (your status says it), a thought you just had about him, ' +
        'a confession, something that made you think of him. Something of yours, not a question to fill the silence.',
    }),
  });

  const total = options.reduce((a, o) => a + o.weight, 0);
  let r = Math.random() * total;
  for (const o of options) {
    r -= o.weight;
    if (r <= 0) return o.build();
  }
  return options[options.length - 1].build();
}
