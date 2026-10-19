import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Decoder, Stream } from '@garmin/fitsdk';
import { Session } from '../src/application/session.js';
import { DEFAULTS } from '../src/domain/config.js';
import { WorkoutMode } from '../src/domain/modes/workout-mode.js';
import { RiderModel } from '../src/domain/physics.js';
import { Duration, Power } from '../src/domain/workout.js';
import { SimClock } from '../src/infrastructure/clock.js';
import { FitEncoder } from '../src/infrastructure/fit-encoder.js';
import { cmd, decodeControlResponse, decodeFeatures, decodeIndoorBikeData, encodeIndoorBikeData } from '../src/infrastructure/ftms/codec.js';
import { GpxRouteParser } from '../src/infrastructure/route/gpx.js';
import { MockTrainer } from '../src/infrastructure/trainer/mock.js';
import { YamlWorkoutParser } from '../src/infrastructure/workout/yaml.js';
import { ZwoWorkoutParser } from '../src/infrastructure/workout/zwo.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('FTMS codec', () => {
  it('encodes control point commands byte-exact', () => {
    expect(hex(cmd.requestControl())).toBe('00');
    expect(hex(cmd.setTargetPower(250))).toBe('05fa00');
    // grade 5.5 % → 550 = 0x0226, crr 0.004 → 40 = 0x28, cw 0.51 → 51 = 0x33
    expect(hex(cmd.setSimulation(5.5, 0, 0.004, 0.51))).toBe('110000260228' + '33');
    // negative grade -3 % → -300 = 0xfed4
    expect(hex(cmd.setSimulation(-3)).slice(6, 10)).toBe('d4fe');
  });

  it('decodes a real-world Indoor Bike Data packet (speed, cadence, power, HR)', () => {
    // flags 0x0244: speed present (bit0=0), cadence(2), power(6), HR(9)
    const pkt = Uint8Array.from([0x44, 0x02, 0xc4, 0x09, 0xb0, 0x00, 0xc8, 0x00, 0x8c]);
    expect(decodeIndoorBikeData(pkt)).toEqual({ speedKmh: 25, cadenceRpm: 88, powerW: 200, heartRateBpm: 140 });
  });

  it('round-trips encode → decode', () => {
    const d = { speedKmh: 31.25, cadenceRpm: 92.5, totalDistanceM: 123456, powerW: 312, heartRateBpm: 151 };
    expect(decodeIndoorBikeData(encodeIndoorBikeData(d))).toEqual(d);
  });

  it('decodes control responses and features', () => {
    expect(decodeControlResponse(Uint8Array.of(0x80, 0x05, 0x01))).toMatchObject({ requestOp: 5, ok: true });
    expect(decodeControlResponse(Uint8Array.of(0x80, 0x11, 0x05))).toMatchObject({ ok: false, message: 'control not permitted' });
    const f = decodeFeatures(Uint8Array.from([0x86, 0x44, 0, 0, 0x08, 0x20, 0, 0]));
    expect(f).toMatchObject({ cadence: true, power: true, heartRate: true, targetPower: true, indoorBikeSimulation: true });
  });
});

describe('physics', () => {
  const m = new RiderModel(84, 0.32, 0.004);
  it('steadySpeed inverts powerForSpeed', () => {
    for (const g of [-4, 0, 3, 8]) {
      const v = m.steadySpeed(250, g);
      expect(m.powerForSpeed(v, g)).toBeCloseTo(250, 0);
    }
  });
  it('gives plausible speeds', () => {
    expect(m.steadySpeed(200, 0) * 3.6).toBeGreaterThan(30);
    expect(m.steadySpeed(200, 0) * 3.6).toBeLessThan(36);
    expect(m.steadySpeed(250, 8) * 3.6).toBeGreaterThan(9);
    expect(m.steadySpeed(250, 8) * 3.6).toBeLessThan(13);
  });
});

