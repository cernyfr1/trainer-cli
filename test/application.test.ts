import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AutoPause } from '../src/application/auto-pause.js';
import type { Clock, Trainer } from '../src/application/ports.js';
import { PowerStats } from '../src/application/power-stats.js';
import { Session } from '../src/application/session.js';
import { TrainerCommander } from '../src/application/trainer-commander.js';
import { WorkoutMode } from '../src/domain/modes/workout-mode.js';
import type { SimParams } from '../src/domain/trainer-data.js';
import { Power, Workout } from '../src/domain/workout.js';
import { SimClock } from '../src/infrastructure/clock.js';
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

describe('Session timing', () => {
  const workout = new Workout({ name: 'w', steps: [{ label: 'a', kind: 'steady', durationS: 30, from: Power.watts(180), to: Power.watts(180) }] });

  it('sends the first target as soon as it starts', async () => {
    const trainer = new FakeTrainer();
    const s = new Session(trainer, new WorkoutMode(workout, 200), new ManualClock(), { crr: 0.004, cw: 0.2 });
    s.start();
    await Promise.resolve();
    expect(trainer.sent).toEqual(['erg 180']);
    s.stop();
  });

  it('freezes ride time at stop, even while a simulated device keeps the clock stepping', async () => {
    const clock = new SimClock(1000);
    const keepAlive = clock.every(1, () => undefined); // stands in for anything still running after the ride
    const trainer = new FakeTrainer();
    const s = new Session(trainer, new WorkoutMode(workout, 200), clock, { crr: 0.004, cw: 0.2 });
    s.start();
    for (let i = 0; i < 5; i++) trainer.emit('data', { powerW: 180, cadenceRpm: 85 });
    await new Promise((r) => setTimeout(r, 20));
    s.stop();
    const stoppedAt = s.now.getTime();
    await new Promise((r) => setTimeout(r, 30)); // ~30 more simulated seconds
    keepAlive();
    expect(clock.now()).toBeGreaterThan(stoppedAt);
    expect(s.now.getTime()).toBe(stoppedAt);
  });
});

describe('SimClock', () => {
  it('runs device step hooks before timers, whatever the registration order', async () => {
    const clock = new SimClock(1000);
    const order: string[] = [];
    const cancelTimer = clock.every(1, () => order.push('session'));
    const cancelHook = clock.onStep(() => order.push('device'));
    await new Promise((r) => setTimeout(r, 10));
    cancelTimer(); cancelHook();
    expect(order.slice(0, 4)).toEqual(['device', 'session', 'device', 'session']);
  });

  it('does not advance time while no timer is registered', async () => {
    const clock = new SimClock(1000, 0);
    clock.onStep(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(clock.now()).toBe(0);
  });
});
