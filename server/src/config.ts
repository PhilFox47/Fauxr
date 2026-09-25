import { db } from './db/index.js';

export interface ModelConfig {
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  /**
   * Optional upstream routing hint (Nano-GPT's `provider` field on chat completions) -
   * pins an open-source model to one specific backend instead of letting it pick. Left
   * unset, the request omits the field entirely and the provider decides as usual.
   */
  provider?: string;
}

export interface Settings {
  api: {
    base_url: string;
    api_key: string;
    image_base_url: string;
    image_api_key: string;
    /**
     * Send each reply's JSON Schema (`response_format: json_schema`) instead of plain JSON
     * mode. Falls back to plain JSON on its own for a model the provider will not do it for.
     */
    structured_outputs: boolean;
  };
  models: {
    actor: ModelConfig;
    director: ModelConfig;
    image: {
      model: string;
      size: string;
      provider?: string;
      /**
       * These two models want fundamentally different prompts - Seedream 5.0 Lite reads a
       * concise photographer's-brief paragraph and a short natural-language negative;
       * Z Image Turbo runs with no classifier-free guidance at all, so it ignores negative
       * prompts entirely and wants every constraint folded into a longer, more detailed
       * positive prompt instead. See image_prompt_assembler.md and images.ts's per-mode
       * suffix/negative constants for what actually changes.
       */
      prompt_style: 'seedream' | 'z_image_turbo';
    };
  };
  /** Global multiplier for proactivity and wakeup frequency. Conservative by default. */
  activity: number;
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
   * How forward the cast runs, on top of each character's own appetite. 1 is the designed
   * pacing. This is handed to the Director as a sentence about house pacing rather than
   * applied to any gate - there are no thresholds left for it to scale - so it leans
   * judgment across every character and takes effect immediately, including on matches you
   * already have.
   */
  spice: number;
  /**
   * How much of the rare tail shows up. 1 is the tuned default; higher surfaces niche
   * attributes more often, lower keeps characters closer to the common set.
   */
  rarity_bias: number;
  /**
   * Whether characters may message him unprompted: follow-ups after a silence, check-ins,
   * anniversaries, and the wakeups the Director schedules. Off by default - they cost tokens
   * and can feel like pressure. With it off, a character only ever writes when he has (plus
   * her one opening message after a match).
   */
  unprompted_messages: boolean;
  /**
   * His taste, from Settings -> Taste: "category/id" -> multiplier on how often that attribute
   * is rolled for a new character (0 never, 1 or absent normal). Two keys are not attribute
   * rows: "lean/dom_sub" (-1..1) leans the persona roll towards submissive or dominant, and
   * kink domains ("kink_domain/feet") lean how likely she is to be into them.
   */
  taste: Record<string, number>;
}

export const DEFAULT_SETTINGS: Settings = {
  api: {
    base_url: process.env.FAUXR_API_BASE_URL || 'https://nano-gpt.com/api/v1',
    api_key: process.env.FAUXR_API_KEY || '',
    image_base_url: process.env.FAUXR_IMAGE_BASE_URL || 'https://nano-gpt.com/api/v1',
    image_api_key: process.env.FAUXR_IMAGE_API_KEY || '',
    structured_outputs: process.env.FAUXR_STRUCTURED_OUTPUTS !== '0',
  },
  models: {
    // The ceilings are deliberately well clear of the answer's own size. Reasoning models
    // bill their thinking against max_tokens, so a budget sized for the reply alone is spent
    // before the reply starts and comes back empty. Saved settings keep whatever they have;
    // complete() widens a ceiling that is plainly too tight rather than failing on it.
    // 4x'd from 1800/2600: a deliberate tradeoff toward never letting a real answer get cut
    // off by its own ceiling, at the cost of a slower/pricier worst case on a call that
    // genuinely fills the budget thinking. See complete()'s truncation handling below for
    // why the ceiling matters more than it looks like it should for a reasoning model.
    actor: { model: 'z-ai/glm-5.3-flash-uncensored', temperature: 0.95, top_p: 0.95, max_tokens: 7200 },
    director: { model: 'google/gemma-4-31b-it', temperature: 0.4, top_p: 0.9, max_tokens: 10400 },
    image: { model: 'seedream-v4', size: '1024x1024', prompt_style: 'seedream' },
  },
  activity: 0.6,
  budget: { max_calls_per_day: 1500, max_cost_per_day: 0 },
  chat: { context_messages: 40, max_messages_per_turn: 5, max_delay_seconds: 10 },
  images_enabled: false,
  voice_enabled: false,
  spice: 1.15,
  rarity_bias: 1,
  unprompted_messages: false,
  taste: {},
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
