import type { StoredMessage } from '../repo.js';

/**
 * Reciprocity and pressure are computed in code, never by an LLM. They are the
 * anti-simp and anti-push mechanism: they modify the Director's deltas after the fact.
 */

const WINDOW = 20;
const PRESSURE_HALF_LIFE_HOURS = 12;

const QUESTION_STARTERS = /^(what|why|how|when|where|who|which|do|does|did|are|is|was|were|can|could|would|will|have|has|any|tell me)\b/i;
const SELF_MARKERS = /\b(i|i'm|im|i've|ive|i'd|id|i'll|my|me|mine|myself)\b/i;
const REFUSAL_MARKERS =
  /\b(no|nope|not really|rather not|i'd rather|i would rather|maybe later|not yet|don't want|dont want|not comfortable|can't|cant|stop|later|not telling|nice try|next question|why do you (want to )?know)\b/i;

function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.includes('?') || QUESTION_STARTERS.test(t);
}

function isAboutSelf(text: string): boolean {
  return SELF_MARKERS.test(text) && !isQuestion(text);
}

/**
 * 0 means he only ever talks about himself, 1 means he only ever interrogates her.
 * 0.5 is a conversation. Both extremes are punished.
 */
export function computeReciprocity(messages: StoredMessage[]): number {
  const userMessages = messages.filter((m) => m.sender === 'user').slice(-WINDOW);
  if (userMessages.length === 0) return 0.5;
  let questions = 0;
  let self = 0;
  for (const m of userMessages) {
    if (isQuestion(m.text)) questions++;
    if (isAboutSelf(m.text)) self++;
  }
  const total = questions + self;
  if (total === 0) return 0.5;
  return questions / total;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

export interface PressureInput {
  previous: number;
  /** Hours since pressure was last updated, for the time decay. */
  hoursElapsed: number;
  messages: StoredMessage[];
  /** The Actor reported that he touched a boundary this turn. */
  boundaryTouched: boolean;
  /** A negative flag such as boundary_crossed_recent is currently active. */
  negativeFlagActive: boolean;
}

/** Pressure decays on a half-life and rises when he pushes. Range 0..5. */
export function computePressure(input: PressureInput): number {
  const decayed =
    input.previous * Math.pow(0.5, Math.max(0, input.hoursElapsed) / PRESSURE_HALF_LIFE_HOURS);
  let add = 0;

  if (input.boundaryTouched) add += 1.0;
  if (input.negativeFlagActive) add += 0.4;

  const userMessages = input.messages.filter((m) => m.sender === 'user');
  const latest = userMessages[userMessages.length - 1];

  if (latest) {
    // Repeating himself: asking the same thing again after she moved past it.
    for (const earlier of userMessages.slice(-5, -1)) {
      if (overlap(latest.text, earlier.text) > 0.5) {
        add += 0.8;
        break;
      }
    }

    // Pushing straight after a refusal.
    const idx = input.messages.findIndex((m) => m.id === latest.id);
    const before = input.messages.slice(0, idx).reverse().find((m) => m.sender === 'character');
    if (before && REFUSAL_MARKERS.test(before.text) && isQuestion(latest.text)) add += 0.6;
  }

  // Message spam: several messages in a row with no reply from her.
  let streak = 0;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i].sender === 'user') streak++;
    else break;
  }
  if (streak >= 3) add += 0.3 * (streak - 2);

  return Math.min(5, Math.max(0, decayed + add));
}

export interface Deltas { trust: number; spark: number; investment: number }

/**
 * Apply the code modifiers on top of the Director's raw deltas.
 * High pressure damps gains and amplifies losses. Lopsided reciprocity damps gains.
 */
export function applyModifiers(raw: Deltas, reciprocity: number, pressure: number): Deltas {
  const balance = Math.max(0.35, 1 - 1.2 * Math.abs(reciprocity - 0.5));
  const gainDamp = balance / (1 + pressure * 0.35);
  const lossAmp = 1 + pressure * 0.5;

  const shape = (v: number, gainWeight = 1) =>
    v >= 0 ? v * gainDamp * gainWeight : v * lossAmp;

  return {
    trust: shape(raw.trust),
    // Spark is volatile and less sensitive to reciprocity than trust is.
    spark: raw.spark >= 0 ? raw.spark * (0.5 + balance / 2) / (1 + pressure * 0.2) : raw.spark * lossAmp,
    investment: shape(raw.investment),
  };
}

export function clampStat(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
