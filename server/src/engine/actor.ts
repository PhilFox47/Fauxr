import { getSettings } from '../config.js';
import { complete, extractJson } from '../llm/client.js';
import { logger } from '../log.js';
import { getUserProfile, recentMessages } from '../repo.js';
import { render } from '../prompts/render.js';
import type { ActorHidden, ActorMessage, ActorOutput, Character, Direction, Relationship } from '../types.js';
import {
  appearanceBlock, communicationBlock, directionBlock, exchangeRequestBlock, historyBlock, identityBlock,
  interestsBlock, languageBlock, ledgerBlock, lifeBlock, moodBlock, quirksBlock,
  sexualBlock, spiceBlock, userBlock,
} from './blocks.js';
import { describeHim } from './discovery.js';
import { currentStage } from './stage.js';
import { describeHerMoment } from './moment.js';
import { pickNudge } from './nudge.js';
import { detectRoleplay, findVoiceProblem, isRelentlesslyWitty } from './voice.js';

export { detectRoleplay };

/** The retry names the exact tic, which works far better than asking for "something better". */
function retryHint(problem: string, fix: string): string {
  return `Your last answer will not do: ${problem}.

${fix}

Write it again from scratch - do not patch the old version, it is the wrong shape. Same JSON structure, nothing else.`;
}

/**
 * Used only once both attempts have genuinely failed. A pool rather than one fixed line,
 * so a provider outage spanning a couple of turns does not repeat the exact same sentence
 * back to back - which reads far more obviously broken than any one of these does alone,
 * especially if the user resends thinking their message did not go through.
 */
const FALLBACK_LINES = [
  'sorry got distracted, what were u saying',
  'hang on, phone did something weird',
  'wait sorry, one sec',
  'ugh my signal is awful rn',
];

function fallbackOutput(): ActorOutput {
  return {
    messages: [{
      text: FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)],
      delay: 0,
      // Flagged through to the client so it can mark the bubble as a failed generation
      // rather than a real line she typed - the flavor text alone reads as an in-character
      // beat, and he cannot tell the difference without this.
      failed: true,
    }],
    hidden: {
      thoughts: 'fallback message, the model failed',
      unresolved: null,
      mood: 'neutral',
      goal_fulfilled: false,
      boundary_touched: false,
      new_fact: null,
      open_thread: null,
      going_offline_in: null,
      director_needed: true,
      photo_offer: null,
      photo_situation: null,
      exchange_response: null,
    },
  };
}

const PHOTO_OFFER_KINDS = new Set(['profile', 'chat', 'spicy']);

function normalizeHidden(raw: any): ActorHidden {
  return {
    thoughts: String(raw?.thoughts ?? ''),
    unresolved: raw?.unresolved ? String(raw.unresolved) : null,
    mood: String(raw?.mood ?? ''),
    goal_fulfilled: !!raw?.goal_fulfilled,
    boundary_touched: !!raw?.boundary_touched,
    new_fact: raw?.new_fact ? String(raw.new_fact) : null,
    open_thread: raw?.open_thread ? String(raw.open_thread) : null,
    going_offline_in:
      typeof raw?.going_offline_in === 'number' && raw.going_offline_in > 0
        ? Math.min(600, Math.round(raw.going_offline_in))
        : null,
    director_needed: !!raw?.director_needed,
    photo_offer: PHOTO_OFFER_KINDS.has(raw?.photo_offer) ? raw.photo_offer : null,
    photo_situation: raw?.photo_situation ? String(raw.photo_situation).slice(0, 300) : null,
    exchange_response:
      raw?.exchange_response === 'accept' || raw?.exchange_response === 'decline'
        ? raw.exchange_response
        : null,
  };
}

/**
 * How long she appears to spend typing one message, from its length alone.
 * Roughly fourteen characters a second plus a moment to start, which reads as a fast
 * thumb-typist without ever becoming a wait.
 */
export function typingDelay(text: string, maxSeconds: number): number {
  const seconds = 0.6 + text.length / 14;
  return Math.max(1, Math.min(maxSeconds, Math.round(seconds)));
}

/**
 * Delays and message counts are software limits, never left to the model.
 *
 * The first message of a turn is sent immediately: the wait for it is already real,
 * because the model had to generate it. Adding an invented delay on top only makes her
 * look slow. Every message after it is paced by its own length, since those arrive
 * together and would otherwise land in the same instant.
 */
function normalizeMessages(raw: any): ActorMessage[] {
  const { max_messages_per_turn, max_delay_seconds } = getSettings().chat;
  const list = Array.isArray(raw) ? raw : [];
  const out: ActorMessage[] = [];
  for (const m of list.slice(0, max_messages_per_turn)) {
    const text = String(m?.text ?? '').trim();
    if (!text) continue;
    out.push({
      text,
      delay: out.length === 0 ? 0 : typingDelay(text, max_delay_seconds),
      kind: 'text',
    });
  }
  return out;
}

