import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

export interface Config {
  ftp: number;
  riderMassKg: number;
  bikeMassKg: number;
  cda: number;
  crr: number;
  maxGrade: number;
  minGrade: number;
  difficulty: number;
  trainerName?: string;
  clickName?: string;
  stravaClientId?: string;
  stravaClientSecret?: string;
}

export const DEFAULTS: Config = {
  ftp: 200,
  riderMassKg: 75,
  bikeMassKg: 9,
  cda: 0.32,
  crr: 0.004,
  maxGrade: 15,
  minGrade: -10,
  difficulty: 1,
};

export const appDir = () => process.env.TRAINER_CLI_HOME ?? join(homedir(), '.trainer-cli');
export const configPath = () => join(appDir(), 'config.yaml');
export const activitiesDir = () => join(appDir(), 'activities');

export async function loadConfig(): Promise<Config> {
  try {
    const raw = YAML.parse(await readFile(configPath(), 'utf8')) ?? {};
    return { ...DEFAULTS, ...raw };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { ...DEFAULTS };
    throw new Error(`Cannot read ${configPath()}: ${e.message}`);
  }
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const cur = await loadConfig();
  const next = { ...cur, ...patch };
  await mkdir(appDir(), { recursive: true });
  // only persist non-default keys to keep the file readable
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (v !== undefined && (DEFAULTS as any)[k] !== v) out[k] = v;
  await writeFile(configPath(), YAML.stringify(out), { mode: 0o600 });
  return next;
}
