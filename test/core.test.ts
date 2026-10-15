import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Decoder, Stream } from '@garmin/fitsdk';
import { cmd, decodeControlResponse, decodeFeatures, decodeIndoorBikeData, encodeIndoorBikeData } from '../src/ftms/codec.js';
import { powerForSpeed, steadySpeed } from '../src/physics.js';
import { parseGpx, RouteCursor } from '../src/route/route.js';
import { parseDuration, parsePower, parseYamlWorkout, parseZwo, targetAt } from '../src/workout/workout.js';
import { MockTrainer } from '../src/trainer/mock.js';
import { Session } from '../src/session.js';
import { DEFAULTS } from '../src/config.js';

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
  const m = { massKg: 84, cda: 0.32, crr: 0.004 };
  it('steadySpeed inverts powerForSpeed', () => {
    for (const g of [-4, 0, 3, 8]) {
      const v = steadySpeed(250, g, m);
      expect(powerForSpeed(v, g, m)).toBeCloseTo(250, 0);
    }
  });
  it('gives plausible speeds', () => {
    expect(steadySpeed(200, 0, m) * 3.6).toBeGreaterThan(30);
    expect(steadySpeed(200, 0, m) * 3.6).toBeLessThan(36);
    expect(steadySpeed(250, 8, m) * 3.6).toBeGreaterThan(9);
    expect(steadySpeed(250, 8, m) * 3.6).toBeLessThan(13);
  });
});

describe('routes', () => {
  it('parses GPX and computes smoothed grade', async () => {
    const r = parseGpx(await readFile('examples/climb-loop.gpx', 'utf8'));
    expect(r.name).toBe('Synthetic climb loop');
    expect(r.totalDist).toBeGreaterThan(12000);
    const c = new RouteCursor(r);
    const climb = c.at(4500).gradePct;
    expect(climb).toBeGreaterThan(2);
    expect(c.at(10000).gradePct).toBeLessThan(-2);
    expect(c.profile(40)).toHaveLength(40);
  });

  it('handles rtept routes without elevation', () => {
    const r = parseGpx(`<gpx><rte><name>flat</name><rtept lat="50" lon="14"/><rtept lat="50.01" lon="14"/></rte></gpx>`);
    expect(r.totalDist).toBeCloseTo(1112, -1);
    expect(new RouteCursor(r).at(500).gradePct).toBe(0);
  });
});

describe('workouts', () => {
  it('parses durations and powers', () => {
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration(45)).toBe(45);
    expect(parsePower('105%')).toEqual({ ftp: 1.05 });
    expect(parsePower('180W')).toEqual({ watts: 180 });
    expect(parsePower(0.6)).toEqual({ ftp: 0.6 });
  });

  it('expands repeats and resolves ramps', async () => {
    const w = parseYamlWorkout(await readFile('examples/threshold-4x8.yaml', 'utf8'));
    expect(w.steps).toHaveLength(2 + 8 + 2);
    expect(w.totalS).toBe((10 + 3 + 4 * 12 + 3 + 8) * 60);
    expect(targetAt(w, 0, 200).watts).toBe(100);
    expect(targetAt(w, 300, 200).watts).toBe(125); // halfway up the warm-up ramp
    expect(targetAt(w, 14 * 60, 200).watts).toBe(200);
    expect(targetAt(w, 62 * 60, 200).watts).toBeNull(); // free step
    expect(targetAt(w, w.totalS, 200).done).toBe(true);
  });

  it('parses Zwift .zwo', async () => {
    const w = parseZwo(await readFile('examples/vo2-30-30.zwo', 'utf8'));
    expect(w.name).toBe('VO2 30/30 x 2 sets');
    expect(w.steps).toHaveLength(1 + 20 + 1 + 20 + 1);
    expect(targetAt(w, 605, 250).watts).toBe(300);
    expect(targetAt(w, 635, 250).watts).toBe(125);
  });
});

describe('session (mock, accelerated)', () => {
  it('rides a workout to completion and writes a valid FIT with one lap per step', async () => {
    const w = parseYamlWorkout(`name: t\nsteps:\n  - warmup: { duration: 60s, from: 50%, to: 70% }\n  - repeat: 2\n    steps:\n      - work: { duration: 30s, power: 120% }\n      - recovery: { duration: 30s, power: 50% }\n`);
    const trainer = new MockTrainer(180);
    const s = new Session(trainer, { kind: 'workout', workout: w, ftp: 200 }, DEFAULTS, { speedup: 2000 });
    const done = new Promise((r) => s.once('finished', r));
    s.start();
    await done;
    const fit = s.recorder.toFit(s.now);
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
