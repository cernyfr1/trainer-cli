import { EventEmitter } from 'node:events';
import { clamp, type IndoorBikeData } from './ftms/codec.js';
import { stepSpeed, type RiderModel } from './physics.js';
import { Recorder } from './recorder.js';
import { RouteCursor, type Route } from './route/route.js';
import type { Trainer } from './trainer/types.js';
import { targetAt, type Workout, type WorkoutTarget } from './workout/workout.js';
import type { Config } from './config.js';

export type Mode =
  | { kind: 'route'; route: Route }
  | { kind: 'workout'; workout: Workout; ftp: number }
  | { kind: 'free'; ergW?: number; gradePct?: number };

export interface Snapshot {
  mode: Mode['kind'];
  title: string;
  trainerName: string;
  connected: boolean;
  paused: boolean;
  autoPaused: boolean;
  finished: boolean;
  elapsedS: number;     // timer time (excl. pauses)
  powerW: number;
  power3sW: number;
  cadenceRpm: number;
  heartRateBpm?: number;
  speedKmh: number;
  distanceM: number;
  avgPowerW: number;
  // route
  gradePct?: number;      // actual road grade
  sentGradePct?: number;  // after clamp × difficulty
  altitudeM?: number;
  ascentM?: number;
  routeTotalM?: number;
  profile?: number[];
  difficulty: number;
  // workout / erg
  targetW?: number | null;
  ergOffsetW: number;
  workout?: { name: string; totalS: number; elapsedS: number; target: WorkoutTarget; steps: { label: string; durationS: number; kind: string }[] };
  lap: number;
  log: string[];
}

export interface SessionOptions {
  speedup?: number;  // mock only
  profileColumns?: number;
}

/**
 * The ride engine. 1 Hz tick: read trainer → decide target → command trainer → record → emit snapshot.
 * Emits 'snapshot' (Snapshot) and 'finished' (Recorder).
 */
export class Session extends EventEmitter {
  readonly recorder: Recorder;
  private latest: IndoorBikeData = {};
  private latestAt = 0;
  private v = 0;              // virtual speed m/s (route mode)
  private dist = 0;           // virtual distance m
  private ascent = 0;
  private lastAlt?: number;
  private power3: number[] = [];
  private powerSum = 0;
  private powerN = 0;
  private manualPause = false;
  private autoPause = false;
  private zeroFor = 0;
  private finished = false;
  private simClock: number;
  private timer?: NodeJS.Timeout;
  private lastSentGrade?: number;
  private lastSentGradeAt = 0;
  private lastSentErg?: number;
  private lastStepIdx = -1;
  private difficulty: number;
  private ergOffset = 0;
  private cursor?: RouteCursor;
  private profile?: number[];
  private logLines: string[] = [];
  private connected = true;
  private freeErg?: number;
  private freeGrade?: number;
  private model: RiderModel;

  constructor(private trainer: Trainer, private mode: Mode, private cfg: Config, private opts: SessionOptions = {}) {
    super();
    this.simClock = Date.now();
    this.difficulty = cfg.difficulty;
    this.model = { massKg: cfg.riderMassKg + cfg.bikeMassKg, cda: cfg.cda, crr: cfg.crr };
    const title = mode.kind === 'route' ? mode.route.name : mode.kind === 'workout' ? mode.workout.name : 'free ride';
    this.recorder = new Recorder(mode.kind === 'route' ? 'virtual' : 'indoor', title);
    if (mode.kind === 'route') {
      this.cursor = new RouteCursor(mode.route);
      this.profile = this.cursor.profile(opts.profileColumns ?? 60);
    }
    if (mode.kind === 'free') {
      this.freeErg = mode.ergW;
      this.freeGrade = mode.ergW === undefined ? (mode.gradePct ?? 0) : undefined;
    }
    trainer.on('data', (d: IndoorBikeData) => { this.latest = { ...this.latest, ...d }; this.latestAt = Date.now(); });
    trainer.on('log', (l: string) => this.log(l));
    trainer.on('disconnect', () => { this.connected = false; this.log('trainer disconnected'); });
  }

  private get speedup() { return this.trainer.tick ? (this.opts.speedup ?? 1) : 1; }

