import { XMLParser } from 'fast-xml-parser';
import { buildWorkout, type Step, type Workout } from '../../domain/workout.js';

export function parseZwo(xml: string, fallbackName = 'workout'): Workout {
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
        steps.push({ label: tag.toLowerCase(), kind, durationS: num('Duration')!, from: { ftp: num('PowerLow')! }, to: { ftp: num('PowerHigh')! }, cadence: cad });
        break;
      }
      case 'SteadyState':
        steps.push({ label: 'steady', kind: 'steady', durationS: num('Duration')!, from: { ftp: num('Power')! }, to: { ftp: num('Power')! }, cadence: cad });
        break;
      case 'IntervalsT': {
        const n = num('Repeat') ?? 1;
        for (let r = 1; r <= n; r++) {
          steps.push({ label: `${r}/${n} on`, kind: 'work', durationS: num('OnDuration')!, from: { ftp: num('OnPower')! }, to: { ftp: num('OnPower')! }, cadence: num('Cadence') });
          steps.push({ label: `${r}/${n} off`, kind: 'recovery', durationS: num('OffDuration')!, from: { ftp: num('OffPower')! }, to: { ftp: num('OffPower')! }, cadence: num('CadenceResting') });
        }
        break;
      }
      case 'FreeRide': case 'Freeride':
        steps.push({ label: 'free ride', kind: 'free', durationS: num('Duration')!, from: { watts: 0 }, to: { watts: 0 } });
        break;
      default: // textevent etc.
        break;
    }
  }
  return buildWorkout({ name: textOf('name') ?? fallbackName, description: textOf('description'), steps });
}
