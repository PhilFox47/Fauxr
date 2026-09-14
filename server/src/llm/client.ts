import { db, nowIso } from '../db/index.js';
import { getSettings, type ModelConfig } from '../config.js';
import { logger } from '../log.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | unknown[];
}

export class BudgetExceededError extends Error {}
export class LlmError extends Error {}

/**
 * The model used up its whole output budget and never finished. Worth its own type because
 * the fix is the opposite of the fix for bad JSON: the answer was not malformed, there was
 * no room left to write it, and re-asking with the same ceiling fails the same way.
 *
 * Reasoning models are how this bites. Their thinking is billed against `max_tokens`, so a
 * 120-token ceiling that is generous for `{ "username": "..." }` is spent before the answer
 * starts and the provider returns an empty string or a bare `{}`.
 */
export class TruncatedError extends LlmError {
  constructor(public readonly cap: number) {
    super(`response hit the ${cap}-token ceiling before it finished`);
  }
}

/** A rate limit, an overloaded upstream or a 5xx - the request was never really answered. */
export class TransportError extends LlmError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** Nothing is worth waiting longer than this for inside a single call. */
const MAX_BACKOFF_MS = 30_000;

/**
 * How long the provider asked us to wait. It says so twice and neither is a guess: the
 * `retry-after` header, and the prose in the error body ("Please try again after 60
 * seconds"). Falls back to a widening delay per attempt.
 */
function retryDelay(res: Response, body: string, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_BACKOFF_MS);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), MAX_BACKOFF_MS);
  }
  const spoken = body.match(/try again (?:in|after) (\d+) ?s(?:econds?)?/i);
  if (spoken) return Math.min(Number(spoken[1]) * 1000, MAX_BACKOFF_MS);
  return Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function usageToday(): { calls: number; tokens_in: number; tokens_out: number; cost: number } {
  const row = db.prepare('SELECT * FROM usage_daily WHERE day = ?').get(today()) as any;
  return row ?? { calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 };
}

function recordUsage(tokensIn: number, tokensOut: number, cost: number): void {
  db.prepare(
    `INSERT INTO usage_daily (day, calls, tokens_in, tokens_out, cost) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out, cost = cost + excluded.cost`,
  ).run(today(), tokensIn, tokensOut, cost);
}

function assertBudget(): void {
  const { budget } = getSettings();
  const used = usageToday();
  if (budget.max_calls_per_day > 0 && used.calls >= budget.max_calls_per_day) {
    throw new BudgetExceededError(`daily call budget reached (${used.calls})`);
  }
  if (budget.max_cost_per_day > 0 && used.cost >= budget.max_cost_per_day) {
    throw new BudgetExceededError(`daily cost budget reached (${used.cost.toFixed(2)})`);
  }
}

export interface CompletionOptions {
  scope: 'actor' | 'director' | 'image' | 'generator';
  messages: ChatMessage[];
  config: ModelConfig;
  /** Ask the provider for a JSON object where supported. */
  json?: boolean;
  label?: string;
  timeoutMs?: number;
  /**
   * On a truncated answer, re-ask once with a bigger ceiling instead of failing. On by
   * default: a truncation is a budget that was too small, and repeating the request
   * unchanged - which is what every caller used to do, three times over - cannot fix that.
   */
  expandOnTruncation?: boolean;
}

/**
 * How much room the second attempt gets. The floor matters as much as the multiple: tripling
 * a 120-token budget gives 360, which is still less than a reasoning model spends thinking, so
 * a pure multiple just fails twice as slowly. Whatever the original ask was, the retry gets
 * enough room to think and then answer.
 */
const EXPAND_FACTOR = 3;
// Floor and ceiling 4x'd along with every base budget below (1200/6000 -> 4800/24000), for
// the same reason: the ceiling has to clear the largest base budget with room to spare, or
// a call that fills a large budget thinking gets LESS room on the retry than it started
// with, which is backwards.
const EXPAND_FLOOR = 4800;
const EXPAND_CEILING = 24000;

/** Provider-side failures worth waiting out rather than giving up on. */
const RETRYABLE = (status: number) => status === 429 || status === 408 || status >= 500;
const TRANSPORT_ATTEMPTS = 3;

/**
 * OpenAI-compatible chat completion. Nano-GPT is the default provider, but nothing here
 * is provider specific beyond the configured base URL and key.
 */
