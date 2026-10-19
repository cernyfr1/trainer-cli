import { EventEmitter } from 'node:events';
import { Recorder } from '../domain/activity.js';
import type { ModeSnapshot, Motion, RideContext, RideMode } from '../domain/modes/ride-mode.js';
import type { TrainerData } from '../domain/trainer-data.js';
import type { Clock, Trainer } from './ports.js';

export interface Snapshot extends ModeSnapshot {
  mode: RideMode['kind'];
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
  lap: number;
  log: string[];
}

export interface SessionOptions {
  crr: number;        // rolling resistance sent with simulation targets
  cw: number;         // wind resistance coefficient kg/m (0.5·ρ·CdA)
  recorder?: Recorder;
}

/**
 * The ride engine. 1 Hz tick: read trainer → mode decides target → command trainer → record → emit snapshot.
 * Mode-specific behaviour lives in the RideMode strategy; time comes from the Clock.
 * Emits 'snapshot' (Snapshot) and 'finished' (Recorder).
 */
export class Session extends EventEmitter {
  readonly recorder: Recorder;
  private latest: TrainerData = {};
  private latestAt = 0;
  private power = 0;
  private motion: Motion = { speedMs: 0, distanceM: 0 };
  private power3: number[] = [];
  private powerSum = 0;
  private powerN = 0;
  private manualPause = false;
  private autoPause = false;
  private zeroFor = 0;
  private finished = false;
  private cancelTick?: () => void;
  private lastSentGrade?: number;
  private lastSentGradeAt = 0;
  private lastSentErg?: number;
  private logLines: string[] = [];
  private connected = true;

  constructor(private trainer: Trainer, private mode: RideMode, private clock: Clock, private opts: SessionOptions) {
    super();
    this.recorder = opts.recorder ?? new Recorder(mode.recordingKind, mode.title);
    trainer.on('data', (d: TrainerData) => { this.latest = { ...this.latest, ...d }; this.latestAt = this.clock.now(); });
    trainer.on('log', (l: string) => this.log(l));
    trainer.on('disconnect', () => { this.connected = false; this.log('trainer disconnected'); });
  }

  start() {
    this.recorder.start(this.now);
    this.log(`started ${this.mode.kind}`);
    this.emitSnapshot();
    this.cancelTick = this.clock.every(1, (dt) => void this.tick(dt));
  }

  stop() {
    this.cancelTick?.();
    this.cancelTick = undefined;
    if (!this.finished) { this.finished = true; this.emitSnapshot(); this.emit('finished', this.recorder); }
  }

  get now() { return new Date(this.clock.now()); }

  togglePause() {
    this.manualPause = !this.manualPause;
    this.log(this.manualPause ? 'paused' : 'resumed');
    this.applyPause();
    this.emitSnapshot();
  }

  /** +/- key: meaning depends on the mode (difficulty, ERG offset, power or grade). */
  adjust(dir: 1 | -1) {
    const line = this.mode.adjust(dir);
    if (line) this.log(line);
    // force the new target out on the next tick
    this.lastSentGrade = undefined;
    this.lastSentErg = undefined;
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

  private context(): RideContext {
    return {
      powerW: this.power,
      trainerSpeedMs: (this.latest.speedKmh ?? 0) / 3.6,
      timerS: this.recorder.timerSeconds,
      recording: !this.recorder.isPaused,
      sendErg: (w) => this.sendErg(w),
      sendGrade: (g) => this.sendGrade(g),
      lap: (label) => this.recorder.lap(this.now, label),
      log: (l) => this.log(l),
    };
  }

  private async tick(dt: number) {
    if (this.finished) return;

    const fresh = this.clock.now() - this.latestAt < 3000;
    const power = fresh ? this.latest.powerW ?? 0 : 0;
    const cadence = fresh ? this.latest.cadenceRpm ?? 0 : 0;
    this.power = power;

    // auto-pause after 3 s of no pedalling
    this.zeroFor = power < 5 && cadence < 5 ? this.zeroFor + 1 : 0;
    const wasAuto = this.autoPause;
    this.autoPause = this.zeroFor >= 3;
    if (wasAuto !== this.autoPause) this.log(this.autoPause ? 'auto-paused' : 'auto-resumed');
    this.applyPause();

    const ctx = this.context();
    try {
      await this.mode.control(ctx);
    } catch (e: any) {
      this.log(`control: ${e.message}`);
    }

    const m = this.mode.advance(ctx, dt);
    this.motion = m;
    this.power3 = [...this.power3.slice(-2), power];
    if (ctx.recording) {
      this.powerSum += power; this.powerN++;
      this.recorder.add({
        time: this.now, powerW: power, cadenceRpm: cadence, heartRateBpm: fresh ? this.latest.heartRateBpm : undefined,
        speedMs: m.speedMs, distanceM: m.distanceM, altitudeM: m.altitudeM, lat: m.lat, lon: m.lon,
      }, dt);
    }

    this.emitSnapshot();

    const reason = this.mode.finishReason(this.context());
    if (reason) { this.log(reason); this.stop(); }
  }

  private async sendGrade(g: number) {
    const now = this.clock.now();
    const sent = Math.round(g * 10) / 10;
    if (this.lastSentGrade !== undefined && Math.abs(sent - this.lastSentGrade) < 0.1 && now - this.lastSentGradeAt < 5000) return;
    this.lastSentGrade = sent;
    this.lastSentGradeAt = now;
    this.lastSentErg = undefined;
    await this.trainer.setSimulation({ gradePct: sent, crr: this.opts.crr, cw: this.opts.cw });
  }

  private async sendErg(w: number) {
    w = Math.max(0, Math.round(w));
    if (this.lastSentErg !== undefined && Math.abs(w - this.lastSentErg) < 1) return;
    this.lastSentErg = w;
    this.lastSentGrade = undefined;
    await this.trainer.setErgPower(w);
  }

  private emitSnapshot() {
    const avg = this.powerN ? this.powerSum / this.powerN : 0;
    const snap: Snapshot = {
      mode: this.mode.kind,
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
      speedKmh: this.motion.speedMs * 3.6,
      distanceM: this.motion.distanceM,
      avgPowerW: Math.round(avg),
      lap: this.recorder.lapCount,
      log: this.logLines,
      ...this.mode.snapshot(this.context()),
    };
    this.emit('snapshot', snap);
  }
}
