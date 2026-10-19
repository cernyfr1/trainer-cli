import type { FinishedActivity } from '../domain/activity.js';
import type { ActivityStore, ActivityUploader, UploadResult } from './ports.js';
import type { Session } from './session.js';

export interface SavedRide {
  file: string;
  activity: FinishedActivity;
  distanceM: number;
  avgPowerW: number;
}

/** Close the session's recording and persist it. Undefined when nothing was recorded. */
export async function saveRide(session: Session, store: ActivityStore): Promise<SavedRide | undefined> {
  if (!session.recorder.samples.length) return undefined;
  const activity = session.recorder.finish(session.now);
  const file = await store.save(activity);
  const s = activity.samples;
  return {
    file,
    activity,
    distanceM: s[s.length - 1].distanceM,
    avgPowerW: Math.round(s.reduce((a, x) => a + (x.powerW ?? 0), 0) / s.length),
  };
}

/** Upload a saved ride. Route rides go up as virtual rides, everything else as indoor/trainer. */
export function uploadRide(ride: SavedRide, uploader: ActivityUploader, name?: string): Promise<UploadResult> {
  return uploader.upload(ride.file, { name: name ?? ride.activity.name, indoor: ride.activity.kind !== 'virtual' });
}
