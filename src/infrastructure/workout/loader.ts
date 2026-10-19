import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { WorkoutSource } from '../../application/ports.js';
import type { Workout } from '../../domain/workout.js';
import type { WorkoutParser } from './workout-parser.js';
import { YamlWorkoutParser } from './yaml.js';
import { ZwoWorkoutParser } from './zwo.js';

/** Picks a workout parser by file extension. Add a format by adding a parser. */
export class WorkoutLoader implements WorkoutSource {
  constructor(private parsers: readonly WorkoutParser[] = [new YamlWorkoutParser(), new ZwoWorkoutParser()]) {}

  async load(path: string): Promise<Workout> {
    const ext = extname(path).toLowerCase();
    const parser = this.parsers.find((p) => p.extensions.includes(ext));
    if (!parser) throw new Error(`Unsupported workout format "${ext}" — use ${this.parsers.map((p) => p.extensions[0]).join(' or ')}`);
    return parser.parse(await readFile(path, 'utf8'), basename(path, ext));
  }
}