  start() {
    this.recorder.start(new Date(this.simClock));
    this.log(`started ${this.mode.kind}`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1000 / this.speedup);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.finished) { this.finished = true; this.emitSnapshot(); this.emit('finished', this.recorder); }
  }

  get now() { return new Date(this.simClock); }

  togglePause() {
    this.manualPause = !this.manualPause;
    this.log(this.manualPause ? 'paused' : 'resumed');
    this.applyPause();
    this.emitSnapshot();
  }

  /** +/- key: difficulty in route, ERG offset in workout / free-ERG, grade in free-sim. */
  adjust(dir: 1 | -1) {
    if (this.mode.kind === 'route') {
      this.difficulty = clamp(Math.round((this.difficulty + dir * 0.1) * 10) / 10, 0, 2);
      this.lastSentGrade = undefined; // force resend
      this.log(`difficulty ${Math.round(this.difficulty * 100)} %`);
    } else if (this.mode.kind === 'workout' || this.freeErg !== undefined) {
      if (this.freeErg !== undefined) this.freeErg = Math.max(0, this.freeErg + dir * 5);
      else this.ergOffset += dir * 5;
      this.lastSentErg = undefined;
    } else {
      this.freeGrade = clamp((this.freeGrade ?? 0) + dir * 0.5, this.cfg.minGrade, this.cfg.maxGrade);
      this.lastSentGrade = undefined;
    }
    this.emitSnapshot();
  }

  manualLap() { this.recorder.lap(this.now); this.log(`lap ${this.recorder.lapCount - 1}`); }

  private applyPause() {
    const paused = this.manualPause || this.autoPause;
    if (paused && !this.recorder.isPaused) this.recorder.pause(this.now);
    else if (!paused && this.recorder.isPaused) this.recorder.start(this.now);
  }

  private log(s: string) {
    const t = new Date().toTimeString().slice(0, 8);
    this.logLines = [...this.logLines.slice(-4), `${t} ${s}`];
  }

  private async tick() {
    if (this.finished) return;
    const dt = 1;
    this.simClock += dt * 1000;
    this.trainer.tick?.(dt);

    const fresh = this.trainer.tick ? true : Date.now() - this.latestAt < 3000;
    const power = fresh ? this.latest.powerW ?? 0 : 0;
    const cadence = fresh ? this.latest.cadenceRpm ?? 0 : 0;

    // auto-pause after 3 s of no pedalling
    this.zeroFor = power < 5 && cadence < 5 ? this.zeroFor + 1 : 0;
    const wasAuto = this.autoPause;
    this.autoPause = this.zeroFor >= 3;
    if (wasAuto !== this.autoPause) this.log(this.autoPause ? 'auto-paused' : 'auto-resumed');
    this.applyPause();
    const recording = !this.recorder.isPaused;

    try {
      await this.control(recording);
    } catch (e: any) {
      this.log(`control: ${e.message}`);
    }

    // distance / speed
    let speedMs: number;
    let altitude: number | undefined, lat: number | undefined, lon: number | undefined;
    if (this.mode.kind === 'route' && this.cursor) {
      const here = this.cursor.at(this.dist);
      this.v = stepSpeed(this.v, recording ? power : 0, here.gradePct, this.model, dt);
      if (recording) this.dist = Math.min(this.dist + this.v * dt, this.mode.route.totalDist);
      const p = this.cursor.at(this.dist);
      altitude = p.ele; lat = p.lat; lon = p.lon;
      speedMs = this.v;
    } else {
      speedMs = (this.latest.speedKmh ?? 0) / 3.6;
      if (recording) this.dist += speedMs * dt;
    }
    if (altitude !== undefined) {
      if (this.lastAlt !== undefined && recording) this.ascent += Math.max(0, altitude - this.lastAlt);
      this.lastAlt = altitude;
    }

    this.power3 = [...this.power3.slice(-2), power];
    if (recording) {
      this.powerSum += power; this.powerN++;
      this.recorder.add({
        time: this.now, powerW: power, cadenceRpm: cadence, heartRateBpm: fresh ? this.latest.heartRateBpm : undefined,
        speedMs, distanceM: this.dist, altitudeM: altitude, lat, lon,
      }, dt);
    }

    this.emitSnapshot();

    // end conditions
    if (this.mode.kind === 'route' && this.dist >= this.mode.route.totalDist) { this.log('route finished'); this.stop(); }
    if (this.mode.kind === 'workout' && targetAt(this.mode.workout, this.recorder.timerSeconds, this.mode.ftp).done) {
      this.log('workout finished'); this.stop();
    }
  }

  private currentTarget(): WorkoutTarget | undefined {
    return this.mode.kind === 'workout' ? targetAt(this.mode.workout, this.recorder.timerSeconds, this.mode.ftp) : undefined;
  }

  private async sendGrade(g: number, force = false) {
    const now = Date.now();
    const sent = Math.round(g * 10) / 10;
    if (!force && this.lastSentGrade !== undefined && Math.abs(sent - this.lastSentGrade) < 0.1 && now - this.lastSentGradeAt < 5000 / this.speedup) return;
    this.lastSentGrade = sent;
    this.lastSentGradeAt = now;
    this.lastSentErg = undefined;
    await this.trainer.setSimulation({ gradePct: sent, crr: this.cfg.crr, cw: 0.5 * 1.225 * this.cfg.cda });
  }

  private async sendErg(w: number) {
    w = Math.max(0, Math.round(w));
    if (this.lastSentErg !== undefined && Math.abs(w - this.lastSentErg) < 1) return;
    this.lastSentErg = w;
    this.lastSentGrade = undefined;
    await this.trainer.setErgPower(w);
  }

  private sentGrade(): number | undefined {
    if (this.mode.kind === 'route' && this.cursor) {
      const g = this.cursor.at(this.dist).gradePct;
      return clamp(g, this.cfg.minGrade, this.cfg.maxGrade) * this.difficulty;
    }
    if (this.mode.kind === 'free' && this.freeGrade !== undefined) return this.freeGrade;
    const t = this.currentTarget();
    if (t && t.watts === null) return 0;
    return undefined;
  }

  private async control(recording: boolean) {
    if (this.mode.kind === 'workout') {
      const t = this.currentTarget()!;
      if (t.index !== this.lastStepIdx) {
        if (this.lastStepIdx >= 0) this.recorder.lap(this.now, t.step.label);
        this.lastStepIdx = t.index;
        this.log(`step ${t.index + 1}/${this.mode.workout.steps.length}: ${t.step.label}`);
      }
      if (t.watts === null) return this.sendGrade(0);
      // while paused in ERG, drop to a low load so restarting isn't a wall
      return this.sendErg(recording ? t.watts + this.ergOffset : Math.min(100, t.watts));
    }
    if (this.mode.kind === 'free' && this.freeErg !== undefined) return this.sendErg(this.freeErg);
    const g = this.sentGrade();
    if (g !== undefined) return this.sendGrade(g);
  }

  private emitSnapshot() {
    const m = this.mode;
    const t = this.currentTarget();
    const avg = this.powerN ? this.powerSum / this.powerN : 0;
    const snap: Snapshot = {
      mode: m.kind,
      title: this.recorder.name,
      trainerName: this.trainer.name,
      connected: this.connected,
      paused: this.manualPause,
      autoPaused: this.autoPause,
      finished: this.finished,
      elapsedS: this.recorder.timerSeconds,
      powerW: Math.round(this.power3[this.power3.length - 1] ?? 0),
      power3sW: Math.round(this.power3.reduce((a, b) => a + b, 0) / Math.max(1, this.power3.length)),
      cadenceRpm: Math.round(this.latest.cadenceRpm ?? 0),
      heartRateBpm: this.latest.heartRateBpm,
      speedKmh: (m.kind === 'route' ? this.v * 3.6 : this.latest.speedKmh ?? 0),
      distanceM: this.dist,
      avgPowerW: Math.round(avg),
      difficulty: this.difficulty,
      ergOffsetW: this.ergOffset,
      lap: this.recorder.lapCount,
      log: this.logLines,
    };
    if (m.kind === 'route' && this.cursor) {
      const here = this.cursor.at(this.dist);
      Object.assign(snap, {
        gradePct: here.gradePct, sentGradePct: this.sentGrade(), altitudeM: here.ele, ascentM: this.ascent,
        routeTotalM: m.route.totalDist, profile: this.profile,
      });
    }
    if (m.kind === 'workout' && t) {
      snap.targetW = t.watts === null ? null : t.watts + this.ergOffset;
      snap.workout = {
        name: m.workout.name, totalS: m.workout.totalS, elapsedS: this.recorder.timerSeconds, target: t,
        steps: m.workout.steps.map((s) => ({ label: s.label, durationS: s.durationS, kind: s.kind })),
      };
    }
    if (m.kind === 'free') {
      snap.targetW = this.freeErg;
      snap.sentGradePct = this.freeGrade;
    }
    this.emit('snapshot', snap);
  }
}
