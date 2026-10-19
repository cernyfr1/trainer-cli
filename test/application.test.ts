import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AutoPause } from '../src/application/auto-pause.js';
import type { Clock, Trainer } from '../src/application/ports.js';
import { PowerStats } from '../src/application/power-stats.js';
import { TrainerCommander } from '../src/application/trainer-commander.js';
import type { SimParams } from '../src/domain/trainer-data.js';
import { RouteLoader } from '../src/infrastructure/route/loader.js';
import { WorkoutLoader } from '../src/infrastructure/workout/loader.js';

class FakeTrainer extends EventEmitter implements Trainer {
  readonly name = 'fake';
  readonly sent: string[] = [];
  async connect() {}
  async disconnect() {}
  async setErgPower(w: number) { this.sent.push(`erg ${w}`); }
  async setSimulation(p: SimParams) { this.sent.push(`grade ${p.gradePct}`); }
}

class ManualClock implements Clock {
  t = 0;
  now() { return this.t; }
  every() { return () => undefined; }
}

describe('TrainerCommander', () => {
  const setup = () => {
    const trainer = new FakeTrainer();
    const clock = new ManualClock();
    return { trainer, clock, cmd: new TrainerCommander(trainer, clock, { crr: 0.004, cw: 0.2 }) };
  };

  it('sends ERG only when it changes by at least 1 W', async () => {
    const { trainer, cmd } = setup();
    await cmd.sendErg(200); await cmd.sendErg(200.4); await cmd.sendErg(201);
    expect(trainer.sent).toEqual(['erg 200', 'erg 201']);
  });

  it('sends grade on ≥ 0.1 % change or every 5 s, and after invalidate()', async () => {
    const { trainer, clock, cmd } = setup();
    await cmd.sendGrade(3.02); await cmd.sendGrade(3.04);
    clock.t = 4999; await cmd.sendGrade(3);
    clock.t = 5000; await cmd.sendGrade(3);
    await cmd.sendGrade(3.1);
    cmd.invalidate(); await cmd.sendGrade(3.1);
    expect(trainer.sent).toEqual(['grade 3', 'grade 3', 'grade 3.1', 'grade 3.1']);
  });

  it('switching between ERG and grade always sends', async () => {
    const { trainer, cmd } = setup();
    await cmd.sendErg(150); await cmd.sendGrade(0); await cmd.sendErg(150);
    expect(trainer.sent).toEqual(['erg 150', 'grade 0', 'erg 150']);
  });
});

describe('AutoPause', () => {
  it('pauses after 3 quiet seconds and resumes on the first pedal stroke', () => {
    const ap = new AutoPause();
    expect([ap.update(0, 0), ap.update(0, 0), ap.update(0, 0)]).toEqual([false, false, true]);
    expect(ap.isActive).toBe(true);
    expect(ap.update(0, 0)).toBe(false);
    expect(ap.update(150, 80)).toBe(true);
    expect(ap.isActive).toBe(false);
  });
});

describe('PowerStats', () => {
  it('keeps a 3 s window and averages only recorded seconds', () => {
    const p = new PowerStats();
    p.add(100, true); p.add(200, true); p.add(300, false); p.add(400, true);
    expect(p.latestW).toBe(400);
    expect(p.avg3sW).toBe(300);
    expect(p.averageW).toBe(Math.round(700 / 3));
  });
});

describe('loaders', () => {
  it('pick a parser by extension', async () => {
    expect((await new RouteLoader().load('examples/climb-loop.gpx')).name).toBe('Synthetic climb loop');
    expect((await new WorkoutLoader().load('examples/vo2-30-30.zwo')).name).toBe('VO2 30/30 x 2 sets');
  });

  it('name the supported formats when the extension is unknown', async () => {
    await expect(new RouteLoader().load('x.tcx')).rejects.toThrow('Unsupported route format ".tcx" — use .gpx or .fit');
    await expect(new WorkoutLoader().load('x.erg')).rejects.toThrow('Unsupported workout format ".erg" — use .yaml or .zwo');
  });
});