export interface ActorContext {
  character: Character;
  relationship: Relationship;
  direction: Direction | null;
}

/** Set by runActor so the caller can burn down a thread she was told to raise. */
export interface ActorRun extends ActorOutput {
  raisedThreadId?: string;
}

function buildPrompt(
  ctx: ActorContext,
  template: 'actor_chat' | 'actor_voice',
  nudge: string,
  somethingLive = false,
): string {
  const { character, relationship, direction } = ctx;
  const settings = getSettings();
  const user = getUserProfile();
  const seed = character.seed;
  const wanted = new Set(direction?.context_blocks ?? []);
  const flags = relationship.flags;
  const photoPending = !!(relationship.mood as any)?.pending_photo;

  const messages = recentMessages(character.id, settings.chat.context_messages);

  return render(template, {
    char_display_name: flags.state.real_name_known ? character.real_name : `@${character.username}`,
    user_name: user?.display_name ?? 'him',
    user_block: [
      userBlock(user, flags),
      describeHim(relationship),
      exchangeRequestBlock(
        !!(relationship.mood as any)?.pending_exchange,
        !!flags.state.photos_exchanged,
      ),
    ].filter(Boolean).join('\n\n'),
    identity_block: identityBlock(character, flags),
    communication_block: communicationBlock(seed),
    quirks_block: quirksBlock(seed),
    appearance_block: wanted.has('appearance') || flags.state.profile_picture_sent ? appearanceBlock(seed, flags) : '',
    life_block: wanted.has('life') ? lifeBlock(seed) : '',
    interests_block: wanted.has('interests') ? interestsBlock(seed) : '',
    // The sexual block used to need the director to request it, which meant she could be
    // fully unlocked and still have no idea what she likes. If that door is open, she knows.
    sexual_block: flags.state.sexual_topics_allowed || relationship.arousal >= 45 ? sexualBlock(seed) : '',
    spice_block: spiceBlock(seed, relationship.arousal, flags),
    language_block: seed.languages.length > 1 ? languageBlock(seed) : '',
    ledger_block: ledgerBlock(relationship.ledger),
    direction_block: directionBlock(direction, somethingLive, photoPending),
    mood_block: moodBlock(relationship.arousal, currentStage(relationship).label, seed.hints.arousal_tell),
    moment_block: describeHerMoment(character),
    turn_nudge: nudge,
    history_block: historyBlock(messages, character, user),
    max_messages: settings.chat.max_messages_per_turn,
    voice_target:
      seed.message_length === 'paragraphs' ? '40 to 90 seconds of speech' : '12 to 40 seconds of speech',
    text_target: textTarget(seed.message_length),
  });
}

/**
 * A concrete target, the same job voice_target does for voice notes. Without one, "obey
 * your message length setting" only ever names the one_liner floor, and a model with no
 * other anchor defaults to the shortest thing that technically satisfies every rule -
 * which reads as terse even for characters whose setting allows much more.
 */
function textTarget(messageLength: string): string {
  switch (messageLength) {
    case 'one_liner':
      return 'One short line, rarely more than a handful of words. That is the whole reply, not a first message with more to follow.';
    case 'paragraphs':
      return 'Real substance when there is something to say - two to four sentences, often split across two or three messages rather than one block. Still allowed to send just "same" when that is genuinely the whole reply.';
    default:
      return 'A sentence or two of actual content, not just a reaction word. Split it across a second message rather than cramming everything into one.';
  }
}

/** A character who really does write in full sentences, so the register check exempts her. */
function writesFormally(character: { seed: { typing_style: string; slang_register: string } }): boolean {
  return character.seed.typing_style === 'proper' || character.seed.slang_register === 'formal';
}

