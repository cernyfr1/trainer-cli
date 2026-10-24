/**
 * Zwift Click (v1 and v2) BLE codec — reverse-engineered protocol, see the BikeControl project.
 * Pure functions — no BLE dependency — so they can be unit-tested byte-exact.
 */

export const ZWIFT = {
  service: '0000000119ca465186e5fa29dcdd09d1',
  rideService: 'fc82',
  async: '0000000219ca465186e5fa29dcdd09d1',   // notify: button messages
  syncRx: '0000000319ca465186e5fa29dcdd09d1',  // write without response
  syncTx: '0000000419ca465186e5fa29dcdd09d1',  // indicate: handshake reply
  manufacturerId: 0x094a,
} as const;

export const RIDE_ON = Uint8Array.from([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]); // "RideOn"
/** Handshake as Zwift sends it: "RideOn" + 2-byte start request — firmware may ignore a bare 6-byte RideOn. */
export const RIDE_ON_START = Uint8Array.from([...RIDE_ON, 0x00, 0x09]);

const MsgType = { Click: 0x37, Ride: 0x23 } as const;

// Click v2 (RideKeyPadStatus) button bits — a cleared bit means pressed.
const V2 = { shiftUpRight: 0x1000, shiftUpLeft: 0x0100, z: 0x0080 } as const;

export type ClickKind = 'click-v1' | 'click-v2-right' | 'click-v2-left';

const DEVICE_TYPES: Record<number, ClickKind> = { 0x09: 'click-v1', 0x0a: 'click-v2-right', 0x0b: 'click-v2-left' };

export const CLICK_LABEL: Record<ClickKind, string> = {
  'click-v1': 'Zwift Click',
  'click-v2-right': 'Zwift Click v2 (right)',
  'click-v2-left': 'Zwift Click v2 (left)',
};

/** Manufacturer data as noble gives it: company ID (LE) then device type. Play/Ride → undefined. */
export function parseZwiftAdvert(data: Uint8Array | undefined): ClickKind | undefined {
  if (!data || data.length < 3) return undefined;
  if ((data[0] | (data[1] << 8)) !== ZWIFT.manufacturerId) return undefined;
  return DEVICE_TYPES[data[2]];
}

/** Minimal protobuf reader: returns varint fields by number, skips the other wire types. */
export function readProtoVarints(buf: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  let i = 0;
  const varint = () => {
    let v = 0, mul = 1;
    while (i < buf.length) {
      const b = buf[i++];
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 128;
    }
    throw new Error('truncated varint');
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) out.set(field, varint());
    else if (wire === 1) i += 8;
    else if (wire === 2) i += varint();
    else if (wire === 5) i += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

export interface ClickButtons { plus: boolean; minus: boolean }

/** Decode a button message from the Async characteristic. Other message types → undefined. */
export function decodeClickMessage(bytes: Uint8Array): ClickButtons | undefined {
  if (!bytes.length) return undefined;
  const type = bytes[0];
  if (type !== MsgType.Click && type !== MsgType.Ride) return undefined;
  let f: Map<number, number>;
  try { f = readProtoVarints(bytes.subarray(1)); } catch { return undefined; }
  if (type === MsgType.Click) {
    // ClickKeyPadStatus: 1 = plus, 2 = minus; 0 = pressed (also the protobuf default when omitted)
    return { plus: (f.get(1) ?? 0) === 0, minus: (f.get(2) ?? 0) === 0 };
  }
  const map = f.get(1);
  if (map === undefined) return undefined;
  const pressed = (mask: number) => (map & mask) === 0;
  return { plus: pressed(V2.shiftUpRight), minus: pressed(V2.shiftUpLeft) || pressed(V2.z) };
}

/** A locked Click v2 puck answers the RideOn handshake with a 0xFF challenge instead of echoing it. */
export const isLockedResponse = (bytes: Uint8Array) => bytes.length > 0 && bytes[0] === 0xff;

/** The device repeats its state; turn it into one adjust per released → pressed edge. */
export class ClickEdgeDetector {
  private last: ClickButtons = { plus: false, minus: false };

  update(b: ClickButtons): (1 | -1)[] {
    const out: (1 | -1)[] = [];
    if (b.plus && !this.last.plus) out.push(1);
    if (b.minus && !this.last.minus) out.push(-1);
    this.last = b;
    return out;
  }
}
