import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Raw device traffic appended to `<dir>/debug.log` when enabled (TRAINER_CLI_DEBUG=1). Never throws. */
export class DebugLog {
  constructor(private dir: string, readonly enabled: boolean) {}

  get path() { return join(this.dir, 'debug.log'); }

  write(line: string) {
    if (!this.enabled) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path, `${new Date().toISOString()} ${line}\n`);
    } catch { /* never break a ride over logging */ }
  }
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();
