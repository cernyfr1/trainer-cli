import { clamp } from '../math.js';
import type { Motion, ModeSnapshot, RideContext, RideMode } from './ride-mode.js';
import { TrainerOdometer } from './trainer-odometer.js';

export interface FreeModeOptions {
  ergW?: number;      // hold this power; otherwise simulate gradePct
  gradePct?: number;
  minGrade: number;
  maxGrade: number;
}

/** Free ride: fixed ERG power or fixed grade, both adjustable with +/-. */
export class FreeMode implements RideMode {
  readonly kind = 'free';
  readonly recordingKind = 'indoor';
  readonly title = 'free ride';
  private ergW?: number;
  private gradePct?: number;
  private readonly odometer = new TrainerOdometer();

  constructor(private opts: FreeModeOptions) {
    this.ergW = opts.ergW;
    this.gradePct = opts.ergW === undefined ? (opts.gradePct ?? 0) : undefined;
  }

  control(ctx: RideContext) {
    return this.ergW !== undefined ? ctx.sendErg(this.ergW) : ctx.sendGrade(this.gradePct ?? 0);
  }

  advance(ctx: RideContext, dtS: number): Motion { return this.odometer.advance(ctx, dtS); }

  adjust(dir: 1 | -1) {
    if (this.ergW !== undefined) this.ergW = Math.max(0, this.ergW + dir * 5);
    else this.gradePct = clamp((this.gradePct ?? 0) + dir * 0.5, this.opts.minGrade, this.opts.maxGrade);
    return undefined;
  }

  finishReason() { return undefined; }

  snapshot(): ModeSnapshot { return { targetW: this.ergW, sentGradePct: this.gradePct }; }
}
