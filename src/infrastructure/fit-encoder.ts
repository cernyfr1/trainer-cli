import { Encoder, Profile } from '@garmin/fitsdk';
import type { FinishedActivity, Sample } from '../domain/activity.js';

const SEMI = 2 ** 31 / 180;
const M = Profile.MesgNum;
// FIT SDK typings model Mesg loosely; field names are validated by the SDK at runtime.
type AnyMesg = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Serialises an activity to a FIT activity file (file_id, events, records, laps, session, activity). */
export class FitEncoder {
  encode(a: FinishedActivity): Uint8Array {
    const now = a.endedAt;
    const first = a.samples[0].time;
    const subSport = a.kind === 'virtual' ? 'virtualActivity' : 'indoorCycling';
    const encoder = new Encoder();
    const enc = { onMesg: (n: number, m: AnyMesg) => encoder.onMesg(n, m) };

    enc.onMesg(M.FILE_ID, { type: 'activity', manufacturer: 'development', product: 0, timeCreated: first, serialNumber: 0x7ac1 });
    enc.onMesg(M.DEVICE_INFO, { timestamp: first, manufacturer: 'development', product: 0, productName: 'trainer-cli', softwareVersion: 0.1, deviceIndex: 'creator' });

    // timer events interleaved with records in time order
    const evs = [...a.events];
    for (const s of a.samples) {
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

    a.laps.forEach((l, i) => {
      enc.onMesg(M.LAP, {
        messageIndex: i, timestamp: l.end, startTime: l.start, event: 'lap', eventType: 'stop',
        sport: 'cycling', subSport, lapTrigger: i === a.laps.length - 1 ? 'sessionEnd' : 'manual',
        totalElapsedTime: (l.end.getTime() - l.start.getTime()) / 1000, totalTimerTime: l.timerS,
        ...this.stats(a.samples.slice(l.startIdx, l.endIdx)),
      });
    });

    const all = this.stats(a.samples);
    enc.onMesg(M.SESSION, {
      messageIndex: 0, timestamp: now, startTime: first, event: 'session', eventType: 'stop',
      sport: 'cycling', subSport, trigger: 'activityEnd', firstLapIndex: 0, numLaps: a.laps.length,
      totalElapsedTime: (now.getTime() - first.getTime()) / 1000, totalTimerTime: a.timerS,
      ...all,
    });
    enc.onMesg(M.ACTIVITY, {
      timestamp: now, numSessions: 1, type: 'manual', event: 'activity', eventType: 'stop',
      totalTimerTime: a.timerS,
      localTimestamp: (now.getTime() - now.getTimezoneOffset() * 60_000 - 631065600000) / 1000,
    });
    return encoder.close();
  }

  private stats(s: readonly Sample[]) {
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
}
