import { db } from './db/index.js';

export interface ModelConfig {
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
}

export interface Settings {
  api: {
    base_url: string;
    api_key: string;
    image_base_url: string;
    image_api_key: string;
  };
  models: {
    actor: ModelConfig;
    director: ModelConfig;
    image: { model: string; size: string };
  };
  /** Global multiplier for proactivity and wakeup frequency. Conservative by default. */
  activity: number;
  server_window: { from: string; to: string; timezone: string };
  budget: { max_calls_per_day: number; max_cost_per_day: number };
  chat: { context_messages: number; max_messages_per_turn: number; max_delay_seconds: number };
  images_enabled: boolean;
  voice_enabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  api: {
    base_url: process.env.FAUXR_API_BASE_URL || 'https://nano-gpt.com/api/v1',
    api_key: process.env.FAUXR_API_KEY || '',
    image_base_url: process.env.FAUXR_IMAGE_BASE_URL || 'https://nano-gpt.com/api/v1',
    image_api_key: process.env.FAUXR_IMAGE_API_KEY || '',
  },
  models: {
    actor: { model: 'glm-5.3-uncensored', temperature: 0.95, top_p: 0.95, max_tokens: 900 },
    director: { model: 'gemma-4', temperature: 0.4, top_p: 0.9, max_tokens: 1400 },
    image: { model: 'seedream', size: '1024x1024' },
  },
  activity: 0.6,
  server_window: { from: '06:00', to: '02:00', timezone: 'local' },
  budget: { max_calls_per_day: 1500, max_cost_per_day: 0 },
  chat: { context_messages: 40, max_messages_per_turn: 5, max_delay_seconds: 90 },
  images_enabled: false,
  voice_enabled: false,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge((base as any)[k], v) : v;
  }
  return out as T;
}

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
    | { value: string }
    | undefined;
  cached = row ? deepMerge(DEFAULT_SETTINGS, JSON.parse(row.value)) : DEFAULT_SETTINGS;
  return cached;
}

export function saveSettings(patch: unknown): Settings {
  const next = deepMerge(getSettings(), patch);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(next));
  cached = next;
  return next;
}
