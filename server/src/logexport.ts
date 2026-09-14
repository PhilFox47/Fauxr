import { getSettings } from './config.js';
import { queryLogs } from './repo.js';

/**
 * Renders the log table as something a person can paste into a chat window and ask about.
 *
 * The Logs pane is fine for a glance, but troubleshooting a bad turn means reading the whole
 * prompt that produced it, and a prompt is an array of role/content objects. Pasted as raw
 * JSON that arrives as escape soup - \n between every line, the system block one unbroken
 * string - which is exactly the part you need to read. So each message is unpacked under its
 * own heading and the content printed as written.
 *
 * Two deliberate differences from the pane:
 *
 * - The export runs OLDEST FIRST. The pane is a feed, scanned newest-down; an export is read
 *   as a narrative, and a conversation makes no sense backwards.
 * - Nothing is truncated by default. The pane elides for space; an export exists so that the
 *   full text survives the trip.
 */

/** How much of each prompt to carry. `none` is for when only the replies are in question. */
export type PromptDetail = 'full' | 'trim' | 'none';

/** Long enough to keep a system block's opening intent, short enough to stay pasteable. */
const TRIM_CHARS = 800;

export interface ExportOptions {
  /** One specific entry, when the whole feed is not the question. */
  id?: number;
  scope?: string;
  level?: string;
  q?: string;
  limit?: number;
  prompts?: PromptDetail;
}

interface PromptMessage {
  role?: string;
  content?: unknown;
}

/** Keys the LLM logger writes, rendered as sections rather than dumped as JSON. */
const KNOWN = new Set(['model', 'duration_ms', 'tokens_in', 'tokens_out', 'prompt', 'response']);

function trim(text: string, detail: PromptDetail): string {
  if (detail !== 'trim' || text.length <= TRIM_CHARS) return text;
  return `${text.slice(0, TRIM_CHARS)}\n[... ${text.length - TRIM_CHARS} more characters, trimmed by the export]`;
}

function renderPrompt(prompt: unknown, detail: PromptDetail): string[] {
  if (detail === 'none' || prompt == null) return [];
  const out: string[] = [];
  // Normally the messages array the client was handed, but an older or hand-written entry may
  // have logged a bare string, and losing it would defeat the point of the export.
  const messages: PromptMessage[] = Array.isArray(prompt)
    ? (prompt as PromptMessage[])
    : [{ role: 'prompt', content: prompt }];
  for (const m of messages) {
    const body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content, null, 2);
    out.push(`### prompt · ${m?.role ?? 'unknown'}`, '', trim(body ?? '', detail), '');
  }
  return out;
}

function renderEntry(entry: any, detail: PromptDetail): string {
  const p = entry.payload ?? {};
  const out: string[] = [];

  out.push(`## ${entry.ts} · ${entry.scope} · ${entry.level} · ${entry.message}`);

  // The call's vitals on one line. This is what makes an export worth reading for tuning
  // rather than only for debugging: which model, how slow, how many tokens it cost.
  const vitals = [
    p.model && `model ${p.model}`,
    typeof p.duration_ms === 'number' && `${(p.duration_ms / 1000).toFixed(1)}s`,
    (p.tokens_in != null || p.tokens_out != null) && `${p.tokens_in ?? '?'} in / ${p.tokens_out ?? '?'} out`,
  ].filter(Boolean);
  if (vitals.length) out.push('', vitals.join(' · '));

  out.push('');
  out.push(...renderPrompt(p.prompt, detail));

  if (p.response != null) {
    const body = typeof p.response === 'string' ? p.response : JSON.stringify(p.response, null, 2);
    out.push('### response', '', body, '');
  }

  // Everything the logger put in that is not part of an LLM call - offer ids, character
  // handles, the reason a turn was skipped. Small, and usually the whole answer.
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !KNOWN.has(k)));
  if (Object.keys(rest).length) out.push('```json', JSON.stringify(rest, null, 2), '```', '');

  return out.join('\n');
}

function header(opts: ExportOptions, count: number): string {
  const s = getSettings();
  const filters = [
    `scope ${opts.scope || 'all'}`,
    `level ${opts.level || 'all'}`,
    opts.q ? `search "${opts.q}"` : 'no search',
  ].join(' · ');

  return [
    '# Fauxr log export',
    '',
    `- Exported: ${new Date().toISOString()}`,
    `- Entries: ${count}, oldest first`,
    `- Filters: ${filters}`,
    `- Prompt detail: ${opts.prompts ?? 'full'}`,
    `- Director: ${s.models.director.model} · temp ${s.models.director.temperature} · top_p ${s.models.director.top_p} · max ${s.models.director.max_tokens}`,
    `- Actor: ${s.models.actor.model} · temp ${s.models.actor.temperature} · top_p ${s.models.actor.top_p} · max ${s.models.actor.max_tokens}`,
    `- Image: ${s.models.image.model} at ${s.models.image.size}, generation ${s.images_enabled ? 'on' : 'off'}`,
    `- Tuning: spice ${s.spice} · activity ${s.activity} · rarity bias ${s.rarity_bias} · ${s.chat.context_messages} messages of context · up to ${s.chat.max_messages_per_turn} per turn`,
    '',
    'Settings are included because a prompt problem is usually a settings problem. No API keys',
    'are in this file - the header is built from named fields and the credentials are not among',
    'them - but the prompts below contain whatever you have told these characters about',
    'yourself, so read before you paste.',
    '',
    '---',
  ].join('\n');
}

export function exportLogs(opts: ExportOptions): string {
  const detail = opts.prompts ?? 'full';
  // queryLogs is newest-first because the pane is; reverse once, here, rather than teaching
  // the query a direction it has no other caller for.
  const entries = queryLogs({
    id: opts.id,
    scope: opts.scope,
    level: opts.level,
    q: opts.q,
    limit: Math.min(opts.limit ?? 200, 2000),
  }).reverse();

  if (!entries.length) return `${header(opts, 0)}\n\nNothing matched those filters.\n`;
  return `${header(opts, entries.length)}\n\n${entries.map((e) => renderEntry(e, detail)).join('\n---\n\n')}`;
}
