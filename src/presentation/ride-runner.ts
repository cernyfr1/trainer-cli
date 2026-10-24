import { createInterface } from 'node:readline/promises';
import React from 'react';
import { render } from 'ink';
import type { Clock, Controller, Trainer } from '../application/ports.js';
import { RideFinisher, type SavedRide } from '../application/ride.js';
import { Session, type Snapshot } from '../application/session.js';
import type { Config } from '../domain/config.js';
import type { RideMode } from '../domain/modes/ride-mode.js';
import { RiderModel } from '../domain/physics.js';
import { FitFileStore } from '../infrastructure/activity-store.js';
import { RealClock, SimClock } from '../infrastructure/clock.js';
import type { ConfigFile } from '../infrastructure/config-file.js';
import type { StravaClient } from '../infrastructure/strava.js';
import type { BleScanner } from '../infrastructure/trainer/ble.js';
import { MockTrainer } from '../infrastructure/trainer/mock.js';
import { RideView, fmtTime } from './ui/RideView.js';

export interface RideOpts {
  mock?: boolean;
  trainer?: string;
  speedup?: string;
  tui: boolean;
  upload?: boolean;
  name?: string;
  ftp?: string;
  difficulty?: string;
  click: boolean;
}

/** Builds the ride mode once config, rider model and terminal width are known. */
export type ModeFactory = (cfg: Config, model: RiderModel, columns: number) => RideMode;

/** Runs one ride end to end: connect → ride (TUI or log lines) → save → optional Strava upload. */
export class RideRunner {
  constructor(private config: ConfigFile, private strava: StravaClient, private scanner: BleScanner) {}

  async run(makeMode: ModeFactory, o: RideOpts) {
    const cfg = await this.config.load();
    if (o.difficulty) cfg.difficulty = Number(o.difficulty) / 100;
    const speedup = Number(o.speedup ?? 1);
    const clock: Clock = o.mock ? new SimClock(speedup) : new RealClock();
    const trainer = await this.connectTrainer(o, cfg, clock);
    if (!o.mock && speedup !== 1) console.warn('--speedup is ignored with a real trainer');

    const tui = o.tui && process.stdout.isTTY && process.stdin.isTTY;
    const cols = Math.max(60, Math.min(120, (process.stdout.columns ?? 80) - 2));
    const model = RiderModel.fromConfig(cfg);
    const session = new Session(trainer, makeMode(cfg, model, cols), clock, { crr: model.crr, cw: model.cw });

    const controllers = this.connectControllers(session, cfg, o);
    await this.ride(session, tui);
    await Promise.all(controllers.map((c) => c.disconnect().catch(() => undefined)));
    await trainer.disconnect().catch(() => undefined);

    const finisher = new RideFinisher(new FitFileStore(this.config.activitiesDir), this.strava);
    const ride = await finisher.save(session);
    if (!ride) { console.log('Nothing recorded.'); process.exit(0); }
    console.log(`\n✔ ${fmtTime(ride.activity.timerS)} · ${(ride.distanceM / 1000).toFixed(2)} km · avg ${ride.avgPowerW} W`);
    console.log(`  saved ${ride.file}`);
    await this.maybeUpload(finisher, ride, o);
    process.exit(0);
  }

  private async connectTrainer(o: RideOpts, cfg: Config, clock: Clock): Promise<Trainer> {
    let trainer: Trainer;
    if (clock instanceof SimClock) trainer = new MockTrainer(clock, cfg.ftp * 0.8);
    else {
      const filter = o.trainer ?? cfg.trainerName;
      console.log(`Looking for trainer${filter ? ` "${filter}"` : ''}… (pedal to wake it)`);
      trainer = await this.scanner.find(filter);
    }
    await trainer.connect();
    return trainer;
  }

  /**
   * Zwift Click: scan in the background so ride start isn't delayed; the ride never depends on it.
   * Returns the (growing) list of remotes found, for disconnecting after the ride.
   */
  private connectControllers(session: Session, cfg: Config, o: RideOpts): Controller[] {
    const controllers: Controller[] = [];
    if (o.mock || !o.click) return controllers;
    this.scanner.findClicks(cfg.clickName, 20, (c) => {
      controllers.push(c);
      session.attachController(c);
      c.connect().catch((e: Error) => c.emit('log', `Zwift Click: ${e.message}`));
    }).catch((e: Error) => console.error(`Zwift Click scan: ${e.message}`));
    return controllers;
  }

  /** Start the session and resolve once it has finished and the UI is torn down. */
  private async ride(session: Session, tui: boolean) {
    const done = new Promise<void>((resolve) => session.once('finished', () => resolve()));
    let inkApp: ReturnType<typeof render> | undefined;
    if (tui) inkApp = render(React.createElement(RideView, { session, onExit: () => undefined }), { exitOnCtrlC: false });
    else {
      this.logSnapshots(session);
      process.once('SIGINT', () => session.stop());
    }
    session.start();
    await done;
    if (inkApp) { await new Promise((r) => setTimeout(r, 400)); inkApp.unmount(); }
  }

  /** Headless output: one line per 10 s of ride time. */
  private logSnapshots(session: Session) {
    let last = -1;
    session.on('snapshot', (s: Snapshot) => {
      const bucket = Math.floor(s.elapsedS / 10);
      if (bucket === last && !s.finished) return;
      last = bucket;
      const extra = s.mode === 'route' ? `grade ${(s.gradePct ?? 0).toFixed(1)}%  ${(s.distanceM / 1000).toFixed(2)}/${((s.routeTotalM ?? 0) / 1000).toFixed(2)} km`
        : s.mode === 'workout' ? `target ${s.targetW ?? (s.finished ? 'done' : 'free')} W  step ${s.workout!.target.index + 1}/${s.workout!.steps.length}`
        : `${(s.distanceM / 1000).toFixed(2)} km`;
      console.log(`${fmtTime(s.elapsedS).padStart(8)}  ${String(s.powerW).padStart(4)} W  ${String(s.cadenceRpm).padStart(3)} rpm  ${s.speedKmh.toFixed(1).padStart(5)} km/h  ${extra}${s.paused || s.autoPaused ? '  [paused]' : ''}`);
    });
  }

  private async maybeUpload(finisher: RideFinisher, ride: SavedRide, o: RideOpts) {
    let upload = o.upload;
    if (upload === undefined && process.stdin.isTTY && await finisher.canUpload()) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      upload = !/^n/i.test(await rl.question('Upload to Strava? [Y/n] '));
      rl.close();
    }
    if (!upload) return;
    try {
      const r = await finisher.upload(ride, o.name);
      console.log(`✔ Strava: ${r.url}`);
    } catch (e: any) {
      console.error(`✖ Strava upload failed: ${e.message}\n  retry: trainer strava upload "${ride.file}"`);
    }
  }
}
