import { db } from './db/index.js';

export interface ModelConfig {
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  /** NanoGPT reasoning depth. `none` prevents small creative tasks spending minutes thinking. */
  reasoning_effort: ReasoningEffort;
  /**
   * Optional upstream routing hint (Nano-GPT's `provider` field on chat completions) -
   * pins an open-source model to one specific backend instead of letting it pick. Left
   * unset, the request omits the field entirely and the provider decides as usual.
   */
  provider?: string;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface EvaluatorConfig {
  enabled: boolean;
  /** A System One decision model, not a chat-completion model. */
  model: string;
  /** Low-confidence judgments stay diagnostic and never block character creation. */
  confidence_threshold: number;
}

export interface ImageSizeSetting {
  size: string;
  profile: boolean;
  chat: boolean;
  date: boolean;
}

/** Per-job output ceilings that intentionally differ from the Actor/Director defaults. */
export interface TokenLimits {
  status: number;
  schedule: number;
  status_post: number;
  life_threads: number;
  date_cast: number;
  date_scene: number;
  date_outfit: number;
  character: number;
  character_coherence: number;
  name_and_handle: number;
  bio: number;
  profile_picture_brief: number;
  chat_photo_idea: number;
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
    /**
     * Writes her text-chat messages as plain text when `chat_pipeline` is "split". Any model
     * that writes her well: it is never asked for JSON, so a pure roleplay model works.
     */
    writer: ModelConfig;
    director: ModelConfig;
    /**
     * Reads her finished reply and records what it made true (engine/reconciler.ts). A
     * manager-model job: extraction, not writing, so it wants a low temperature.
     */
    reconciler: ModelConfig;
    evaluator: EvaluatorConfig;
    image: {
      model: string;
      /** Legacy fallback retained for old settings and providers with no model metadata. */
      size: string;
      sizes: ImageSizeSetting[];
      /** 0 means unlimited; otherwise the complete prompt sent upstream is capped. */
      max_prompt_chars: number;
      /** Attach Fauxr's private identity plate when the selected model accepts image input. */
      send_reference_image: boolean;
      provider?: string;
      /**
       * These models want fundamentally different prompts - Seedream 5.0 Lite reads a
       * concise photographer's-brief paragraph and a short natural-language negative;
       * Z Image Turbo runs with no classifier-free guidance at all, so it ignores negative
       * prompts entirely and wants every constraint folded into a longer, more detailed
       * positive prompt instead. See image_prompt_assembler.md and images.ts's per-mode
       * suffix/negative constants for what actually changes.
       */
      prompt_style: 'seedream' | 'z_image_turbo' | 'chroma';
    };
  };
  token_limits: TokenLimits;
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
  /** Opt-in paid/free image work before a swipe; off preserves the manual chat action. */
  show_images_during_matching: boolean;
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
   * Whether her own explicit soft close may arm one later conversation reopen. Generic
   * silence, anniversaries and Director-authored wakeups never initiate messages.
   */
  unprompted_messages: boolean;
  /** World-hours after her own soft close before she may start the next conversation. */
  conversation_reopen_hours: number;
  /** Average image Status stories generated per fictional world-hour across the whole cast. */
  status_posts_per_hour: number;
  /**
   * Run the Reconciler next to every text turn and compare it with the Actor's own hidden
   * report. Measurement only: nothing it says is applied. Off by default because it adds one
   * call per turn to the daily budget.
   */
  reconciler_shadow: boolean;
  /**
   * How a text-chat reply is produced. "classic": the Actor writes her messages and her hidden
   * report as one JSON object. "split": the Writer writes only her messages, as plain text, and
   * the Reconciler reads what they changed (engine/writer.ts, engine/reconciler.ts).
   */
  chat_pipeline: 'classic' | 'split';
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
    actor: { model: 'z-ai/glm-5.3-flash-uncensored', temperature: 0.95, top_p: 0.95, max_tokens: 7200, reasoning_effort: 'none' },
    director: { model: 'google/gemma-4-31b-it', temperature: 0.4, top_p: 0.9, max_tokens: 10400, reasoning_effort: 'low' },
    writer: { model: 'z-ai/glm-5.3-flash-uncensored', temperature: 0.9, top_p: 0.95, max_tokens: 4000, reasoning_effort: 'none' },
    reconciler: { model: 'google/gemma-4-31b-it', temperature: 0.2, top_p: 0.9, max_tokens: 6000, reasoning_effort: 'low' },
    evaluator: { enabled: true, model: 'typesafe/jev-latest', confidence_threshold: 0.65 },
    image: {
      model: 'seedream-v4',
      size: '2048x2048',
      sizes: [
        { size: '2048x2048', profile: true, chat: true, date: false },
        { size: '2048x3072', profile: false, chat: true, date: true },
        { size: '3072x2048', profile: false, chat: true, date: true },
      ],
      max_prompt_chars: 0,
      send_reference_image: true,
      prompt_style: 'seedream',
    },
  },
  token_limits: {
    status: 600,
    schedule: 9000,
    status_post: 1800,
    life_threads: 1200,
    date_cast: 900,
    date_scene: 1500,
    date_outfit: 1000,
    character: 14_400,
    character_coherence: 2400,
    name_and_handle: 2400,
    bio: 4800,
    profile_picture_brief: 4800,
    chat_photo_idea: 2400,
  },
  activity: 0.6,
  budget: { max_calls_per_day: 1500, max_cost_per_day: 0 },
  chat: { context_messages: 40, max_messages_per_turn: 5, max_delay_seconds: 10 },
  images_enabled: false,
  show_images_during_matching: false,
  voice_enabled: false,
  spice: 1.15,
  rarity_bias: 1,
  unprompted_messages: false,
  conversation_reopen_hours: 8,
  status_posts_per_hour: 1,
  reconciler_shadow: false,
  chat_pipeline: 'classic',
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

