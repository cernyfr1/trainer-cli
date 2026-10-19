import type { FinishedActivity } from '../domain/activity.js';
import type { ActivityStore, ActivityUploader, UploadResult } from './ports.js';
import type { Session } from './session.js';

export interface SavedRide {
  file: string;
  activity: FinishedActivity;
  distanceM: number;
  avgPowerW: number;
}

/** What happens after the ride: persist it, optionally upload it. */
export class RideFinisher {
  constructor(private store: ActivityStore, private uploader: ActivityUploader) {}

  /** Close the session's recording and persist it. Undefined when nothing was recorded. */
  async save(session: Session): Promise<SavedRide | undefined> {
    if (!session.recorder.samples.length) return undefined;
    const activity = session.recorder.finish(session.now);
    const file = await this.store.save(activity);
    const s = activity.samples;
    return {
      file,
      activity,
      distanceM: s[s.length - 1].distanceM,
      avgPowerW: Math.round(s.reduce((a, x) => a + (x.powerW ?? 0), 0) / s.length),
    };
  }

  canUpload(): Promise<boolean> { return this.uploader.isConnected(); }

  /** Route rides go up as virtual rides, everything else as indoor/trainer. */
  upload(ride: SavedRide, name?: string): Promise<UploadResult> {
    return this.uploader.upload(ride.file, { name: name ?? ride.activity.name, indoor: ride.activity.kind !== 'virtual' });
  }
}
