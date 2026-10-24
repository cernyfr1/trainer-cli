import { EventEmitter } from 'node:events';
import type { Trainer } from '../../application/ports.js';
import type { DiscoveredTrainer, SimParams, TrainerFeatures } from '../../domain/trainer-data.js';
import { norm } from '../ble-uuid.js';
import { ZwiftClick } from '../controller/zwift-click.js';
import { CLICK_LABEL, parseZwiftAdvert, type ClickKind } from '../controller/zwift-codec.js';
import { DebugLog } from '../debug-log.js';
import { FTMS, OpCode, cmd, decodeControlResponse, decodeFeatures, decodeIndoorBikeData } from '../ftms/codec.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Noble = any;
type Peripheral = any;
type Characteristic = any;

/**
 * Finds FTMS trainers and Zwift Click remotes over Bluetooth.
 * noble is loaded lazily so the app (and --mock) works where the native module isn't built.
 */
export class BleScanner {
  private noblePromise?: Promise<Noble>;

  constructor(private debug = new DebugLog('', false)) {}

  /** Scan for FTMS trainers for `seconds`; Zwift Click pucks seen meanwhile go to `onClick`. */
  async scan(
    seconds = 8, onFound?: (t: DiscoveredTrainer) => void, onClick?: (c: DiscoveredTrainer & { kind: ClickKind }) => void,
  ): Promise<Map<string, { info: DiscoveredTrainer; p: Peripheral }>> {
    const noble = await this.ready();
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
  async find(filter?: string, timeoutS = 15): Promise<BleFtmsTrainer> {
    const noble = await this.ready();
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

  /**
   * Scan for Zwift Click pucks (v1, or the v2 left/right pair) and hand each one to `onFound`.
   * Unfiltered scan: Clicks don't reliably advertise their custom service, so match on manufacturer data.
   * Stops after `timeoutS`, or once a v1 or both v2 sides have been found.
   */
  async findClicks(filter: string | undefined, timeoutS: number, onFound: (c: ZwiftClick) => void): Promise<void> {
    const noble = await this.ready();
    const seen = new Set<ClickKind>();
    await new Promise<void>((resolve) => {
      const finish = async () => {
        clearTimeout(to);
        noble.removeListener('discover', onDiscover);
        await noble.stopScanningAsync().catch(() => undefined);
        resolve();
      };
      const to = setTimeout(finish, timeoutS * 1000);
      const onDiscover = (p: Peripheral) => {
        const kind = parseZwiftAdvert(p.advertisement?.manufacturerData);
        if (!kind || seen.has(kind)) return;
        const name: string = p.advertisement?.localName ?? '';
        if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
        seen.add(kind);
        onFound(new ZwiftClick(p, kind, this.debug));
        if (seen.has('click-v1') || (seen.has('click-v2-left') && seen.has('click-v2-right'))) void finish();
      };
      noble.on('discover', onDiscover);
      noble.startScanningAsync([], false).catch(() => void finish());
    });
  }

  /** noble, loaded and with the adapter powered on. */
  private async ready(): Promise<Noble> {
    this.noblePromise ??= import('@abandonware/noble' as string)
      .then((m: any) => m.default ?? m)
      .catch((e: Error) => {
        throw new Error(
          `Bluetooth support unavailable (@abandonware/noble failed to load: ${e.message}).\n` +
          `Install build tools (Xcode CLT on macOS) and run "npm i @abandonware/noble", or use --mock.`,
        );
      });
    const noble = await this.noblePromise;
    if (noble.state === 'poweredOn' || noble._state === 'poweredOn') return noble;
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`Bluetooth adapter not ready (state: ${noble.state})`)), 10_000);
      noble.on('stateChange', (s: string) => { if (s === 'poweredOn') { clearTimeout(to); resolve(); } });
    });
    return noble;
  }
}

interface Pending { op: number; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class BleFtmsTrainer extends EventEmitter implements Trainer {
  features?: TrainerFeatures;
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
