/**
 * Fitness Machine Service (FTMS, Bluetooth SIG 0x1826) codec.
 * Pure functions — no BLE dependency — so they can be unit-tested byte-exact.
 */

export const FTMS = {
  service: '1826',
  feature: '2acc',
  indoorBikeData: '2ad2',
  trainingStatus: '2ad3',
  supportedPowerRange: '2ad8',
  controlPoint: '2ad9',
  machineStatus: '2ada',
} as const;

export const OpCode = {
  RequestControl: 0x00,
  Reset: 0x01,
  SetTargetResistance: 0x04,
  SetTargetPower: 0x05,
  StartResume: 0x07,
  StopPause: 0x08,
  SetIndoorBikeSimulation: 0x11,
  ResponseCode: 0x80,
} as const;

export const ResultCode: Record<number, string> = {
  0x01: 'success',
  0x02: 'op code not supported',
  0x03: 'invalid parameter',
  0x04: 'operation failed',
  0x05: 'control not permitted',
};

export interface IndoorBikeData {
  speedKmh?: number;
  avgSpeedKmh?: number;
  cadenceRpm?: number;
  avgCadenceRpm?: number;
  totalDistanceM?: number;
  resistanceLevel?: number;
  powerW?: number;
  avgPowerW?: number;
  totalEnergyKcal?: number;
  energyPerHour?: number;
  energyPerMinute?: number;
  heartRateBpm?: number;
  met?: number;
  elapsedS?: number;
  remainingS?: number;
}

/** Decode an Indoor Bike Data (0x2AD2) notification. */
export function decodeIndoorBikeData(buf: Uint8Array): IndoorBikeData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out: IndoorBikeData = {};
  const has = (bit: number) => (flags & (1 << bit)) !== 0;

  // bit 0 "More Data" is inverted: 0 => instantaneous speed present
  if (!has(0)) { out.speedKmh = dv.getUint16(o, true) / 100; o += 2; }
  if (has(1)) { out.avgSpeedKmh = dv.getUint16(o, true) / 100; o += 2; }
  if (has(2)) { out.cadenceRpm = dv.getUint16(o, true) / 2; o += 2; }
  if (has(3)) { out.avgCadenceRpm = dv.getUint16(o, true) / 2; o += 2; }
  if (has(4)) { out.totalDistanceM = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16); o += 3; }
  if (has(5)) { out.resistanceLevel = dv.getInt16(o, true); o += 2; }
  if (has(6)) { out.powerW = dv.getInt16(o, true); o += 2; }
  if (has(7)) { out.avgPowerW = dv.getInt16(o, true); o += 2; }
  if (has(8)) {
    out.totalEnergyKcal = dv.getUint16(o, true);
    out.energyPerHour = dv.getUint16(o + 2, true);
    out.energyPerMinute = dv.getUint8(o + 4);
    o += 5;
  }
  if (has(9)) { out.heartRateBpm = dv.getUint8(o); o += 1; }
  if (has(10)) { out.met = dv.getUint8(o) / 10; o += 1; }
  if (has(11)) { out.elapsedS = dv.getUint16(o, true); o += 2; }
  if (has(12)) { out.remainingS = dv.getUint16(o, true); o += 2; }
  return out;
}

/** Inverse of decodeIndoorBikeData — used by the mock trainer and tests. */
export function encodeIndoorBikeData(d: IndoorBikeData): Uint8Array {
  const bytes: number[] = [];
  let flags = 0;
  const u16 = (v: number) => { const x = Math.round(v) & 0xffff; bytes.push(x & 0xff, x >> 8); };
  if (d.speedKmh !== undefined) u16(d.speedKmh * 100); else flags |= 1;
  if (d.cadenceRpm !== undefined) { flags |= 1 << 2; u16(d.cadenceRpm * 2); }
  if (d.totalDistanceM !== undefined) {
    flags |= 1 << 4;
    const x = Math.round(d.totalDistanceM) & 0xffffff;
    bytes.push(x & 0xff, (x >> 8) & 0xff, x >> 16);
  }
  if (d.powerW !== undefined) { flags |= 1 << 6; u16(d.powerW); }
  if (d.heartRateBpm !== undefined) { flags |= 1 << 9; bytes.push(Math.round(d.heartRateBpm) & 0xff); }
  return Uint8Array.from([flags & 0xff, flags >> 8, ...bytes]);
}

export const cmd = {
  requestControl: () => Uint8Array.of(OpCode.RequestControl),
  reset: () => Uint8Array.of(OpCode.Reset),
  start: () => Uint8Array.of(OpCode.StartResume),
  stop: (pause = false) => Uint8Array.of(OpCode.StopPause, pause ? 2 : 1),

  setTargetPower(watts: number): Uint8Array {
    const b = new Uint8Array(3);
    const dv = new DataView(b.buffer);
    b[0] = OpCode.SetTargetPower;
    dv.setInt16(1, clamp(Math.round(watts), 0, 4000), true);
    return b;
  },

  /**
   * @param gradePct   road grade in percent (e.g. 4.5)
   * @param windMs     head wind m/s (positive = headwind)
   * @param crr        rolling resistance coefficient (e.g. 0.004)
   * @param cw         wind resistance coefficient kg/m (0.5·ρ·CdA, e.g. 0.51)
   */
  setSimulation(gradePct: number, windMs = 0, crr = 0.004, cw = 0.51): Uint8Array {
    const b = new Uint8Array(7);
    const dv = new DataView(b.buffer);
    b[0] = OpCode.SetIndoorBikeSimulation;
    dv.setInt16(1, clamp(Math.round(windMs * 1000), -32768, 32767), true);
    dv.setInt16(3, clamp(Math.round(gradePct * 100), -32768, 32767), true);
    dv.setUint8(5, clamp(Math.round(crr * 10000), 0, 255));
    dv.setUint8(6, clamp(Math.round(cw * 100), 0, 255));
    return b;
  },
};

export interface ControlResponse { requestOp: number; result: number; ok: boolean; message: string }

export function decodeControlResponse(buf: Uint8Array): ControlResponse | undefined {
  if (buf.length < 3 || buf[0] !== OpCode.ResponseCode) return undefined;
  return { requestOp: buf[1], result: buf[2], ok: buf[2] === 1, message: ResultCode[buf[2]] ?? `code ${buf[2]}` };
}

/** Decode the 0x2ACC feature characteristic (two uint32 bitfields). */
export function decodeFeatures(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const machine = dv.getUint32(0, true);
  const target = dv.getUint32(4, true);
  return {
    cadence: !!(machine & (1 << 1)),
    totalDistance: !!(machine & (1 << 2)),
    resistanceLevel: !!(machine & (1 << 7)),
    heartRate: !!(machine & (1 << 10)),
    power: !!(machine & (1 << 14)),
    targetResistance: !!(target & (1 << 2)),
    targetPower: !!(target & (1 << 3)),
    indoorBikeSimulation: !!(target & (1 << 13)),
    spinDown: !!(target & (1 << 12)),
  };
}
export type FtmsFeatures = ReturnType<typeof decodeFeatures>;

export function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }
