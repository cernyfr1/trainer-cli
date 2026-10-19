import type { Workout, WorkoutTarget } from '../workout.js';
import type { Motion, ModeSnapshot, RideContext, RideMode } from './ride-mode.js';

/** Structured workout: ERG targets from the step list, one lap per step, free-ride steps at 0 % grade. */
export class WorkoutMode implements RideMode {
  readonly kind = 'workout';
  readonly recordingKind = 'indoor';
  private ergOffset = 0;
  private lastStepIdx = -1;
  private dist = 0;

  constructor(readonly workout: Workout, readonly ftp: number) {}

  get title() { return this.workout.name; }

  private target(ctx: RideContext): WorkoutTarget { return this.workout.targetAt(ctx.timerS, this.ftp); }

  control(ctx: RideContext) {
    const t = this.target(ctx);
    if (t.index !== this.lastStepIdx) {
      if (this.lastStepIdx >= 0) ctx.lap(t.step.label);
      this.lastStepIdx = t.index;
      ctx.log(`step ${t.index + 1}/${this.workout.steps.length}: ${t.step.label}`);
    }
    if (t.watts === null) return ctx.sendGrade(0);
    // while paused in ERG, drop to a low load so restarting isn't a wall
    return ctx.sendErg(ctx.recording ? t.watts + this.ergOffset : Math.min(100, t.watts));
  }

  advance(ctx: RideContext, dtS: number): Motion {
    if (ctx.recording) this.dist += ctx.trainerSpeedMs * dtS;
    return { speedMs: ctx.trainerSpeedMs, distanceM: this.dist };
  }

  adjust(dir: 1 | -1) {
    this.ergOffset += dir * 5;
    return undefined;
  }

  finishReason(ctx: RideContext) { return this.target(ctx).done ? 'workout finished' : undefined; }

  snapshot(ctx: RideContext): ModeSnapshot {
    const t = this.target(ctx);
    const w = this.workout;
    return {
      ergOffsetW: this.ergOffset,
      targetW: t.watts === null ? null : t.watts + this.ergOffset,
      workout: {
        name: w.name, totalS: w.totalS, elapsedS: ctx.timerS, target: t,
        steps: w.steps.map((s) => ({ label: s.label, durationS: s.durationS, kind: s.kind })),
      },
    };
  }
}
