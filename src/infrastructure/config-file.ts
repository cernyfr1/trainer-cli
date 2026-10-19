import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { ConfigStore } from '../application/ports.js';
import { DEFAULTS, type Config } from '../domain/config.js';

/** `<appDir>/config.yaml`; appDir is $TRAINER_CLI_HOME or ~/.trainer-cli. Also knows the app's other paths. */
export class ConfigFile implements ConfigStore {
  constructor(readonly appDir = process.env.TRAINER_CLI_HOME ?? join(homedir(), '.trainer-cli')) {}

  get path() { return join(this.appDir, 'config.yaml'); }
  get activitiesDir() { return join(this.appDir, 'activities'); }

  async load(): Promise<Config> {
    try {
      const raw = YAML.parse(await readFile(this.path, 'utf8')) ?? {};
      return { ...DEFAULTS, ...raw };
    } catch (e: any) {
      if (e.code === 'ENOENT') return { ...DEFAULTS };
      throw new Error(`Cannot read ${this.path}: ${e.message}`);
    }
  }

  async save(patch: Partial<Config>): Promise<Config> {
    const cur = await this.load();
    const next = { ...cur, ...patch };
    await mkdir(this.appDir, { recursive: true });
    // only persist non-default keys to keep the file readable
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) if (v !== undefined && (DEFAULTS as any)[k] !== v) out[k] = v;
    await writeFile(this.path, YAML.stringify(out), { mode: 0o600 });
    return next;
  }
}
