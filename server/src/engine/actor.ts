import { getSettings } from '../config.js';
import { complete, extractJson } from '../llm/client.js';
import { logger } from '../log.js';
import { getUserProfile, recentMessages } from '../repo.js';
import { render } from '../prompts/render.js';
import type { ActorHidden, ActorMessage, ActorOutput, Character, Direction, Relationship } from '../types.js';
import {
  appearanceBlock, communicationBlock, directionBlock, historyBlock, identityBlock,
  interestsBlock, languageBlock, ledgerBlock, lifeBlock, quirksBlock, sexualBlock, userBlock,
} from './blocks.js';

/** Narration and roleplay prose leaking into a chat app is the failure mode of this project. */
const RP_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\*[^*\n]{2,}\*/, what: 'asterisk action' },
  { re: /^_[^_\n]{2,}_$/m, what: 'underscore action' },
  { re: /~[^~\n]{2,}~/, what: 'tilde emote' },
  { re: /\[(?:she|he|they)\b[^\]]*\]/i, what: 'bracketed stage direction' },
  { re: /<[^>\n]{2,}>/, what: 'angle-bracket emote' },
  { re: /\b(?:she|her)\s+(?:smiles|smiled|laughs|laughed|giggles|giggled|sighs|sighed|blushes|blushed|grins|grinned|bites|leans|tilts|nods|shrugs|raises an eyebrow|rolls her eyes)\b/i, what: 'third-person narration' },
  { re: /\((?:smil|laugh|giggl|sigh|blush|grin|wink|shrug|nod)[a-z]*\)/i, what: 'parenthetical emote' },
];

export function detectRoleplay(text: string): string | null {
  for (const p of RP_PATTERNS) if (p.re.test(text)) return p.what;
  return null;
}

const STRICTER_HINT = `Your last answer broke the single hard rule: it contained narration or an action instead of a chat message.
No asterisks. No description of movement, face, gestures or surroundings. No third-person sentences about yourself.
You are typing on a phone. Only the words you would actually type into the message box.
Reply again with the same JSON structure and nothing else.`;

const FALLBACK: ActorOutput = {
  messages: [{ text: 'sorry got distracted, what were you saying', delay: 6 }],
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

/** Delays and message counts are software limits, never left to the model. */
function normalizeMessages(raw: any): ActorMessage[] {
  const { max_messages_per_turn, max_delay_seconds } = getSettings().chat;
  const list = Array.isArray(raw) ? raw : [];
  const out: ActorMessage[] = [];
  for (const m of list.slice(0, max_messages_per_turn)) {
    const text = String(m?.text ?? '').trim();
    if (!text) continue;
    const delay = Math.max(1, Math.min(max_delay_seconds, Math.round(Number(m?.delay) || 4)));
    out.push({ text, delay, kind: 'text' });
  }
  return out;
}

export interface ActorContext {
  character: Character;
  relationship: Relationship;
  direction: Direction | null;
}

function buildPrompt(ctx: ActorContext, template: 'actor_chat' | 'actor_voice'): string {
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
    sexual_block: flags.state.sexual_topics_allowed && wanted.has('sexual') ? sexualBlock(seed) : '',
    language_block: seed.languages.length > 1 ? languageBlock(seed) : '',
    ledger_block: ledgerBlock(relationship.ledger),
    direction_block: directionBlock(direction),
    history_block: historyBlock(messages, character, user),
    max_messages: settings.chat.max_messages_per_turn,
    max_delay: settings.chat.max_delay_seconds,
    voice_target:
      seed.message_length === 'paragraphs' ? '40 to 90 seconds of speech' : '12 to 40 seconds of speech',
  });
}

export async function runActor(ctx: ActorContext): Promise<ActorOutput> {
  const settings = getSettings();
  const prompt = buildPrompt(ctx, 'actor_chat');
  const messages = [{ role: 'user' as const, content: prompt }];

  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await complete({
        scope: 'actor',
        label: `chat:${ctx.character.username}${attempt ? ':retry' : ''}`,
        config: settings.models.actor,
        json: true,
        messages: attempt === 0 ? messages : [...messages, { role: 'user', content: STRICTER_HINT }],
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
      continue;
    }

    const out: ActorOutput = {
      messages: normalizeMessages(parsed?.messages),
      hidden: normalizeHidden(parsed?.hidden),
    };
    if (out.messages.length === 0) {
      logger.warn('actor', 'actor produced no usable messages');
      continue;
    }

    const violation = out.messages.map((m) => detectRoleplay(m.text)).find(Boolean);
    if (violation) {
      logger.warn('actor', `roleplay prose detected (${violation}), re-requesting`, {
        character: ctx.character.username,
        messages: out.messages.map((m) => m.text),
      });
      continue;
    }
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
  const prompt = buildPrompt(ctx, 'actor_voice');
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
        delay: Math.max(1, Math.min(settings.chat.max_delay_seconds, Math.round(Number(parsed?.message?.delay) || 5))),
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
