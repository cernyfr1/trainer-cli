/** Power target: fraction of FTP (0.75) or absolute watts. */
export class Power {
  private constructor(readonly unit: 'ftp' | 'watts', readonly value: number) {}

  static ftp(fraction: number) { return new Power('ftp', fraction); }
  static watts(w: number) { return new Power('watts', w); }

  /** "75%", "200W", or a bare number (≤ 3 → FTP fraction, else watts). */
  static parse(v: unknown): Power {
    if (typeof v === 'number') return v <= 3 ? Power.ftp(v) : Power.watts(v);
    const s = String(v).trim();
    let m = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (m) return Power.ftp(Number(m[1]) / 100);
    m = s.match(/^(\d+(?:\.\d+)?)\s*w$/i);
    if (m) return Power.watts(Number(m[1]));
    throw new Error(`Bad power "${s}" (use 75% or 200W)`);
  }

  resolve(ftp: number): number { return this.unit === 'watts' ? this.value : this.value * ftp; }
}

export class Duration {
  private constructor(readonly seconds: number) {}

  /** "90s", "5m", "1h30m", "1:30", "1:02:03", or a number of seconds. */
  static parse(v: unknown): Duration {
    if (typeof v === 'number') return new Duration(v);
    const s = String(v).trim();
    const clock = s.match(/^(?:(\d+):)?(\d+):(\d{2})$/);
    if (clock) return new Duration((Number(clock[1] ?? 0) * 3600) + Number(clock[2]) * 60 + Number(clock[3]));
    let total = 0, matched = false;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(h|min|m|sec|s)(?![a-z])/gi)) {
      matched = true;
      const n = Number(m[1]); const u = m[2].toLowerCase();
      total += u === 'h' ? n * 3600 : u.startsWith('m') ? n * 60 : n;
    }
    if (!matched) throw new Error(`Bad duration "${s}" (use 90s, 5m, 1h30m or 1:30)`);
    return new Duration(total);
  }
}

export const STEP_KINDS = ['warmup', 'work', 'recovery', 'cooldown', 'steady', 'free'] as const;

export interface Step {
  label: string;
  kind: typeof STEP_KINDS[number];
  durationS: number;
  from: Power;       // start of step
  to: Power;         // end of step (== from for steady)
  cadence?: number;
}

export interface WorkoutTarget { step: Step; index: number; stepElapsedS: number; stepRemainingS: number; watts: number | null; done: boolean }

export class Workout {
  readonly name: string;
  readonly ftp?: number;
  readonly description?: string;
  readonly steps: readonly Step[];
  readonly totalS: number;

  constructor(init: { name: string; ftp?: number; description?: string; steps: Step[] }) {
    if (!init.steps.length) throw new Error('Workout has no steps');
    for (const s of init.steps) if (!(s.durationS > 0)) throw new Error(`Step "${s.label}" has no duration`);
    this.name = init.name;
    this.ftp = init.ftp;
    this.description = init.description;
    this.steps = init.steps;
    this.totalS = init.steps.reduce((a, s) => a + s.durationS, 0);
  }

  /** Target at elapsed time t (seconds since workout start). watts=null for free-ride steps. */
  targetAt(t: number, ftp: number): WorkoutTarget {
    let start = 0;
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      if (t < start + s.durationS) {
        const el = t - start;
        const f = el / s.durationS;
        const from = s.from.resolve(ftp), to = s.to.resolve(ftp);
        const watts = s.kind === 'free' ? null : Math.round(from + (to - from) * f);
        return { step: s, index: i, stepElapsedS: el, stepRemainingS: s.durationS - el, watts, done: false };
      }
      start += s.durationS;
    }
    const last = this.steps[this.steps.length - 1];
    return { step: last, index: this.steps.length - 1, stepElapsedS: last.durationS, stepRemainingS: 0, watts: null, done: true };
  }
}
