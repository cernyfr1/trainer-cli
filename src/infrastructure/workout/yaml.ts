import YAML from 'yaml';
import { buildWorkout, parseDuration, parsePower, STEP_KINDS, type Step, type Workout } from '../../domain/workout.js';

export function parseYamlWorkout(text: string, fallbackName = 'workout'): Workout {
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
      const durationS = parseDuration(body.duration);
      if (kind === 'free') {
        steps.push({ label: `${prefix}${body.label ?? 'free ride'}`, kind, durationS, from: { watts: 0 }, to: { watts: 0 } });
        continue;
      }
      const from = parsePower(body.from ?? body.power);
      const to = parsePower(body.to ?? body.power ?? body.from);
      steps.push({ label: `${prefix}${body.label ?? kind}`, kind, durationS, from, to, cadence: body.cadence });
    }
  };
  walk(doc.steps, '');
  return buildWorkout({ name: doc.name ?? fallbackName, ftp: doc.ftp, description: doc.description, steps });
}
