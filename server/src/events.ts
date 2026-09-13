import { EventEmitter } from 'node:events';

export type AppEvent =
  | { type: 'message'; character_id: string; message: unknown }
  | { type: 'message_updated'; character_id: string; message: unknown }
  | { type: 'typing'; character_id: string; on: boolean }
  | { type: 'read'; character_id: string; at: string }
  | { type: 'match'; character_id: string }
  | { type: 'character_state'; character_id: string; state: string }
  | { type: 'presence'; character_id: string; online: boolean }
  | { type: 'stack'; count: number }
  | { type: 'generating'; count: number }
  | { type: 'reset' }
  | { type: 'messages_removed'; character_id: string; message_ids: number[] };

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
