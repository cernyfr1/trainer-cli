import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appDir } from '../config.js';

/** TRAINER_CLI_DEBUG=1 → raw controller traffic appended to ~/.trainer-cli/debug.log. */
const enabled = !!process.env.TRAINER_CLI_DEBUG;
export const debugLogPath = () => join(appDir(), 'debug.log');

export function debugLog(line: string) {
  if (!enabled) return;
  try {
    mkdirSync(appDir(), { recursive: true });
    appendFileSync(debugLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch { /* never break a ride over logging */ }
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();
