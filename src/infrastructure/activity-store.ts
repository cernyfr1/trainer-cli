import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityStore } from '../application/ports.js';
import type { FinishedActivity } from '../domain/activity.js';
import { FitEncoder } from './fit-encoder.js';

/** Writes activities as FIT files: <dir>/YYYY-MM-DD-HH-MM-<name>.fit */
export class FitFileStore implements ActivityStore {
  constructor(private dir: string, private encoder = new FitEncoder()) {}

  async save(a: FinishedActivity): Promise<string> {
    const bytes = this.encoder.encode(a);
    await mkdir(this.dir, { recursive: true });
    const stamp = a.samples[0].time.toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ride';
    const file = join(this.dir, `${stamp}-${slug}.fit`);
    await writeFile(file, bytes);
    return file;
  }
}
