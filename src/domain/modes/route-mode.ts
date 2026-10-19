import { clamp } from '../math.js';
import type { RiderModel } from '../physics.js';
import type { Route, RouteCursor } from '../route.js';
import type { Motion, ModeSnapshot, RideContext, RideMode } from './ride-mode.js';

export interface RouteModeOptions {
  model: RiderModel;
  minGrade: number;
  maxGrade: number;
  difficulty: number;
  profileColumns?: number;
}

/** Ride a course: road grade → trainer simulation, virtual speed from power via the physics model. */
export class RouteMode implements RideMode {
  readonly kind = 'route';
  readonly recordingKind = 'virtual';
  private cursor: RouteCursor;
  private profile: number[];
  private difficulty: number;
  private v = 0;              // virtual speed m/s
  private dist = 0;           // virtual distance m
  private ascent = 0;
  private lastAlt?: number;

  constructor(readonly route: Route, private opts: RouteModeOptions) {
    this.cursor = route.cursor();
    this.profile = this.cursor.profile(opts.profileColumns ?? 60);
    this.difficulty = opts.difficulty;
  }

  get title() { return this.route.name; }

  private sentGrade(): number {
    const g = this.cursor.at(this.dist).gradePct;
    return clamp(g, this.opts.minGrade, this.opts.maxGrade) * this.difficulty;
  }

  control(ctx: RideContext) { return ctx.sendGrade(this.sentGrade()); }

  advance(ctx: RideContext, dtS: number): Motion {
    const here = this.cursor.at(this.dist);
    this.v = this.opts.model.stepSpeed(this.v, ctx.recording ? ctx.powerW : 0, here.gradePct, dtS);
    if (ctx.recording) this.dist = Math.min(this.dist + this.v * dtS, this.route.totalDist);
    const p = this.cursor.at(this.dist);
    if (this.lastAlt !== undefined && ctx.recording) this.ascent += Math.max(0, p.ele - this.lastAlt);
    this.lastAlt = p.ele;
    return { speedMs: this.v, distanceM: this.dist, altitudeM: p.ele, lat: p.lat, lon: p.lon };
  }

  adjust(dir: 1 | -1) {
    this.difficulty = clamp(Math.round((this.difficulty + dir * 0.1) * 10) / 10, 0, 2);
    return `difficulty ${Math.round(this.difficulty * 100)} %`;
  }

  finishReason() { return this.dist >= this.route.totalDist ? 'route finished' : undefined; }

  snapshot(): ModeSnapshot {
    const here = this.cursor.at(this.dist);
    return {
      gradePct: here.gradePct, sentGradePct: this.sentGrade(), altitudeM: here.ele, ascentM: this.ascent,
      routeTotalM: this.route.totalDist, profile: this.profile, difficulty: this.difficulty,
    };
  }
}
