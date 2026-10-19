import YAML from 'yaml';
import { Duration, Power, STEP_KINDS, Workout, type Step } from '../../domain/workout.js';
import type { WorkoutParser } from './workout-parser.js';

export class YamlWorkoutParser implements WorkoutParser {
  readonly extensions = ['.yaml', '.yml', '.json'];

  parse(text: string, fallbackName = 'workout'): Workout {
    const doc = YAML.parse(text);
    if (!doc || !Array.isArray(doc.steps)) throw new Error('Workout needs a "steps" list');
    const steps: Step[] = [];
    const walk = (items: any[], prefix: string) => {
      for (const item of items) {
        if (item.repeat !== undefined) {
          const n = Number(item.repeat);
          if (!Array.isArray(item.steps)) throw new Error('"repeat" needs nested "steps"');
          for (let r = 1; r <= n; r++) walk(item.steps, `${prefix}${r}/${n} `);
          continue;
        }
        const kind = STEP_KINDS.find((k) => k in item);
        if (!kind) throw new Error(`Unknown step: ${JSON.stringify(item)}`);
        const body = item[kind] ?? {};
        const durationS = Duration.parse(body.duration).seconds;
        if (kind === 'free') {
          steps.push({ label: `${prefix}${body.label ?? 'free ride'}`, kind, durationS, from: Power.watts(0), to: Power.watts(0) });
          continue;
        }
        const from = Power.parse(body.from ?? body.power);
        const to = Power.parse(body.to ?? body.power ?? body.from);
        steps.push({ label: `${prefix}${body.label ?? kind}`, kind, durationS, from, to, cadence: body.cadence });
      }
    };
    walk(doc.steps, '');
    return new Workout({ name: doc.name ?? fallbackName, ftp: doc.ftp, description: doc.description, steps });
  }
}