function stringValue(value: unknown, fallback: string, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(numberValue(value, fallback, min, max));
}

function modelConfig(value: unknown, fallback: ModelConfig): ModelConfig {
  const v = isPlainObject(value) ? value : {};
  const provider = stringValue(v.provider, '', 120);
  return {
    model: stringValue(v.model, fallback.model, 200) || fallback.model,
    temperature: numberValue(v.temperature, fallback.temperature, 0, 2),
    top_p: numberValue(v.top_p, fallback.top_p, 0.1, 1),
    max_tokens: integerValue(v.max_tokens, fallback.max_tokens, 128, 100_000),
    reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(v.reasoning_effort))
      ? v.reasoning_effort as ReasoningEffort
      : fallback.reasoning_effort,
    ...(provider ? { provider } : {}),
  };
}

/**
 * Settings are persistent input, not trusted program state. Keep the stored document to the
 * public shape and clamp every numeric field before any prompt, timer or provider request can
 * consume it. This also repairs settings written by older clients on their next save.
 */
export function normalizeSettings(value: unknown): Settings {
  const v = isPlainObject(value) ? value : {};
  const api = isPlainObject(v.api) ? v.api : {};
  const models = isPlainObject(v.models) ? v.models : {};
  const image = isPlainObject(models.image) ? models.image : {};
  const budget = isPlainObject(v.budget) ? v.budget : {};
  const chat = isPlainObject(v.chat) ? v.chat : {};
  const tokenLimits = isPlainObject(v.token_limits) ? v.token_limits : {};
  const rawTaste = isPlainObject(v.taste) ? v.taste : {};
  const taste: Record<string, number> = {};
  for (const [key, raw] of Object.entries(rawTaste)) {
    if (key.length > 160) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    taste[key] = key === 'lean/dom_sub'
      ? Math.max(-1, Math.min(1, n))
      : Math.max(0, Math.min(3, n));
  }

  const imageProvider = stringValue(image.provider, '', 120);
  const rawImageSizes = Array.isArray(image.sizes) ? image.sizes : DEFAULT_SETTINGS.models.image.sizes;
  const imageSizes = rawImageSizes
    .filter(isPlainObject)
    .map((row) => ({
      size: stringValue(row.size, '', 40).toLowerCase().replace('*', 'x'),
      profile: row.profile === true,
      chat: row.chat === true,
      date: row.date === true,
    }))
    .filter((row, index, all) => /^\d{2,5}x\d{2,5}$/.test(row.size) && all.findIndex((other) => other.size === row.size) === index)
    .slice(0, 40);
  return {
    api: {
      base_url: stringValue(api.base_url, DEFAULT_SETTINGS.api.base_url, 500),
      api_key: stringValue(api.api_key, DEFAULT_SETTINGS.api.api_key, 1000),
      image_base_url: stringValue(api.image_base_url, DEFAULT_SETTINGS.api.image_base_url, 500),
      image_api_key: stringValue(api.image_api_key, DEFAULT_SETTINGS.api.image_api_key, 1000),
      structured_outputs: typeof api.structured_outputs === 'boolean'
        ? api.structured_outputs
        : DEFAULT_SETTINGS.api.structured_outputs,
    },
    models: {
      actor: modelConfig(models.actor, DEFAULT_SETTINGS.models.actor),
      writer: modelConfig(models.writer, DEFAULT_SETTINGS.models.writer),
      director: modelConfig(models.director, DEFAULT_SETTINGS.models.director),
      reconciler: modelConfig(models.reconciler, DEFAULT_SETTINGS.models.reconciler),
      evaluator: {
        enabled: isPlainObject(models.evaluator) && typeof models.evaluator.enabled === 'boolean'
          ? models.evaluator.enabled
          : DEFAULT_SETTINGS.models.evaluator.enabled,
        model: stringValue(
          isPlainObject(models.evaluator) ? models.evaluator.model : undefined,
          DEFAULT_SETTINGS.models.evaluator.model,
          200,
        ) || DEFAULT_SETTINGS.models.evaluator.model,
        confidence_threshold: numberValue(
          isPlainObject(models.evaluator) ? models.evaluator.confidence_threshold : undefined,
          DEFAULT_SETTINGS.models.evaluator.confidence_threshold,
          0,
          1,
        ),
      },
      image: {
        model: stringValue(image.model, DEFAULT_SETTINGS.models.image.model, 200) || DEFAULT_SETTINGS.models.image.model,
        size: stringValue(image.size, DEFAULT_SETTINGS.models.image.size, 80) || DEFAULT_SETTINGS.models.image.size,
        sizes: imageSizes.length ? imageSizes : DEFAULT_SETTINGS.models.image.sizes.map((row) => ({ ...row })),
        max_prompt_chars: integerValue(image.max_prompt_chars, DEFAULT_SETTINGS.models.image.max_prompt_chars, 0, 100_000),
        send_reference_image: typeof image.send_reference_image === 'boolean'
          ? image.send_reference_image
          : DEFAULT_SETTINGS.models.image.send_reference_image,
        prompt_style: ['seedream', 'z_image_turbo', 'chroma'].includes(String(image.prompt_style))
          ? image.prompt_style as Settings['models']['image']['prompt_style']
          : 'seedream',
        ...(imageProvider ? { provider: imageProvider } : {}),
      },
    },
    token_limits: Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS.token_limits).map(([key, fallback]) => [
        key,
        integerValue(tokenLimits[key], fallback, 128, 100_000),
      ]),
    ) as unknown as TokenLimits,
    activity: numberValue(v.activity, DEFAULT_SETTINGS.activity, 0.1, 3),
    budget: {
      max_calls_per_day: integerValue(budget.max_calls_per_day, DEFAULT_SETTINGS.budget.max_calls_per_day, 0, 100_000),
      max_cost_per_day: numberValue(budget.max_cost_per_day, DEFAULT_SETTINGS.budget.max_cost_per_day, 0, 1_000_000),
    },
    chat: {
      context_messages: integerValue(chat.context_messages, DEFAULT_SETTINGS.chat.context_messages, 1, 500),
      max_messages_per_turn: integerValue(chat.max_messages_per_turn, DEFAULT_SETTINGS.chat.max_messages_per_turn, 1, 10),
      max_delay_seconds: numberValue(chat.max_delay_seconds, DEFAULT_SETTINGS.chat.max_delay_seconds, 0, 120),
    },
    images_enabled: typeof v.images_enabled === 'boolean' ? v.images_enabled : DEFAULT_SETTINGS.images_enabled,
    show_images_during_matching: typeof v.show_images_during_matching === 'boolean'
      ? v.show_images_during_matching
      : DEFAULT_SETTINGS.show_images_during_matching,
    voice_enabled: typeof v.voice_enabled === 'boolean' ? v.voice_enabled : DEFAULT_SETTINGS.voice_enabled,
    spice: numberValue(v.spice, DEFAULT_SETTINGS.spice, 0.3, 2),
    rarity_bias: numberValue(v.rarity_bias, DEFAULT_SETTINGS.rarity_bias, 0.3, 2.5),
    unprompted_messages: typeof v.unprompted_messages === 'boolean'
      ? v.unprompted_messages
      : DEFAULT_SETTINGS.unprompted_messages,
    conversation_reopen_hours: numberValue(v.conversation_reopen_hours, DEFAULT_SETTINGS.conversation_reopen_hours, 1, 168),
    status_posts_per_hour: numberValue(v.status_posts_per_hour, DEFAULT_SETTINGS.status_posts_per_hour, 0, 12),
    chat_pipeline: v.chat_pipeline === 'split' ? 'split' : 'classic',
    reconciler_shadow: typeof v.reconciler_shadow === 'boolean' ? v.reconciler_shadow : DEFAULT_SETTINGS.reconciler_shadow,
    taste,
  };
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
  if (!row) {
    cached = DEFAULT_SETTINGS;
    return cached;
  }
  try {
    cached = applyEnvFallbacks(normalizeSettings(deepMerge(DEFAULT_SETTINGS, JSON.parse(row.value))));
  } catch {
    // A manually edited or interrupted row must not make every request fail. Keep it in place
    // for diagnosis; the next successful save replaces it with a normalized document.
    console.warn('[config] saved settings were not valid JSON; using defaults');
    cached = DEFAULT_SETTINGS;
  }
  return cached;
}

export function saveSettings(patch: unknown): Settings {
  const next = normalizeSettings(deepMerge(getSettings(), patch));
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(next));
  cached = applyEnvFallbacks(next);
  return cached;
}
