/**
 * The Writer: her text-chat messages as plain text, for the "split" chat pipeline.
 *
 * The Actor (actor.ts) writes her messages and her hidden report in one JSON object, so it has
 * to be a model that writes clean JSON - and models in that mode write her flatter than a pure
 * roleplay model does. The Writer asks for nothing but her messages, a blank line between them,
 * and the Reconciler (reconciler.ts) reads what they changed once they exist. Any model that
 * writes her well can sit here.
 *
 * Roleplay models are tuned on chat transcripts, not on a transcript pasted into one prompt, so
 * the conversation goes in as real turns: her card and the current situation in the system
 * message, his messages as user turns, hers as assistant turns. Every check on her words is
 * the Actor's own (reviewMessages), so the same failures are caught either way.
 */
import { getSettings } from '../config.js';
import { complete, type ChatMessage } from '../llm/client.js';
import { logger } from '../log.js';
import { loadTemplate, render } from '../prompts/render.js';
import type { StoredMessage } from '../repo.js';
import type { ActorMessage, Character } from '../types.js';
import { fallbackOutput, normalizeMessages, promptVars, retryHint, reviewMessages, type ActorContext } from './actor.js';
import { duoPartner } from './duo.js';
import { initiativeNudge, openerNudge } from './nudge.js';

/** Bookkeeping cards that are not something either of them said - historyBlock skips the same. */
const SKIPPED_TYPES = new Set(['fantasy_pitch', 'photos_swapped']);
/** A gap this long between two messages is worth telling her about, as an app note. */
const GAP_NOTE_MS = 90 * 60_000;

function clockOf(m: StoredMessage): number {
  return m.game_clock_ms ?? Date.parse(m.sent_at);
}

function gapLabel(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'} later`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} later`;
}

/**
 * The conversation as alternating chat turns. Anything that is neither his words nor hers - a
 * photo arriving, time passing, a date marker - becomes a bracketed note inside a user turn, so
 * her own turns only ever contain text she typed and never teach her to write a tag.
 */
export function chatTurns(history: StoredMessage[], character: Character): ChatMessage[] {
  const turns: { role: 'user' | 'assistant'; parts: string[] }[] = [];
  const push = (role: 'user' | 'assistant', text: string) => {
    const last = turns.at(-1);
    if (last?.role === role) last.parts.push(text);
    else turns.push({ role, parts: [text] });
  };
  let previous: number | null = null;
  for (const m of history) {
    if (m.meta?.failed || SKIPPED_TYPES.has(m.meta?.type)) continue;
    const at = clockOf(m);
    if (previous !== null && at - previous >= GAP_NOTE_MS) push('user', `[${gapLabel(at - previous)}]`);
    previous = at;
    const described = m.meta?.description ? `: ${m.meta.description}` : '';
    if (m.sender === 'user') {
      push('user', m.kind === 'image' ? `[he sent a photo${described}]${m.text ? ` ${m.text}` : ''}` : m.text);
    } else if (m.sender === 'character') {
      if (m.kind === 'image') push('user', `[your photo arrived${described}]`);
      else if (m.text.trim()) push('assistant', m.meta?.from ? `${m.meta.from}: ${m.text}` : m.text);
    } else if (m.text.trim()) {
      push('user', `[${m.text.trim()}]`);
    }
  }
  // Chat templates expect the conversation to open with a user turn and the model to answer one.
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', parts: [`[You matched with him.]`] });
  if (!turns.length) turns.push({ role: 'user', parts: [`[You matched with him. You text first.]`] });
  else if (turns.at(-1)!.role === 'assistant') turns.push({ role: 'user', parts: [`[Nothing new from him. ${character.real_name} texts next.]`] });
  return turns.map((t) => ({ role: t.role, content: t.parts.join(t.role === 'assistant' ? '\n\n' : '\n') }));
}

const QUOTES: [string, string][] = [['"', '"'], ['“', '”'], ["'", "'"]];

/**
 * Her bubbles from whatever came back. The model is asked for messages separated by blank
 * lines; what roleplay models add on top of that is a name label ("Mia: hey"), quotes around
 * the whole message, a reasoning block, or a bracketed aside. Those are removed here; anything
 * that is actually wrong with her words (narration, system language) is reviewMessages' job.
 */
