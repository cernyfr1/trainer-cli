import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import YAML from 'yaml';
import { XMLParser } from 'fast-xml-parser';

/** Power target: fraction of FTP (0.75) or absolute watts. */
export type Power = { ftp: number } | { watts: number };

export interface Step {
  label: string;
  kind: 'warmup' | 'work' | 'recovery' | 'cooldown' | 'steady' | 'free';
  durationS: number;
  from: Power;       // start of step
  to: Power;         // end of step (== from for steady)
  cadence?: number;
}

export interface Workout { name: string; ftp?: number; description?: string; steps: Step[]; totalS: number }

export interface WorkoutTarget { step: Step; index: number; stepElapsedS: number; stepRemainingS: number; watts: number | null; done: boolean }

export async function loadWorkout(path: string): Promise<Workout> {
  const ext = extname(path).toLowerCase();
  const text = await readFile(path, 'utf8');
  const name = basename(path, ext);
  if (ext === '.zwo' || ext === '.xml') return parseZwo(text, name);
  if (ext === '.yaml' || ext === '.yml' || ext === '.json') return parseYamlWorkout(text, name);
  throw new Error(`Unsupported workout format "${ext}" — use .yaml or .zwo`);
}

export function parseDuration(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const clock = s.match(/^(?:(\d+):)?(\d+):(\d{2})$/);
  if (clock) return (Number(clock[1] ?? 0) * 3600) + Number(clock[2]) * 60 + Number(clock[3]);
  let total = 0, matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(h|min|m|sec|s)(?![a-z])/gi)) {
    matched = true;
    const n = Number(m[1]); const u = m[2].toLowerCase();
    total += u === 'h' ? n * 3600 : u.startsWith('m') ? n * 60 : n;
  }
  if (!matched) throw new Error(`Bad duration "${s}" (use 90s, 5m, 1h30m or 1:30)`);
  return total;
}

export function parsePower(v: unknown): Power {
  if (typeof v === 'number') return v <= 3 ? { ftp: v } : { watts: v };
  const s = String(v).trim();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return { ftp: Number(m[1]) / 100 };
  m = s.match(/^(\d+(?:\.\d+)?)\s*w$/i);
  if (m) return { watts: Number(m[1]) };
  throw new Error(`Bad power "${s}" (use 75% or 200W)`);
}

const KINDS = ['warmup', 'work', 'recovery', 'cooldown', 'steady', 'free'] as const;

export function parseYamlWorkout(text: string, fallbackName = 'workout'): Workout {
  const doc = YAML.parse(text);
  if (!doc || !Array.isArray(doc.steps)) throw new Error('Workout needs a "steps" list');
  const steps: Step[] = [];
  const walk = (items: any[], prefix: string) => {
    for (const item of items) {
      if (item.repeat !== undefined) {
        const n = Number(item.repeat);
        if (!Array.isArray(item.steps)) throw new Error('"repeat" needs nested "steps"');
        for (let r = 1; r <= n; r++) walk(item.steps, `${prefix}${r}/${n} `);
        continue;
      }
      const kind = KINDS.find((k) => k in item);
      if (!kind) throw new Error(`Unknown step: ${JSON.stringify(item)}`);
      const body = item[kind] ?? {};
      const durationS = parseDuration(body.duration);
      if (kind === 'free') {
        steps.push({ label: `${prefix}${body.label ?? 'free ride'}`, kind, durationS, from: { watts: 0 }, to: { watts: 0 } });
        continue;
      }
      const from = parsePower(body.from ?? body.power);
      const to = parsePower(body.to ?? body.power ?? body.from);
      steps.push({ label: `${prefix}${body.label ?? kind}`, kind, durationS, from, to, cadence: body.cadence });
    }
  };
  walk(doc.steps, '');
  return finalize({ name: doc.name ?? fallbackName, ftp: doc.ftp, description: doc.description, steps });
}

export function parseZwo(xml: string, fallbackName = 'workout'): Workout {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true });
  const tree = p.parse(xml) as any[];
  const root = tree.find((n) => n.workout_file)?.workout_file;
  if (!root) throw new Error('Not a Zwift .zwo file');
  const textOf = (tag: string) => root.find((n: any) => n[tag])?.[tag]?.[0]?.['#text'];
  const workoutNode = root.find((n: any) => n.workout)?.workout ?? [];
  const steps: Step[] = [];
  for (const node of workoutNode) {
    const tag = Object.keys(node).find((k) => k !== ':@');
    if (!tag) continue;
    const a = node[':@'] ?? {};
    const num = (k: string) => (a[k] !== undefined ? Number(a[k]) : undefined);
    const cad = num('Cadence');
    switch (tag) {
      case 'Warmup': case 'Cooldown': case 'Ramp': {
        const kind = tag === 'Warmup' ? 'warmup' : tag === 'Cooldown' ? 'cooldown' : 'steady';
        steps.push({ label: tag.toLowerCase(), kind, durationS: num('Duration')!, from: { ftp: num('PowerLow')! }, to: { ftp: num('PowerHigh')! }, cadence: cad });
        break;
      }
      case 'SteadyState':
        steps.push({ label: 'steady', kind: 'steady', durationS: num('Duration')!, from: { ftp: num('Power')! }, to: { ftp: num('Power')! }, cadence: cad });
        break;
      case 'IntervalsT': {
        const n = num('Repeat') ?? 1;
        for (let r = 1; r <= n; r++) {
          steps.push({ label: `${r}/${n} on`, kind: 'work', durationS: num('OnDuration')!, from: { ftp: num('OnPower')! }, to: { ftp: num('OnPower')! }, cadence: num('Cadence') });
          steps.push({ label: `${r}/${n} off`, kind: 'recovery', durationS: num('OffDuration')!, from: { ftp: num('OffPower')! }, to: { ftp: num('OffPower')! }, cadence: num('CadenceResting') });
        }
        break;
      }
      case 'FreeRide': case 'Freeride':
        steps.push({ label: 'free ride', kind: 'free', durationS: num('Duration')!, from: { watts: 0 }, to: { watts: 0 } });
        break;
      default: // textevent etc.
        break;
    }
  }
  return finalize({ name: textOf('name') ?? fallbackName, description: textOf('description'), steps });
}

function finalize(w: Omit<Workout, 'totalS'>): Workout {
  if (!w.steps.length) throw new Error('Workout has no steps');
  for (const s of w.steps) if (!(s.durationS > 0)) throw new Error(`Step "${s.label}" has no duration`);
  return { ...w, totalS: w.steps.reduce((a, s) => a + s.durationS, 0) };
}

export function resolvePower(p: Power, ftp: number): number {
  return 'watts' in p ? p.watts : p.ftp * ftp;
}

/** Target at elapsed time t (seconds since workout start). watts=null for free-ride steps. */
export function targetAt(w: Workout, t: number, ftp: number): WorkoutTarget {
  let start = 0;
  for (let i = 0; i < w.steps.length; i++) {
    const s = w.steps[i];
    if (t < start + s.durationS) {
      const el = t - start;
      const f = el / s.durationS;
      const watts = s.kind === 'free' ? null : Math.round(resolvePower(s.from, ftp) + (resolvePower(s.to, ftp) - resolvePower(s.from, ftp)) * f);
      return { step: s, index: i, stepElapsedS: el, stepRemainingS: s.durationS - el, watts, done: false };
    }
    start += s.durationS;
  }
  const last = w.steps[w.steps.length - 1];
  return { step: last, index: w.steps.length - 1, stepElapsedS: last.durationS, stepRemainingS: 0, watts: null, done: true };
}
