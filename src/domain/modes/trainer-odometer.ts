import type { Motion, RideContext } from './ride-mode.js';

/** Motion for indoor modes: speed as the trainer reports it, distance integrated while recording. */
export class TrainerOdometer {
  private dist = 0;

  advance(ctx: RideContext, dtS: number): Motion {
    if (ctx.recording) this.dist += ctx.trainerSpeedMs * dtS;
    return { speedMs: ctx.trainerSpeedMs, distanceM: this.dist };
  }
}
