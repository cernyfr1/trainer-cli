import type { Workout } from '../../domain/workout.js';
import type { FileFormat } from '../format-loader.js';

/** One workout file format, parsed from text. */
export type WorkoutParser = FileFormat<Workout, string>;
