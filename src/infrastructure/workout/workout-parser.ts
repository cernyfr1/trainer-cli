import type { Workout } from '../../domain/workout.js';

/** One workout file format. */
export interface WorkoutParser {
  /** Lower-case file extensions incl. the dot; the first one is shown in error hints. */
  readonly extensions: readonly string[];
  parse(text: string, fallbackName: string): Workout;
}
