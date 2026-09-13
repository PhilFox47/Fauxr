import { db, nowIso } from '../db/index.js';
import { getSettings, type ModelConfig } from '../config.js';
import { logger } from '../log.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | unknown[];
}

export class BudgetExceededError extends Error {}
export class LlmError extends Error {}

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
}

/**
 * OpenAI-compatible chat completion. Nano-GPT is the default provider, but nothing here
 * is provider specific beyond the configured base URL and key.
 */
export async function complete(opts: CompletionOptions): Promise<string> {
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

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
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
    recordUsage(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, usage.cost ?? 0);

    logger.info(opts.scope === 'generator' ? 'generator' : opts.scope, opts.label ?? 'llm call', {
      model: opts.config.model,
      duration_ms: duration,
      tokens_in: usage.prompt_tokens ?? null,
      tokens_out: usage.completion_tokens ?? null,
      prompt: opts.messages,
      response: text,
    });
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
}

export async function completeJson<T = any>(opts: JsonCallOptions): Promise<T> {
  try {
    return extractJson<T>(await complete({ ...opts, json: true }));
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    logger.warn(opts.scope === 'generator' ? 'generator' : opts.scope, 'JSON parse failed, retrying', {
      label: opts.label,
      error: String(err),
    });
    const hint =
      opts.retryHint ??
      'Your previous answer was not valid JSON. Reply with a single JSON object and nothing else. No prose, no code fences, no trailing commas.';
    const retried = await complete({
      ...opts,
      json: true,
      messages: [...opts.messages, { role: 'user', content: hint }],
      label: `${opts.label ?? 'call'}:retry`,
    });
    return extractJson<T>(retried);
  }
}

export interface ImageRequest {
  prompt: string;
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
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.refImage) body.image = req.refImage;

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
