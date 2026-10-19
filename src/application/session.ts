import { EventEmitter } from 'node:events';
import { Recorder } from '../domain/activity.js';
import type { ModeSnapshot, Motion, RideContext, RideMode } from '../domain/modes/ride-mode.js';
import type { TrainerData } from '../domain/trainer-data.js';
import { AutoPause } from './auto-pause.js';
import type { Clock, Trainer } from './ports.js';
import { PowerStats } from './power-stats.js';
import { TrainerCommander } from './trainer-commander.js';

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
 * Mode-specific behaviour lives in the RideMode strategy; time comes from the Clock. Pause detection,
 * power figures and target throttling are delegated to AutoPause, PowerStats and TrainerCommander.
 * Emits 'snapshot' (Snapshot) and 'finished' (Recorder).
 */
export class Session extends EventEmitter {
  readonly recorder: Recorder;
  private latest: TrainerData = {};
  private latestAt = 0;
  private power = 0;
  private motion: Motion = { speedMs: 0, distanceM: 0 };
  private readonly stats = new PowerStats();
  private readonly autoPause = new AutoPause();
  private readonly commander: TrainerCommander;
  private manualPause = false;
  private finished = false;
  private cancelTick?: () => void;
  private logLines: string[] = [];
  private connected = true;

  constructor(private trainer: Trainer, private mode: RideMode, private clock: Clock, private opts: SessionOptions) {
    super();
    this.recorder = opts.recorder ?? new Recorder(mode.recordingKind, mode.title);
    this.commander = new TrainerCommander(trainer, clock, { crr: opts.crr, cw: opts.cw });
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
    this.commander.invalidate(); // force the new target out on the next tick
    this.emitSnapshot();
  }

  manualLap() { this.recorder.lap(this.now); this.log(`lap ${this.recorder.lapCount - 1}`); }

  private applyPause() {
    const paused = this.manualPause || this.autoPause.isActive;
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
      sendErg: (w) => this.commander.sendErg(w),
      sendGrade: (g) => this.commander.sendGrade(g),
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

    if (this.autoPause.update(power, cadence)) this.log(this.autoPause.isActive ? 'auto-paused' : 'auto-resumed');
    this.applyPause();

    const ctx = this.context();
    try {
      await this.mode.control(ctx);
    } catch (e: any) {
      this.log(`control: ${e.message}`);
    }

    const m = this.mode.advance(ctx, dt);
    this.motion = m;
    this.stats.add(power, ctx.recording);
    if (ctx.recording) {
      this.recorder.add({
        time: this.now, powerW: power, cadenceRpm: cadence, heartRateBpm: fresh ? this.latest.heartRateBpm : undefined,
        speedMs: m.speedMs, distanceM: m.distanceM, altitudeM: m.altitudeM, lat: m.lat, lon: m.lon,
      }, dt);
    }

    this.emitSnapshot();

    const reason = this.mode.finishReason(this.context());
    if (reason) { this.log(reason); this.stop(); }
  }

  private emitSnapshot() {
    const snap: Snapshot = {
      mode: this.mode.kind,
      title: this.recorder.name,
      trainerName: this.trainer.name,
      connected: this.connected,
      paused: this.manualPause,
      autoPaused: this.autoPause.isActive,
      finished: this.finished,
      elapsedS: this.recorder.timerSeconds,
      powerW: this.stats.latestW,
      power3sW: this.stats.avg3sW,
      cadenceRpm: Math.round(this.latest.cadenceRpm ?? 0),
      heartRateBpm: this.latest.heartRateBpm,
      speedKmh: this.motion.speedMs * 3.6,
      distanceM: this.motion.distanceM,
      avgPowerW: this.stats.averageW,
      lap: this.recorder.lapCount,
      log: this.logLines,
      ...this.mode.snapshot(this.context()),
    };
    this.emit('snapshot', snap);
  }
}
