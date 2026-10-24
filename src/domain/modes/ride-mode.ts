import type { ActivityKind } from '../activity.js';
import type { WorkoutTarget } from '../workout.js';

/** What a mode sees of the running session each tick. Provided by the session engine. */
export interface RideContext {
  readonly powerW: number;          // latest power, 0 when the trainer went quiet
  readonly trainerSpeedMs: number;  // speed reported by the trainer
  readonly timerS: number;          // recorded time, excl. pauses
  readonly recording: boolean;
  /** Throttled: only reaches the trainer when the target actually changed. */
  sendErg(watts: number): Promise<void>;
  sendGrade(gradePct: number): Promise<void>;
  lap(nextLabel?: string): void;
  log(line: string): void;
}

/** Where the rider is after a tick. */
export interface Motion {
  speedMs: number;
  distanceM: number;
  altitudeM?: number;
  lat?: number;
  lon?: number;
}

/** Mode-specific part of the dashboard snapshot. */
export interface ModeSnapshot {
  // route
  gradePct?: number;      // actual road grade
  sentGradePct?: number;  // after clamp × difficulty (or free-ride grade)
  altitudeM?: number;
  ascentM?: number;
  routeTotalM?: number;
  profile?: number[];
  difficulty?: number;
  // workout / erg
  targetW?: number | null;
  ergOffsetW?: number;
  workout?: { name: string; totalS: number; elapsedS: number; target: WorkoutTarget; steps: { label: string; durationS: number; kind: string }[] };
}

/** Strategy for one way of riding: decides trainer targets, motion, end condition and +/- behaviour. */
export interface RideMode {
  readonly kind: 'route' | 'workout' | 'free';
  readonly title: string;
  readonly recordingKind: ActivityKind;
  /** Command the trainer for this tick. */
  control(ctx: RideContext): Promise<void>;
  /** Advance the rider by dtS seconds. */
  advance(ctx: RideContext, dtS: number): Motion;
  /** +/- key. Returns a log line, if any. */
  adjust(dir: 1 | -1): string | undefined;
  /** Reason to end the ride, or undefined to keep going. */
  finishReason(ctx: RideContext): string | undefined;
  snapshot(ctx: RideContext): ModeSnapshot;
}
