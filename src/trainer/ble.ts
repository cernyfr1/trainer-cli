import { EventEmitter } from 'node:events';
import {
  FTMS, OpCode, cmd, decodeControlResponse, decodeFeatures, decodeIndoorBikeData, type FtmsFeatures,
} from '../ftms/codec.js';
import { CLICK_LABEL, parseZwiftAdvert, type ClickKind } from '../controller/zwiftCodec.js';
import type { DiscoveredTrainer, SimParams, Trainer } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Noble = any;
type Peripheral = any;
type Characteristic = any;

let noblePromise: Promise<Noble> | undefined;

/** Lazy-load noble so the app (and --mock) works where the native module isn't built. */
export async function loadNoble(): Promise<Noble> {
  noblePromise ??= import('@abandonware/noble' as string)
    .then((m: any) => m.default ?? m)
    .catch((e: Error) => {
      throw new Error(
        `Bluetooth support unavailable (@abandonware/noble failed to load: ${e.message}).\n` +
        `Install build tools (Xcode CLT on macOS) and run "npm i @abandonware/noble", or use --mock.`,
      );
    });
  return noblePromise;
}

export async function poweredOn(noble: Noble): Promise<void> {
  if (noble.state === 'poweredOn' || noble._state === 'poweredOn') return;
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`Bluetooth adapter not ready (state: ${noble.state})`)), 10_000);
    noble.on('stateChange', (s: string) => { if (s === 'poweredOn') { clearTimeout(to); resolve(); } });
  });
}

export const norm = (uuid: string) => uuid.replace(/-/g, '').toLowerCase().replace(/^0000(....)00001000800000805f9b34fb$/, '$1');

/** Scan for FTMS trainers for `seconds`; Zwift Click pucks seen meanwhile go to `onClick`. */
export async function scanTrainers(
  seconds = 8, onFound?: (t: DiscoveredTrainer) => void, onClick?: (c: DiscoveredTrainer & { kind: ClickKind }) => void,
): Promise<Map<string, { info: DiscoveredTrainer; p: Peripheral }>> {
  const noble = await loadNoble();
  await poweredOn(noble);
  const found = new Map<string, { info: DiscoveredTrainer; p: Peripheral }>();
  const clicks = new Set<string>();
  const onDiscover = (p: Peripheral) => {
    const name: string = p.advertisement?.localName ?? '(unnamed)';
    const kind = parseZwiftAdvert(p.advertisement?.manufacturerData);
    if (kind && !clicks.has(p.id)) {
      clicks.add(p.id);
      onClick?.({ id: p.id, name: CLICK_LABEL[kind], rssi: p.rssi, kind });
    }
    const uuids: string[] = (p.advertisement?.serviceUuids ?? []).map(norm);
    if (!uuids.includes(FTMS.service) || found.has(p.id)) return;
    const info = { id: p.id, name, rssi: p.rssi };
    found.set(p.id, { info, p });
    onFound?.(info);
  };
  noble.on('discover', onDiscover);
  // unfiltered: Clicks don't reliably advertise their service UUID
  await noble.startScanningAsync([], false);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await noble.stopScanningAsync();
  noble.removeListener('discover', onDiscover);
  return found;
}

/** Find a trainer whose name contains `filter` (case-insensitive) — first match wins. */
export async function findTrainer(filter?: string, timeoutS = 15): Promise<BleFtmsTrainer> {
  const noble = await loadNoble();
  await poweredOn(noble);
  return new Promise((resolve, reject) => {
    const to = setTimeout(async () => {
      noble.removeListener('discover', onDiscover);
      await noble.stopScanningAsync();
      reject(new Error(`No FTMS trainer${filter ? ` matching "${filter}"` : ''} found in ${timeoutS}s`));
    }, timeoutS * 1000);
    const onDiscover = async (p: Peripheral) => {
      const name: string = p.advertisement?.localName ?? '';
      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
      clearTimeout(to);
      noble.removeListener('discover', onDiscover);
      await noble.stopScanningAsync();
      resolve(new BleFtmsTrainer(p));
    };
    noble.on('discover', onDiscover);
    noble.startScanningAsync([FTMS.service], false).catch(reject);
  });
}

interface Pending { op: number; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class BleFtmsTrainer extends EventEmitter implements Trainer {
  features?: FtmsFeatures;
  private cp?: Characteristic;
  private queue: Promise<void> = Promise.resolve();
  private pending?: Pending;
  private connected = false;

  constructor(private p: Peripheral) { super(); }

  get name(): string { return this.p.advertisement?.localName ?? this.p.id; }

  async connect(): Promise<void> {
    await this.p.connectAsync();
    this.connected = true;
    this.p.once('disconnect', () => { this.connected = false; this.emit('disconnect'); });

    const { characteristics } = await this.p.discoverSomeServicesAndCharacteristicsAsync(
      [FTMS.service], [FTMS.feature, FTMS.indoorBikeData, FTMS.controlPoint, FTMS.machineStatus],
    );
    const byId = (u: string) => characteristics.find((c: Characteristic) => norm(c.uuid) === u);

    const feat = byId(FTMS.feature);
    if (feat) {
      this.features = decodeFeatures(new Uint8Array(await feat.readAsync()));
      this.emit('log', `features: ${JSON.stringify(this.features)}`);
    }

    const ibd = byId(FTMS.indoorBikeData);
    if (!ibd) throw new Error('Trainer has no Indoor Bike Data characteristic');
    ibd.on('data', (d: Buffer) => this.emit('data', decodeIndoorBikeData(new Uint8Array(d))));
    await ibd.subscribeAsync();

    const status = byId(FTMS.machineStatus);
    if (status) {
      status.on('data', (d: Buffer) => this.emit('log', `status: ${d.toString('hex')}`));
      await status.subscribeAsync().catch(() => undefined);
    }

    this.cp = byId(FTMS.controlPoint);
    if (!this.cp) throw new Error('Trainer has no Control Point — read-only device?');
    this.cp.on('data', (d: Buffer) => this.onControlResponse(new Uint8Array(d)));
    await this.cp.subscribeAsync(); // indications

    await this.send(cmd.requestControl());
    await this.send(cmd.start()).catch((e) => this.emit('log', `start: ${e.message}`));
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.send(cmd.reset()).catch(() => undefined);
    await this.p.disconnectAsync();
  }

  setErgPower(watts: number): Promise<void> { return this.send(cmd.setTargetPower(watts)); }

  setSimulation(s: SimParams): Promise<void> {
    return this.send(cmd.setSimulation(s.gradePct, s.windMs, s.crr, s.cw));
  }

  /** Serialised: one control point write in flight, resolved by its indication. */
  private send(bytes: Uint8Array): Promise<void> {
    const run = () => new Promise<void>((resolve, reject) => {
      if (!this.cp) return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error(`control point op 0x${bytes[0].toString(16)} timed out`));
      }, 2000);
      this.pending = { op: bytes[0], resolve, reject, timer };
      this.cp.writeAsync(Buffer.from(bytes), false).catch((e: Error) => {
        clearTimeout(timer); this.pending = undefined; reject(e);
      });
    });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onControlResponse(buf: Uint8Array) {
    const r = decodeControlResponse(buf);
    if (!r || !this.pending || r.requestOp !== this.pending.op) return;
    const { resolve, reject, timer } = this.pending;
    clearTimeout(timer);
    this.pending = undefined;
    if (r.ok) resolve();
    else if (r.requestOp === OpCode.StartResume) resolve(); // many trainers reject start when already running
    else reject(new Error(`op 0x${r.requestOp.toString(16)} failed: ${r.message}`));
  }
}
