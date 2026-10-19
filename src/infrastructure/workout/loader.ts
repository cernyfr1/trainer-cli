import { readFile } from 'node:fs/promises';
import type { WorkoutSource } from '../../application/ports.js';
import type { Workout } from '../../domain/workout.js';
import { FormatLoader } from '../format-loader.js';
import type { WorkoutParser } from './workout-parser.js';
import { YamlWorkoutParser } from './yaml.js';
import { ZwoWorkoutParser } from './zwo.js';

/** Workout files. Add a format by adding a parser. */
export class WorkoutLoader extends FormatLoader<Workout, string> implements WorkoutSource {
  constructor(parsers: readonly WorkoutParser[] = [new YamlWorkoutParser(), new ZwoWorkoutParser()]) { super('workout', parsers); }

  protected read(path: string) { return readFile(path, 'utf8'); }
}
