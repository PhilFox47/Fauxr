import { getSettings } from '../config.js';
import { complete, extractJson } from '../llm/client.js';
import { logger } from '../log.js';
import { getUserProfile, recentMessages } from '../repo.js';
import { render } from '../prompts/render.js';
import type { ActorHidden, ActorMessage, ActorOutput, Character, Direction, Relationship } from '../types.js';
import {
  appearanceBlock, communicationBlock, directionBlock, historyBlock, identityBlock,
  interestsBlock, languageBlock, ledgerBlock, lifeBlock, moodBlock, quirksBlock,
  sexualBlock, spiceBlock, userBlock,
} from './blocks.js';
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

const FALLBACK: ActorOutput = {
  messages: [{ text: 'sorry got distracted, what were u saying', delay: 0 }],
  hidden: {
    thoughts: 'fallback message, the model failed',
    mood: 'neutral',
    goal_fulfilled: false,
    boundary_touched: false,
    new_fact: null,
    open_thread: null,
    going_offline_in: null,
    director_needed: true,
  },
};

function normalizeHidden(raw: any): ActorHidden {
  return {
    thoughts: String(raw?.thoughts ?? ''),
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

function buildPrompt(
  ctx: ActorContext,
  template: 'actor_chat' | 'actor_voice',
  nudge: string,
): string {
  const { character, relationship, direction } = ctx;
  const settings = getSettings();
  const user = getUserProfile();
  const seed = character.seed;
  const wanted = new Set(direction?.context_blocks ?? []);
  const flags = relationship.flags;

  const messages = recentMessages(character.id, settings.chat.context_messages);

  return render(template, {
    char_display_name: flags.state.real_name_known ? character.real_name : `@${character.username}`,
    user_name: user?.display_name ?? 'him',
    user_block: userBlock(user),
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
    direction_block: directionBlock(direction),
    mood_block: moodBlock(relationship.arousal, currentStage(character, relationship).label),
    moment_block: describeHerMoment(character),
    turn_nudge: nudge,
    history_block: historyBlock(messages, character, user),
    max_messages: settings.chat.max_messages_per_turn,
    voice_target:
      seed.message_length === 'paragraphs' ? '40 to 90 seconds of speech' : '12 to 40 seconds of speech',
  });
}

/** A character who really does write in full sentences, so the register check exempts her. */
function writesFormally(character: { seed: { typing_style: string; slang_register: string } }): boolean {
  return character.seed.typing_style === 'proper' || character.seed.slang_register === 'formal';
}

export async function runActor(ctx: ActorContext): Promise<ActorOutput> {
  const settings = getSettings();
  const nudge = pickNudge(ctx.character, ctx.relationship);
  const prompt = buildPrompt(ctx, 'actor_chat', nudge?.text ?? '');
  const base = [{ role: 'user' as const, content: prompt }];
  const lastUserMessage =
    [...recentMessages(ctx.character.id, 12)].reverse().find((m) => m.sender === 'user')?.text ?? '';

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
      return FALLBACK;
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
    return out;
  }

  logger.error('actor', `actor failed twice for ${ctx.character.username}, using fallback`);
  return FALLBACK;
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
