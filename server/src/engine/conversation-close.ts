import { gameClockMs } from './clock.js';
import type { Relationship } from '../types.js';

export const CLOSED_REOPEN_REASON = 'she is reopening a conversation she previously chose to close';
export const CLOSED_REOPEN_AT_KEY = 'conversation_reopen_at_ms';

/** A soft close is the sole source of an automatic first text after matching. */
export function armConversationReopen(rel: Relationship, hours: number): void {
  rel.mood = {
    ...rel.mood,
    [CLOSED_REOPEN_AT_KEY]: gameClockMs(rel) + Math.max(1, hours) * 3_600_000,
  };
}

/** His message resumes the conversation and makes her pending reopen unnecessary. */
export function cancelConversationReopen(rel: Relationship): void {
  if (!(CLOSED_REOPEN_AT_KEY in rel.mood)) return;
  const mood = { ...rel.mood };
  delete mood[CLOSED_REOPEN_AT_KEY];
  rel.mood = mood;
}

export function conversationReopenAt(rel: Relationship): number | null {
  const value = Number(rel.mood[CLOSED_REOPEN_AT_KEY]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
