/** Power target: fraction of FTP (0.75) or absolute watts. */
export type Power = { ftp: number } | { watts: number };

export interface Step {
  label: string;
  kind: typeof STEP_KINDS[number];
  durationS: number;
  from: Power;       // start of step
  to: Power;         // end of step (== from for steady)
  cadence?: number;
}

export interface Workout { name: string; ftp?: number; description?: string; steps: Step[]; totalS: number }

export interface WorkoutTarget { step: Step; index: number; stepElapsedS: number; stepRemainingS: number; watts: number | null; done: boolean }

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

export const STEP_KINDS = ['warmup', 'work', 'recovery', 'cooldown', 'steady', 'free'] as const;

/** Validate steps and compute total duration. */
export function buildWorkout(w: Omit<Workout, 'totalS'>): Workout {
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