export async function runActor(ctx: ActorContext): Promise<ActorRun> {
  const settings = getSettings();
  const recent = recentMessages(ctx.character.id, 12);
  const lastUserMessage = [...recent].reverse().find((m) => m.sender === 'user')?.text ?? '';
  const recentOwnMessages = recent.filter((m) => m.sender === 'character').map((m) => m.text);

  /**
   * Two signals that the floor is not clear. The Actor's own report from last turn is the
   * better one - it knows whether a bit is running - and an unanswered question from him
   * is the obvious code-side case.
   */
  const somethingLive =
    !!(ctx.relationship.mood as any)?.unresolved ||
    (recent[recent.length - 1]?.sender === 'user' && lastUserMessage.includes('?'));

  const nudge = pickNudge(ctx.character, ctx.relationship, { somethingLive });
  const prompt = buildPrompt(ctx, 'actor_chat', nudge?.text ?? '', somethingLive);
  const base = [{ role: 'user' as const, content: prompt }];

  let correction: string | null = null;

  // Two attempts: the first is the ask, the second names whatever went wrong with it.
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await complete({
        scope: 'actor',
        label: `chat:${ctx.character.username}${attempt ? ':retry' : ''}`,
        config: settings.models.actor,
        json: true,
        messages: correction ? [...base, { role: 'user', content: correction }] : base,
      });
    } catch (err) {
      logger.error('actor', `actor call failed for ${ctx.character.username}`, { error: String(err) });
      // A thrown error here is a transport or provider problem (rate limit, timeout, a
      // non-2xx response), not a content problem - the one thing the retry budget should
      // absolutely not be skipped for. Retrying with the exact same request costs nothing
      // and silently swallowing a single flaky call is worth a lot: this used to send the
      // canned fallback on the very first hiccup, using neither of the two attempts.
      if (attempt === 0) continue;
      return fallbackOutput();
    }

    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      logger.warn('actor', 'actor returned unparseable JSON', { raw: text.slice(0, 500) });
      correction = retryHint(
        'it was not valid JSON',
        'Reply with a single JSON object and nothing else. No prose, no code fences.',
      );
      continue;
    }

    const out: ActorOutput = {
      messages: normalizeMessages(parsed?.messages),
      hidden: normalizeHidden(parsed?.hidden),
    };
    if (out.messages.length === 0) {
      logger.warn('actor', 'actor produced no usable messages');
      correction = retryHint('it contained no usable message', 'Send at least one actual message.');
      continue;
    }

    const problem = out.messages
      .map((m, i) =>
        findVoiceProblem({
          text: m.text,
          isFirst: i === 0,
          lastUserMessage,
          writesFormally: writesFormally(ctx.character),
          recentOwnMessages,
        }),
      )
      .find(Boolean);

    if (problem) {
      logger.warn('actor', `rejected: ${problem.what}`, {
        character: ctx.character.username,
        attempt,
        messages: out.messages.map((m) => m.text),
      });
      correction = retryHint(problem.what, problem.fix);
      continue;
    }

    if (attempt === 0 && isRelentlesslyWitty(out.messages.map((m) => m.text))) {
      logger.warn('actor', 'rejected: every message is a one-line quip', {
        character: ctx.character.username,
        messages: out.messages.map((m) => m.text),
      });
      correction = retryHint(
        'every message was the same polished one-liner',
        'Three quips in a row is a performance, not a conversation. Keep at most one good line. ' +
          'Let the others be ordinary, or say something real, or ask something you actually want to know.',
      );
      continue;
    }

    if (nudge) logger.debug('actor', `nudge applied: ${nudge.id}`, { character: ctx.character.username });
    return { ...out, raisedThreadId: nudge?.threadId };
  }

  logger.error('actor', `actor failed twice for ${ctx.character.username}, using fallback`);
  return fallbackOutput();
}

export interface VoiceOutput {
  message: ActorMessage;
  hidden: ActorHidden;
}

export async function runActorVoice(ctx: ActorContext): Promise<VoiceOutput | null> {
  const settings = getSettings();
  if (!settings.voice_enabled) return null;
  const prompt = buildPrompt(ctx, 'actor_voice', '');
  try {
    const text = await complete({
      scope: 'actor',
      label: `voice:${ctx.character.username}`,
      config: settings.models.actor,
      json: true,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed: any = extractJson(text);
    const body = String(parsed?.message?.text ?? '').trim();
    if (!body) return null;
    // Voice messages may be prose, but still never narration.
    if (detectRoleplay(body)) {
      logger.warn('actor', 'voice message contained narration, dropped');
      return null;
    }
    const words = body.split(/\s+/).length;
    const duration = Math.max(
      4,
      Math.min(120, Math.round(Number(parsed?.message?.duration_seconds) || words / 2.5)),
    );
    return {
      message: {
        text: body,
        // A voice note is the whole turn, so it is the first message: no invented delay.
        delay: 0,
        kind: 'voice',
        duration_seconds: duration,
      },
      hidden: normalizeHidden(parsed?.hidden),
    };
  } catch (err) {
    logger.warn('actor', 'voice message generation failed', { error: String(err) });
    return null;
  }
}

/** Should she reach for a voice note this turn? */
export function wantsVoiceMessage(character: Character): boolean {
  if (!getSettings().voice_enabled) return false;
  switch (character.seed.voice_msg_tendency) {
    case 'often':
      return Math.random() < 0.25;
    case 'rare':
      return Math.random() < 0.07;
    default:
      return false;
  }
}
