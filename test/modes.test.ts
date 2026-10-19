import { describe, expect, it } from 'vitest';
import { FreeMode } from '../src/domain/modes/free-mode.js';
import type { RideContext } from '../src/domain/modes/ride-mode.js';
import { RouteMode } from '../src/domain/modes/route-mode.js';
import { WorkoutMode } from '../src/domain/modes/workout-mode.js';
import { RiderModel } from '../src/domain/physics.js';
import { Route } from '../src/domain/route.js';
import { Power, Workout } from '../src/domain/workout.js';

/** Records what a mode asks of the session instead of talking to a trainer. */
function fakeCtx(over: Partial<RideContext> = {}) {
  const sent: { erg?: number; grade?: number } = {};
  const laps: (string | undefined)[] = [];
  const ctx: RideContext = {
    powerW: 200, trainerSpeedMs: 10, timerS: 0, recording: true,
    sendErg: async (w) => { sent.erg = w; },
    sendGrade: async (g) => { sent.grade = g; },
    lap: (label) => { laps.push(label); },
    log: () => undefined,
    ...over,
  };
  return { ctx, sent, laps };
}

const model = new RiderModel(84, 0.32, 0.004);
// 1 km at 10 %, then 1 km flat
const hill = Route.fromPoints('hill', [{ dist: 0, ele: 0 }, { dist: 1000, ele: 100 }, { dist: 2000, ele: 100 }]);

describe('RouteMode', () => {
  it('sends clamped grade scaled by difficulty', async () => {
    const m = new RouteMode(hill, { model, minGrade: -10, maxGrade: 8, difficulty: 0.5 });
    const { ctx, sent } = fakeCtx();
    m.advance(ctx, 1); // move off the start so the smoothing window is all uphill
    await m.control(ctx);
    expect(sent.grade).toBeCloseTo(4, 5); // 10 % clamped to 8, × 0.5
    expect(m.adjust(1)).toBe('difficulty 60 %');
    expect(m.snapshot().difficulty).toBe(0.6);
  });

  it('only moves while recording and finishes at the end of the course', () => {
    const m = new RouteMode(hill, { model, minGrade: -10, maxGrade: 15, difficulty: 1 });
    expect(m.advance(fakeCtx({ recording: false }).ctx, 1).distanceM).toBe(0);
    const { ctx } = fakeCtx({ powerW: 2000 });
    let d = 0;
    for (let i = 0; i < 3600 && !m.finishReason(); i++) d = m.advance(ctx, 1).distanceM;
    expect(d).toBe(2000);
    expect(m.finishReason()).toBe('route finished');
    expect(m.snapshot().ascentM).toBeCloseTo(100, 0);
  });
});

describe('WorkoutMode', () => {
  const w = new Workout({
    name: 'w',
    steps: [
      { label: 'a', kind: 'steady', durationS: 60, from: Power.ftp(0.5), to: Power.ftp(0.5) },
      { label: 'b', kind: 'free', durationS: 60, from: Power.watts(0), to: Power.watts(0) },
    ],
  });

  it('sends ERG with offset, laps on step change, 0 % grade on free steps', async () => {
    const m = new WorkoutMode(w, 200);
    const first = fakeCtx({ timerS: 10 });
    await m.control(first.ctx);
    expect(first.sent.erg).toBe(100);
    expect(first.laps).toEqual([]); // first step opens no lap
    m.adjust(1);
    await m.control(first.ctx);
    expect(first.sent.erg).toBe(105);

    const free = fakeCtx({ timerS: 70 });
    await m.control(free.ctx);
    expect(free.sent.grade).toBe(0);
    expect(free.laps).toEqual(['b']);
    expect(m.finishReason(fakeCtx({ timerS: 120 }).ctx)).toBe('workout finished');
  });

  it('eases ERG to at most 100 W while paused', async () => {
    const m = new WorkoutMode(w, 400);
    const { ctx, sent } = fakeCtx({ timerS: 0, recording: false });
    await m.control(ctx);
    expect(sent.erg).toBe(100);
  });
});

describe('FreeMode', () => {
  it('ERG: +/- changes power in 5 W steps, never below 0', async () => {
    const m = new FreeMode({ ergW: 5, minGrade: -10, maxGrade: 15 });
    m.adjust(-1); m.adjust(-1);
    const { ctx, sent } = fakeCtx();
    await m.control(ctx);
    expect(sent.erg).toBe(0);
  });

  it('grade: +/- changes grade in 0.5 % steps within limits', async () => {
    const m = new FreeMode({ gradePct: 14.8, minGrade: -10, maxGrade: 15 });
    m.adjust(1);
    const { ctx, sent } = fakeCtx();
    await m.control(ctx);
    expect(sent.grade).toBe(15);
    expect(m.snapshot()).toEqual({ targetW: undefined, sentGradePct: 15 });
  });
});
