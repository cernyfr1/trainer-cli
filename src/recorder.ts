import { Encoder, Profile } from '@garmin/fitsdk';

export interface Sample {
  time: Date;
  powerW?: number;
  cadenceRpm?: number;
  heartRateBpm?: number;
  speedMs?: number;
  distanceM: number;
  altitudeM?: number;
  lat?: number;
  lon?: number;
}

interface Lap { startIdx: number; endIdx: number; start: Date; end: Date; timerS: number; label?: string }

const SEMI = 2 ** 31 / 180;
const M = Profile.MesgNum;
// FIT SDK typings model Mesg loosely; field names are validated by the SDK at runtime.
type AnyMesg = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type ActivityKind = 'virtual' | 'indoor';

/** Collects 1 Hz samples, laps and timer pauses; serialises to a FIT activity file. */
export class Recorder {
  readonly samples: Sample[] = [];
  private laps: Lap[] = [];
  private lapStart?: { idx: number; time: Date; timerS: number; label?: string };
  private timerS = 0;
  private events: { time: Date; type: 'start' | 'stopAll' }[] = [];
  private paused = true;

  constructor(readonly kind: ActivityKind, readonly name: string) {}

  start(now: Date) {
    this.events.push({ time: now, type: 'start' });
    this.paused = false;
    this.lapStart ??= { idx: 0, time: now, timerS: 0 };
  }

  pause(now: Date) {
    if (this.paused) return;
    this.events.push({ time: now, type: 'stopAll' });
    this.paused = true;
  }

  get isPaused() { return this.paused; }
  get timerSeconds() { return this.timerS; }
  get lapCount() { return this.laps.length + 1; }

  add(s: Sample, dtS: number) {
    if (this.paused) return;
    this.samples.push(s);
    this.timerS += dtS;
  }

  lap(now: Date, nextLabel?: string) {
    if (!this.lapStart || this.samples.length === this.lapStart.idx) {
      if (this.lapStart) this.lapStart.label = nextLabel;
      return;
    }
    this.laps.push({ startIdx: this.lapStart.idx, endIdx: this.samples.length, start: this.lapStart.time, end: now, timerS: this.timerS - this.lapStart.timerS, label: this.lapStart.label });
    this.lapStart = { idx: this.samples.length, time: now, timerS: this.timerS, label: nextLabel };
  }

  /** Encode the whole activity. Closes the current lap. */
  toFit(now: Date): Uint8Array {
    if (!this.samples.length) throw new Error('Nothing recorded');
    this.pause(now);
    this.lap(now);
    const first = this.samples[0].time;
    const subSport = this.kind === 'virtual' ? 'virtualActivity' : 'indoorCycling';
    const encoder = new Encoder();
    const enc = { onMesg: (n: number, m: AnyMesg) => encoder.onMesg(n, m) };

    enc.onMesg(M.FILE_ID, { type: 'activity', manufacturer: 'development', product: 0, timeCreated: first, serialNumber: 0x7ac1 });
    enc.onMesg(M.DEVICE_INFO, { timestamp: first, manufacturer: 'development', product: 0, productName: 'trainer-cli', softwareVersion: 0.1, deviceIndex: 'creator' });

    // timer events interleaved with records in time order
    const evs = [...this.events];
    for (const s of this.samples) {
      while (evs.length && evs[0].time <= s.time) {
        const e = evs.shift()!;
        enc.onMesg(M.EVENT, { timestamp: e.time, event: 'timer', eventType: e.type, eventGroup: 0 });
      }
      const rec: Record<string, unknown> = { timestamp: s.time, distance: s.distanceM };
      if (s.powerW !== undefined) rec.power = Math.round(s.powerW);
      if (s.cadenceRpm !== undefined) rec.cadence = Math.round(s.cadenceRpm);
      if (s.heartRateBpm !== undefined) rec.heartRate = Math.round(s.heartRateBpm);
      if (s.speedMs !== undefined) { rec.speed = s.speedMs; rec.enhancedSpeed = s.speedMs; }
      if (s.altitudeM !== undefined) { rec.altitude = s.altitudeM; rec.enhancedAltitude = s.altitudeM; }
      if (s.lat !== undefined && s.lon !== undefined) {
        rec.positionLat = Math.round(s.lat * SEMI);
        rec.positionLong = Math.round(s.lon * SEMI);
      }
      enc.onMesg(M.RECORD, rec);
    }
    for (const e of evs) enc.onMesg(M.EVENT, { timestamp: e.time, event: 'timer', eventType: e.type, eventGroup: 0 });

    this.laps.forEach((l, i) => {
      enc.onMesg(M.LAP, {
        messageIndex: i, timestamp: l.end, startTime: l.start, event: 'lap', eventType: 'stop',
        sport: 'cycling', subSport, lapTrigger: i === this.laps.length - 1 ? 'sessionEnd' : 'manual',
        totalElapsedTime: (l.end.getTime() - l.start.getTime()) / 1000, totalTimerTime: l.timerS,
        ...stats(this.samples.slice(l.startIdx, l.endIdx)),
      });
    });

    const all = stats(this.samples);
    enc.onMesg(M.SESSION, {
      messageIndex: 0, timestamp: now, startTime: first, event: 'session', eventType: 'stop',
      sport: 'cycling', subSport, trigger: 'activityEnd', firstLapIndex: 0, numLaps: this.laps.length,
      totalElapsedTime: (now.getTime() - first.getTime()) / 1000, totalTimerTime: this.timerS,
      ...all,
    });
    enc.onMesg(M.ACTIVITY, {
      timestamp: now, numSessions: 1, type: 'manual', event: 'activity', eventType: 'stop',
      totalTimerTime: this.timerS,
      localTimestamp: (now.getTime() - now.getTimezoneOffset() * 60_000 - 631065600000) / 1000,
    });
    return encoder.close();
  }
}

function stats(s: Sample[]) {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : undefined);
  const pick = (k: keyof Sample) => s.map((x) => x[k]).filter((v): v is number => typeof v === 'number');
  const power = pick('powerW'), hr = pick('heartRateBpm'), cad = pick('cadenceRpm'), spd = pick('speedMs'), alt = pick('altitudeM');
  let ascent = 0, descent = 0;
  for (let i = 1; i < alt.length; i++) { const d = alt[i] - alt[i - 1]; if (d > 0) ascent += d; else descent -= d; }
  const out: Record<string, number> = {
    totalDistance: s.length ? s[s.length - 1].distanceM - s[0].distanceM : 0,
  };
  const set = (k: string, v: number | undefined, round = true) => { if (v !== undefined) out[k] = round ? Math.round(v) : v; };
  set('avgPower', avg(power)); set('maxPower', max(power));
  set('avgHeartRate', avg(hr)); set('maxHeartRate', max(hr));
  set('avgCadence', avg(cad)); set('maxCadence', max(cad));
  set('avgSpeed', avg(spd), false); set('maxSpeed', max(spd), false);
  set('enhancedAvgSpeed', avg(spd), false); set('enhancedMaxSpeed', max(spd), false);
  if (alt.length) { out.totalAscent = Math.round(ascent); out.totalDescent = Math.round(descent); }
  if (power.length) out.totalWork = Math.round(power.reduce((a, b) => a + b, 0)); // J at 1 Hz
  if (power.length) out.totalCalories = Math.round(power.reduce((a, b) => a + b, 0) / 1000 / 4.184 / 0.24); // ~24% efficiency
  return out;
}
