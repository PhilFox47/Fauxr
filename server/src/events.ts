import { EventEmitter } from 'node:events';

export type AppEvent<TMessage = unknown, TDate = unknown> =
  | { type: 'message'; character_id: string; message: TMessage }
  | { type: 'message_updated'; character_id: string; message: TMessage }
  | { type: 'typing'; character_id: string; on: boolean }
  | { type: 'read'; character_id: string; at: string }
  | { type: 'match'; character_id: string }
  | { type: 'character_state'; character_id: string; state: string }
  | { type: 'match_removed'; character_id: string }
  | { type: 'stack'; count: number }
  | { type: 'generating'; count: number }
  | { type: 'reset' }
  | { type: 'messages_removed'; character_id: string; message_ids: number[] }
  /** A date started or ended - the chat screen switches register on this. */
  | { type: 'date'; character_id: string; date: TDate }
  // Sent directly when a socket connects rather than through the in-process bus, but part of
  // the same wire contract consumed by the browser.
  | { type: 'hello'; at: string };

class Bus extends EventEmitter {
  emitEvent(e: AppEvent): void {
    this.emit('event', e);
  }
  onEvent(fn: (e: AppEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);
