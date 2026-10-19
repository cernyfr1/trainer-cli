import { XMLParser } from 'fast-xml-parser';
import { Power, Workout, type Step } from '../../domain/workout.js';
import type { WorkoutParser } from './workout-parser.js';

export class ZwoWorkoutParser implements WorkoutParser {
  readonly extensions = ['.zwo', '.xml'];

  parse(xml: string, fallbackName = 'workout'): Workout {
    const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true });
    const tree = p.parse(xml) as any[];
    const root = tree.find((n) => n.workout_file)?.workout_file;
    if (!root) throw new Error('Not a Zwift .zwo file');
    const textOf = (tag: string) => root.find((n: any) => n[tag])?.[tag]?.[0]?.['#text'];
    const workoutNode = root.find((n: any) => n.workout)?.workout ?? [];
    const steps: Step[] = [];
    for (const node of workoutNode) {
      const tag = Object.keys(node).find((k) => k !== ':@');
      if (!tag) continue;
      const a = node[':@'] ?? {};
      const num = (k: string) => (a[k] !== undefined ? Number(a[k]) : undefined);
      const cad = num('Cadence');
      switch (tag) {
        case 'Warmup': case 'Cooldown': case 'Ramp': {
          const kind = tag === 'Warmup' ? 'warmup' : tag === 'Cooldown' ? 'cooldown' : 'steady';
          steps.push({ label: tag.toLowerCase(), kind, durationS: num('Duration')!, from: Power.ftp(num('PowerLow')!), to: Power.ftp(num('PowerHigh')!), cadence: cad });
          break;
        }
        case 'SteadyState':
          steps.push({ label: 'steady', kind: 'steady', durationS: num('Duration')!, from: Power.ftp(num('Power')!), to: Power.ftp(num('Power')!), cadence: cad });
          break;
        case 'IntervalsT': {
          const n = num('Repeat') ?? 1;
          for (let r = 1; r <= n; r++) {
            steps.push({ label: `${r}/${n} on`, kind: 'work', durationS: num('OnDuration')!, from: Power.ftp(num('OnPower')!), to: Power.ftp(num('OnPower')!), cadence: num('Cadence') });
            steps.push({ label: `${r}/${n} off`, kind: 'recovery', durationS: num('OffDuration')!, from: Power.ftp(num('OffPower')!), to: Power.ftp(num('OffPower')!), cadence: num('CadenceResting') });
          }
          break;
        }
        case 'FreeRide': case 'Freeride':
          steps.push({ label: 'free ride', kind: 'free', durationS: num('Duration')!, from: Power.watts(0), to: Power.watts(0) });
          break;
        default: // textevent etc.
          break;
      }
    }
    return new Workout({ name: textOf('name') ?? fallbackName, description: textOf('description'), steps });
  }
}
