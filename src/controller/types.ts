import type { EventEmitter } from 'node:events';

/**
 * A handlebar remote the session can listen to. Implementations: ZwiftClick, MockClick.
 * Emits: 'adjust' (1 | -1), 'connected', 'disconnect', 'log' (string).
 */
export interface Controller extends EventEmitter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