describe('routes', () => {
  it('parses GPX and computes smoothed grade', async () => {
    const r = new GpxRouteParser().parse(await readFile('examples/climb-loop.gpx'));
    expect(r.name).toBe('Synthetic climb loop');
    expect(r.totalDist).toBeGreaterThan(12000);
    const c = r.cursor();
    const climb = c.at(4500).gradePct;
    expect(climb).toBeGreaterThan(2);
    expect(c.at(10000).gradePct).toBeLessThan(-2);
    expect(c.profile(40)).toHaveLength(40);
  });

  it('handles rtept routes without elevation', () => {
    const r = new GpxRouteParser().parse(new TextEncoder().encode(`<gpx><rte><name>flat</name><rtept lat="50" lon="14"/><rtept lat="50.01" lon="14"/></rte></gpx>`));
    expect(r.totalDist).toBeCloseTo(1112, -1);
    expect(r.cursor().at(500).gradePct).toBe(0);
  });
});

describe('workouts', () => {
  it('parses durations and powers', () => {
    expect(Duration.parse('1h30m').seconds).toBe(5400);
    expect(Duration.parse('1:30').seconds).toBe(90);
    expect(Duration.parse(45).seconds).toBe(45);
    expect(Power.parse('105%')).toEqual(Power.ftp(1.05));
    expect(Power.parse('180W')).toEqual(Power.watts(180));
    expect(Power.parse(0.6)).toEqual(Power.ftp(0.6));
    expect(Power.parse('50%').resolve(250)).toBe(125);
  });

  it('expands repeats and resolves ramps', async () => {
    const w = new YamlWorkoutParser().parse(await readFile('examples/threshold-4x8.yaml', 'utf8'));
    expect(w.steps).toHaveLength(2 + 8 + 2);
    expect(w.totalS).toBe((10 + 3 + 4 * 12 + 3 + 8) * 60);
    expect(w.targetAt(0, 200).watts).toBe(100);
    expect(w.targetAt(300, 200).watts).toBe(125); // halfway up the warm-up ramp
    expect(w.targetAt(14 * 60, 200).watts).toBe(200);
    expect(w.targetAt(62 * 60, 200).watts).toBeNull(); // free step
    expect(w.targetAt(w.totalS, 200).done).toBe(true);
  });

  it('parses Zwift .zwo', async () => {
    const w = new ZwoWorkoutParser().parse(await readFile('examples/vo2-30-30.zwo', 'utf8'));
    expect(w.name).toBe('VO2 30/30 x 2 sets');
    expect(w.steps).toHaveLength(1 + 20 + 1 + 20 + 1);
    expect(w.targetAt(605, 250).watts).toBe(300);
    expect(w.targetAt(635, 250).watts).toBe(125);
  });
});

describe('session (mock, accelerated)', () => {
  it('rides a workout to completion and writes a valid FIT with one lap per step', async () => {
    const w = new YamlWorkoutParser().parse(`name: t\nsteps:\n  - warmup: { duration: 60s, from: 50%, to: 70% }\n  - repeat: 2\n    steps:\n      - work: { duration: 30s, power: 120% }\n      - recovery: { duration: 30s, power: 50% }\n`);
    const clock = new SimClock(2000);
    const trainer = new MockTrainer(clock, 180);
    await trainer.connect();
    const s = new Session(trainer, new WorkoutMode(w, 200), clock, { crr: DEFAULTS.crr, cw: 0.5 * 1.225 * DEFAULTS.cda });
    const done = new Promise((r) => s.once('finished', r));
    s.start();
    await done;
    await trainer.disconnect();
    const fit = new FitEncoder().encode(s.recorder.finish(s.now));
    const dec = new Decoder(Stream.fromByteArray(Array.from(fit)));
    expect(dec.checkIntegrity()).toBe(true);
    const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(fit))).read();
    expect(errors).toEqual([]);
    expect(messages.lapMesgs).toHaveLength(5);
    expect(messages.sessionMesgs[0].subSport).toBe('indoorCycling');
    expect(messages.recordMesgs.length).toBeGreaterThanOrEqual(175);
    const work = messages.lapMesgs[1];
    expect(work.avgPower).toBeGreaterThan(200);
  }, 20_000);
});
