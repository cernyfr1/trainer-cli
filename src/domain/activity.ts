export interface Sample {
  time: Date;
  powerW?: number;
  cadenceRpm?: number;
  heartRateBpm?: number;
  speedMs?: number;
  distanceM: number;
  altitudeM?: number;
  lat?: number;
  lon?: number;
}

export interface Lap { startIdx: number; endIdx: number; start: Date; end: Date; timerS: number; label?: string }

export interface TimerEvent { time: Date; type: 'start' | 'stopAll' }

export type ActivityKind = 'virtual' | 'indoor';

/** A closed recording, ready to be encoded into a file format. */
export interface FinishedActivity {
  readonly kind: ActivityKind;
  readonly name: string;
  readonly samples: readonly Sample[];
  readonly laps: readonly Lap[];
  readonly events: readonly TimerEvent[];
  readonly timerS: number;
  readonly endedAt: Date;
}

/** Collects 1 Hz samples, laps and timer pauses. */
export class Recorder {
  readonly samples: Sample[] = [];
  private laps: Lap[] = [];
  private lapStart?: { idx: number; time: Date; timerS: number; label?: string };
  private timerS = 0;
  private events: TimerEvent[] = [];
  private paused = true;

  constructor(readonly kind: ActivityKind, readonly name: string) {}

  start(now: Date) {
    this.events.push({ time: now, type: 'start' });
    this.paused = false;
    this.lapStart ??= { idx: 0, time: now, timerS: 0 };
  }

  pause(now: Date) {
    if (this.paused) return;
    this.events.push({ time: now, type: 'stopAll' });
    this.paused = true;
  }

  get isPaused() { return this.paused; }
  get timerSeconds() { return this.timerS; }
  get lapCount() { return this.laps.length + 1; }

  add(s: Sample, dtS: number) {
    if (this.paused) return;
    this.samples.push(s);
    this.timerS += dtS;
  }

  lap(now: Date, nextLabel?: string) {
    if (!this.lapStart || this.samples.length === this.lapStart.idx) {
      if (this.lapStart) this.lapStart.label = nextLabel;
      return;
    }
    this.laps.push({ startIdx: this.lapStart.idx, endIdx: this.samples.length, start: this.lapStart.time, end: now, timerS: this.timerS - this.lapStart.timerS, label: this.lapStart.label });
    this.lapStart = { idx: this.samples.length, time: now, timerS: this.timerS, label: nextLabel };
  }

  /** Stop the timer, close the current lap and hand out the result. */
  finish(now: Date): FinishedActivity {
    if (!this.samples.length) throw new Error('Nothing recorded');
    this.pause(now);
    this.lap(now);
    return {
      kind: this.kind, name: this.name, samples: [...this.samples], laps: [...this.laps],
      events: [...this.events], timerS: this.timerS, endedAt: now,
    };
  }
}