export function parseBubbles(raw: string, character: Character): { text: string; from?: string }[] {
  let text = raw.replace(/\r\n?/g, '\n');
  // A reasoning block: everything up to the last closing tag is thinking, not her.
  const thinkEnd = text.lastIndexOf('</think>');
  if (thinkEnd !== -1) text = text.slice(thinkEnd + '</think>'.length);
  text = text.replace(/<think>[\s\S]*$/i, '');
  const fence = text.match(/```[a-z]*\n([\s\S]*?)```/i);
  if (fence) text = fence[1];
  text = text.trim();

  let chunks = text.split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  // One message per line, without the blank lines: short lines are separate texts. A long
  // multi-line block stays one message - that is more likely a list she typed on purpose.
  if (chunks.length === 1 && chunks[0].includes('\n')) {
    const lines = chunks[0].split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((l) => l.length <= 200)) chunks = lines;
  }

  const partner = duoPartner(character.seed)?.name ?? null;
  const names = [character.real_name, character.username, character.real_name.split(/\s+/)[0]]
    .filter(Boolean).map((n) => n.toLowerCase());
  const out: { text: string; from?: string }[] = [];
  for (let chunk of chunks) {
    // An app-style note or out-of-character aside, not a message.
    if (/^\[[\s\S]*\]$/.test(chunk) || /^\(\s*(ooc|note)\b/i.test(chunk)) continue;
    let from: string | undefined;
    const label = chunk.match(/^\**@?([\p{L}\p{N}_ .'-]{1,40}?)\**\s*:\**\s+/u);
    if (label) {
      const who = label[1].trim().toLowerCase();
      if (partner && who === partner.toLowerCase()) { from = partner; chunk = chunk.slice(label[0].length); }
      else if (names.includes(who)) chunk = chunk.slice(label[0].length);
    }
    chunk = chunk.trim();
    for (const [open, close] of QUOTES) {
      if (chunk.length > 2 && chunk.startsWith(open) && chunk.endsWith(close) && !chunk.slice(1, -1).includes(close)) {
        chunk = chunk.slice(1, -1).trim();
      }
    }
    if (chunk) out.push({ text: chunk, ...(from ? { from } : {}) });
  }
  return out;
}

function partnerRule(character: Character): string {
  const partner = duoPartner(character.seed);
  return partner
    ? `On this shared profile ${partner.name} sometimes texts too. A message she writes starts with "${partner.name}: "; yours never carry a name.`
    : '';
}

export function buildWriterMessages(ctx: ActorContext, nudge: string, photoNote = ''): ChatMessage[] {
  const vars = promptVars(ctx, nudge, false, { plain: true, photoNote });
  const system = `${loadTemplate('system_actor').trim()}\n\n---\n\n${render('writer_chat', { ...vars, partner_rule: partnerRule(ctx.character) }).trim()}`;
  const window = ctx.history.slice(-getSettings().chat.context_messages);
  return [{ role: 'system', content: system }, ...chatTurns(window, ctx.character)];
}

/**
 * Her messages for this turn, or the canned fallback (marked failed) once the attempts are spent.
 * Same budget as the Actor: two attempts, a third only for a reply that broke frame.
 */
export async function runWriter(ctx: ActorContext, opts: { photoNote?: string } = {}): Promise<ActorMessage[]> {
  const settings = getSettings();
  const nudge = ctx.initiative ? initiativeNudge() : ctx.opener && !ctx.history.some((m) => m.sender === 'user')
    ? openerNudge(ctx.character.seed, ctx.openingPlan) : null;
  const base = buildWriterMessages(ctx, nudge?.text ?? '', opts.photoNote);
  const partner = duoPartner(ctx.character.seed)?.name ?? null;
  let correction: ChatMessage[] = [];
  let budget = 2;
  for (let attempt = 0; attempt < budget; attempt++) {
    let text: string;
    try {
      text = await complete({
        scope: 'actor',
        label: `write:${ctx.character.username}${attempt ? ':retry' : ''}`,
        config: settings.models.writer,
        messages: [...base, ...correction],
      });
    } catch (err) {
      logger.error('actor', `writer call failed for ${ctx.character.username}`, { error: String(err) });
      // Transport trouble, not content: the same request again costs nothing (see runActor).
      if (attempt === 0) continue;
      return fallbackOutput().messages;
    }
    const messages = normalizeMessages(parseBubbles(text, ctx.character), partner);
    const review = reviewMessages(ctx, messages, attempt);
    if (review.ok) return review.messages;
    if (review.extraAttempt) budget = Math.min(3, budget + 1);
    // The rejected draft stays in the transcript as hers, followed by the note: a chat model
    // revises its own last turn far more reliably than it follows a fresh restatement.
    correction = [
      { role: 'assistant', content: text.trim() || '(nothing)' },
      { role: 'user', content: `[Note from the app, not from him: ${retryHint(review.problem, review.fix, 'text')}]` },
    ];
  }
  logger.error('actor', `writer failed twice for ${ctx.character.username}, using fallback`);
  return fallbackOutput().messages;
}