export async function complete(opts: CompletionOptions): Promise<string> {
  // Two different recoveries, in the order they can be told apart. A provider that never
  // answered is waited out and asked again unchanged; an answer that ran out of room is
  // asked again with more room. Neither used to happen: both arrived at the caller as a
  // generic failure and were retried identically until the attempts ran out.
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(opts);
    } catch (err) {
      if (err instanceof TransportError && attempt < TRANSPORT_ATTEMPTS - 1) {
        logger.warn(opts.scope === 'generator' ? 'generator' : opts.scope, `provider said ${err.status}, waiting`, {
          label: opts.label,
          status: err.status,
          waiting_ms: err.retryAfterMs,
          attempt: attempt + 1,
        });
        await sleep(err.retryAfterMs);
        continue;
      }
      if (err instanceof TruncatedError && opts.expandOnTruncation !== false) {
        const roomier = Math.min(Math.max(err.cap * EXPAND_FACTOR, EXPAND_FLOOR), EXPAND_CEILING);
        if (roomier > err.cap) {
          logger.warn(opts.scope === 'generator' ? 'generator' : opts.scope, 'answer was cut off, re-asking with more room', {
            label: opts.label,
            was: err.cap,
            now: roomier,
          });
          return callOnce({
            ...opts,
            config: { ...opts.config, max_tokens: roomier },
            label: `${opts.label ?? 'call'}:roomier`,
            expandOnTruncation: false,
          });
        }
      }
      throw err;
    }
  }
}

async function callOnce(opts: CompletionOptions): Promise<string> {
  assertBudget();
  const settings = getSettings();
  const url = `${settings.api.base_url.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.config.model,
    messages: opts.messages,
    temperature: opts.config.temperature,
    top_p: opts.config.top_p,
    max_tokens: opts.config.max_tokens,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  // Pins an open-source model to one specific backend instead of leaving routing to the
  // provider. Omitted entirely when unset, which is the existing default behaviour.
  if (opts.config.provider) body.provider = opts.config.provider;

  const started = Date.now();
  const controller = new AbortController();
  // Raised alongside the token budgets above, for the same reason: a ceiling four times
  // larger needs real time to actually be written, or calls that would have finished start
  // getting cut off by the clock instead of the token cap - trading one kind of truncation
  // for another rather than removing it.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 300_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.api.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const duration = Date.now() - started;
    const raw = await res.text();
    if (!res.ok) {
      logger.error('api', `${opts.scope} call failed (${res.status})`, {
        label: opts.label,
        status: res.status,
        response: raw.slice(0, 2000),
        duration_ms: duration,
      });
      if (RETRYABLE(res.status)) {
        throw new TransportError(`${res.status} ${raw.slice(0, 300)}`, res.status, retryDelay(res, raw, 0));
      }
      throw new LlmError(`${res.status} ${raw.slice(0, 300)}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LlmError(`non-JSON response: ${raw.slice(0, 300)}`);
    }
    const text: string = parsed?.choices?.[0]?.message?.content ?? '';
    const usage = parsed?.usage ?? {};
    const finish: string = parsed?.choices?.[0]?.finish_reason ?? '';
    recordUsage(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, usage.cost ?? 0);

    // Two ways to see the same thing, because not every provider sends finish_reason: it
    // says "length" outright, or the completion count sits exactly on the ceiling. A model
    // that stopped because it was done always lands under it.
    const cap = opts.config.max_tokens;
    const out = Number(usage.completion_tokens ?? 0);
    const truncated = finish === 'length' || (cap > 0 && out >= cap);

    logger.info(opts.scope === 'generator' ? 'generator' : opts.scope, opts.label ?? 'llm call', {
      model: opts.config.model,
      duration_ms: duration,
      tokens_in: usage.prompt_tokens ?? null,
      tokens_out: usage.completion_tokens ?? null,
      // Recorded on every call so a cap that is quietly too tight is visible in the export
      // before it becomes a wave of empty answers.
      max_tokens: cap,
      finish_reason: finish || null,
      truncated,
      prompt: opts.messages,
      response: text,
    });

    if (truncated) {
      logger.warn(opts.scope === 'generator' ? 'generator' : opts.scope, 'answer was cut off at the token ceiling', {
        label: opts.label,
        model: opts.config.model,
        max_tokens: cap,
        tokens_out: out,
        // A reasoning model spends this budget thinking and then has nothing left to answer
        // with, which is why the content is usually empty or a bare {} rather than a
        // half-written sentence.
        content_length: text.length,
      });
      throw new TruncatedError(cap);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip code fences and pull the outermost JSON object out of a model response. */
export function extractJson<T = any>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new LlmError('no JSON object in response');
  return JSON.parse(t.slice(start, end + 1)) as T;
}

