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
  chat: {
    context_messages: number;
    max_messages_per_turn: number;
    /** Ceiling for the gap between messages inside one turn. The first is always instant. */
    max_delay_seconds: number;
  };
  images_enabled: boolean;
  voice_enabled: boolean;
  /**
   * Testing override: every character counts as online at all times, the server uptime
   * window is ignored, and nobody stays away after announcing they are leaving. Turn it
   * off to get the real pacing back.
   */
  always_online: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  api: {
    base_url: process.env.FAUXR_API_BASE_URL || 'https://nano-gpt.com/api/v1',
    api_key: process.env.FAUXR_API_KEY || '',
    image_base_url: process.env.FAUXR_IMAGE_BASE_URL || 'https://nano-gpt.com/api/v1',
    image_api_key: process.env.FAUXR_IMAGE_API_KEY || '',
  },
  models: {
    actor: { model: 'z-ai/glm-5.3-flash-uncensored', temperature: 0.95, top_p: 0.95, max_tokens: 900 },
    director: { model: 'google/gemma-4-31b-it', temperature: 0.4, top_p: 0.9, max_tokens: 1400 },
    image: { model: 'seedream-v4', size: '1024x1024' },
  },
  activity: 0.6,
  server_window: { from: '06:00', to: '02:00', timezone: 'local' },
  budget: { max_calls_per_day: 1500, max_cost_per_day: 0 },
  chat: { context_messages: 40, max_messages_per_turn: 5, max_delay_seconds: 10 },
  images_enabled: false,
  voice_enabled: false,
  always_online: true,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge a patch over the defaults. Objects are merged key by key; anything else -
 * strings, numbers, booleans, arrays - replaces the value outright. Only `undefined`
 * means "leave it alone", so a patch can legitimately set an empty string or 0.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge((base as any)[k], v) : v;
  }
  return out as T;
}

let cached: Settings | null = null;

/**
 * Saved settings win over the environment, but an empty saved credential does not:
 * saving the settings page once with a blank key would otherwise silently override the
 * key supplied through docker compose.
 */
function applyEnvFallbacks(settings: Settings): Settings {
  const api = { ...settings.api };
  for (const [key, fallback] of [
    ['base_url', DEFAULT_SETTINGS.api.base_url],
    ['api_key', DEFAULT_SETTINGS.api.api_key],
    ['image_base_url', DEFAULT_SETTINGS.api.image_base_url],
    ['image_api_key', DEFAULT_SETTINGS.api.image_api_key],
  ] as const) {
    if (!api[key] && fallback) api[key] = fallback;
  }
  return { ...settings, api };
}

export function clearSettingsCache(): void {
  cached = null;
}

export function getSettings(): Settings {
  if (cached) return cached;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
    | { value: string }
    | undefined;
  cached = row
    ? applyEnvFallbacks(deepMerge(DEFAULT_SETTINGS, JSON.parse(row.value)))
    : DEFAULT_SETTINGS;
  return cached;
}

export function saveSettings(patch: unknown): Settings {
  const next = deepMerge(getSettings(), patch);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(next));
  cached = applyEnvFallbacks(next);
  return cached;
}
