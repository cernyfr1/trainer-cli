import { EventEmitter } from 'node:events';
import type { Controller } from './types.js';

/** Fake handlebar remote for tests: call press() to simulate a button. */
export class MockClick extends EventEmitter implements Controller {
  readonly name = 'MockClick';

  async connect() { this.emit('log', 'mock click connected'); this.emit('connected'); }
  async disconnect() { this.emit('disconnect'); }
  press(dir: 1 | -1) { this.emit('adjust', dir); }
}
