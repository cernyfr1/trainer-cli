import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Workout } from '../../domain/workout.js';
import { parseYamlWorkout } from './yaml.js';
import { parseZwo } from './zwo.js';

export async function loadWorkout(path: string): Promise<Workout> {
  const ext = extname(path).toLowerCase();
  const text = await readFile(path, 'utf8');
  const name = basename(path, ext);
  if (ext === '.zwo' || ext === '.xml') return parseZwo(text, name);
  if (ext === '.yaml' || ext === '.yml' || ext === '.json') return parseYamlWorkout(text, name);
  throw new Error(`Unsupported workout format "${ext}" — use .yaml or .zwo`);
}