export interface JsonCallOptions extends CompletionOptions {
  /** Extra instruction appended on the retry after a parse failure. */
  retryHint?: string;
  /**
   * Keys the answer is worthless without. `{}` parses perfectly well, so without this a
   * model that gave up returns "successfully" and the caller discovers the hole itself -
   * or, as `write_username` did, discards it in silence and asks again identically.
   */
  require?: string[];
}

/** `{}` is valid JSON and a useless answer. Say which it is. */
function missingKeys(value: unknown, required: string[] | undefined): string[] {
  if (!required?.length) return [];
  const obj = (value ?? {}) as Record<string, unknown>;
  return required.filter((k) => {
    const v = obj[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
  });
}

export async function completeJson<T = any>(opts: JsonCallOptions): Promise<T> {
  let parsed: T;
  try {
    parsed = extractJson<T>(await complete({ ...opts, json: true }));
  } catch (err) {
    // Only a content problem earns the "that was not valid JSON" nudge. A rate limit or a
    // truncation has already been handled inside complete() with the recovery that actually
    // fits it, and re-asking here would just spend the provider's patience telling an
    // overloaded server that its JSON was malformed.
    if (err instanceof BudgetExceededError || err instanceof TransportError || err instanceof TruncatedError) throw err;
    logger.warn(opts.scope === 'generator' ? 'generator' : opts.scope, 'JSON parse failed, retrying', {
      label: opts.label,
      error: String(err),
    });
    return retryJson<T>(opts, opts.retryHint ??
      'Your previous answer was not valid JSON. Reply with a single JSON object and nothing else. No prose, no code fences, no trailing commas.');
  }

  const missing = missingKeys(parsed, opts.require);
  if (!missing.length) return parsed;

  logger.warn(opts.scope === 'generator' ? 'generator' : opts.scope, 'JSON was well formed but empty, retrying', {
    label: opts.label,
    missing,
  });
  return retryJson<T>(
    opts,
    `Your previous answer was missing ${missing.join(' and ')}. Reply with a single JSON object ` +
      `that actually contains ${missing.map((k) => `"${k}"`).join(' and ')}, and nothing else.`,
  );
}

async function retryJson<T>(opts: JsonCallOptions, hint: string): Promise<T> {
  const retried = await complete({
    ...opts,
    json: true,
    messages: [...opts.messages, { role: 'user', content: hint }],
    label: `${opts.label ?? 'call'}:retry`,
  });
  return extractJson<T>(retried);
}

export interface ImageRequest {
  prompt: string;
  /** Sent as `negative_prompt`. Omitted entirely when empty, as before. */
  negativePrompt?: string;
  seed?: number;
  refImage?: string;
}

/** Image generation. Returns base64 image data. */
export async function generateImage(req: ImageRequest): Promise<string> {
  assertBudget();
  const settings = getSettings();
  const base = settings.api.image_base_url || settings.api.base_url;
  const key = settings.api.image_api_key || settings.api.api_key;
  const body: Record<string, unknown> = {
    model: settings.models.image.model,
    prompt: req.prompt,
    size: settings.models.image.size,
    response_format: 'b64_json',
    n: 1,
  };
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.refImage) body.image = req.refImage;
  if (settings.models.image.provider) body.provider = settings.models.image.provider;

  const started = Date.now();
  const res = await fetch(`${base.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    logger.error('image', `image generation failed (${res.status})`, {
      status: res.status,
      response: raw.slice(0, 1000),
      prompt: req.prompt,
    });
    throw new LlmError(`image ${res.status}: ${raw.slice(0, 300)}`);
  }
  const parsed = JSON.parse(raw);
  recordUsage(0, 0, parsed?.cost ?? 0);
  logger.info('image', 'image generated', {
    duration_ms: Date.now() - started,
    prompt: req.prompt,
    seed: req.seed ?? null,
  });
  const b64 = parsed?.data?.[0]?.b64_json;
  if (!b64) throw new LlmError('image response contained no b64_json');
  return b64;
}
