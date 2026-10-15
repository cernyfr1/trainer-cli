import { EventEmitter } from 'node:events';
import { loadNoble, norm, poweredOn } from '../trainer/ble.js';
import {
  CLICK_LABEL, ClickEdgeDetector, RIDE_ON, RIDE_ON_START, ZWIFT, decodeClickMessage, isLockedResponse, parseZwiftAdvert, type ClickKind,
} from './zwiftCodec.js';
import type { Controller } from './types.js';
import { debugLog, hex } from './debug.js';

/** Current Click firmware; older units stayed silent after RideOn in testing (1.0.0). */
const MIN_FIRMWARE = '1.1.0';

const olderThan = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Peripheral = any;
type Characteristic = any;

/**
 * Scan for Zwift Click pucks (v1, or the v2 left/right pair) and hand each one to `onFound`.
 * Unfiltered scan: Clicks don't reliably advertise their custom service, so match on manufacturer data.
 * Stops after `timeoutS`, or once a v1 or both v2 sides have been found.
 */
export async function findClicks(filter: string | undefined, timeoutS: number, onFound: (c: ZwiftClick) => void): Promise<void> {
  const noble = await loadNoble();
  await poweredOn(noble);
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
      onFound(new ZwiftClick(p, kind));
      if (seen.has('click-v1') || (seen.has('click-v2-left') && seen.has('click-v2-right'))) void finish();
    };
    noble.on('discover', onDiscover);
    noble.startScanningAsync([], false).catch(() => void finish());
  });
}

/** One Click puck. Writes the RideOn handshake, decodes button messages into 'adjust' events. */
export class ZwiftClick extends EventEmitter implements Controller {
  private edges = new ClickEdgeDetector();
  private connected = false;
  private replied = false;     // SyncTx answered the handshake

  constructor(private p: Peripheral, readonly kind: ClickKind) { super(); }

  get name(): string { return CLICK_LABEL[this.kind]; }

  async connect(): Promise<void> {
    await this.p.connectAsync();
    this.connected = true;
    this.p.once('disconnect', () => { this.connected = false; this.emit('disconnect'); });

    const { services } = await this.p.discoverAllServicesAndCharacteristicsAsync();
    debugLog(`${this.name} [${this.p.id}] adv ${hex(this.p.advertisement?.manufacturerData ?? new Uint8Array())}`);
    for (const s of services) {
      debugLog(`  service ${norm(s.uuid)}: ${s.characteristics.map((c: Characteristic) => `${norm(c.uuid)}(${c.properties.join(',')})`).join(' ')}`);
    }
    const svc = services.find((s: any) => norm(s.uuid) === ZWIFT.rideService)
      ?? services.find((s: any) => norm(s.uuid) === ZWIFT.service);
    if (!svc) throw new Error(`${this.name}: Zwift service not found — update its firmware in Zwift Companion`);
    const byId = (u: string) => svc.characteristics.find((c: Characteristic) => norm(c.uuid) === u);
    const asyncCh = byId(ZWIFT.async), syncRx = byId(ZWIFT.syncRx), syncTx = byId(ZWIFT.syncTx);
    if (!asyncCh || !syncRx || !syncTx) throw new Error(`${this.name}: Zwift characteristics not found`);

    debugLog(`  using service ${norm(svc.uuid)}`);
    asyncCh.on('data', (d: Buffer) => { debugLog(`${this.name} async  ${hex(d)}`); this.onMessage(new Uint8Array(d)); });
    syncTx.on('data', (d: Buffer, isNotification: boolean) => {
      debugLog(`${this.name} syncTx ${hex(d)}${isNotification ? '' : ' (read)'}`);
      if (!isNotification || !d.length) return; // our own readAsync also fires 'data'
      this.replied = true;
      this.onSync(new Uint8Array(d));
    });
    for (const c of [asyncCh, syncTx]) c.on('notify', (on: boolean) => debugLog(`  ${norm(c.uuid)} notify=${on}`));
    await asyncCh.subscribeAsync();
    debugLog('  subscribed async');
    await syncTx.subscribeAsync();
    debugLog('  subscribed syncTx');

    if (process.env.TRAINER_CLI_DEBUG) await this.debugProbe(services, [asyncCh, syncTx]);

    const fw = await this.firmware(services);
    const old = fw !== undefined && olderThan(fw, MIN_FIRMWARE);
    if (old) this.emit('log', `${this.name} firmware ${fw} — update to ${MIN_FIRMWARE}+ in Zwift Companion`);

    this.emit('connected');
    if (!(await this.handshake(syncRx, syncTx))) {
      this.emit('log', `${this.name} isn't answering the RideOn handshake — buttons won't work${old ? ' (update its firmware)' : ''}`);
    } else {
      this.emit('log', `${this.name} ready`);
    }
  }

  private async firmware(services: any[]): Promise<string | undefined> {
    const c = services.flatMap((s) => s.characteristics as Characteristic[]).find((x) => norm(x.uuid) === '2a26');
    const v = c ? await c.readAsync().catch(() => undefined) : undefined;
    return v ? Buffer.from(v).toString('utf8').replace(/\0+$/, '').trim() : undefined;
  }

  /** Debug only: log device info and listen on every other notify/indicate characteristic. */
  private async debugProbe(services: any[], already: Characteristic[]) {
    const info: Record<string, string> = { '2a29': 'manufacturer', '2a25': 'serial', '2a27': 'hardware', '2a26': 'firmware' };
    for (const s of services) {
      for (const c of s.characteristics as Characteristic[]) {
        const id = norm(c.uuid);
        if (info[id]) {
          const v = await c.readAsync().catch(() => undefined);
          debugLog(`  ${info[id]}: ${v ? Buffer.from(v).toString('utf8') : '?'}`);
        }
        if (already.includes(c) || !c.properties.some((p: string) => p === 'notify' || p === 'indicate')) continue;
        c.on('data', (d: Buffer, isNotification: boolean) => debugLog(`${this.name} ${id} ${hex(d)}${isNotification ? '' : ' (read)'}`));
        await c.subscribeAsync()
          .then(() => debugLog(`  subscribed ${id}`))
          .catch((e: Error) => debugLog(`  subscribe ${id} failed: ${e.message}`));
      }
    }
  }

  /** Write the handshake and wait for the SyncTx reply; fall back through the known variants. */
  private async handshake(syncRx: Characteristic, syncTx: Characteristic): Promise<boolean> {
    // fw 1.1.0 only accepts write-without-response on SyncRx and echoes "RideOn"
    const attempts: [Uint8Array, boolean][] = [
      [RIDE_ON_START, true], [RIDE_ON_START, false], [RIDE_ON, true],
    ];
    for (const [attempt, [bytes, withoutResponse]] of attempts.entries()) {
      const what = `${hex(bytes)} (attempt ${attempt + 1}, withoutResponse=${withoutResponse})`;
      try {
        await syncRx.writeAsync(Buffer.from(bytes), withoutResponse);
        debugLog(`  handshake written: ${what}`);
      } catch (e: any) {
        debugLog(`  handshake write failed: ${what}: ${e.message}`);
      }
      for (let i = 0; i < 20 && !this.replied; i++) await new Promise((r) => setTimeout(r, 100));
      if (this.replied) return true;
      try {
        debugLog(`  no reply; syncTx read: ${hex(new Uint8Array(await syncTx.readAsync()))}`);
      } catch (e: any) {
        debugLog(`  no reply; syncTx read failed: ${e.message}`);
      }
    }
    return false;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.p.removeAllListeners('disconnect');
    this.connected = false;
    await this.p.disconnectAsync();
  }

  private onSync(bytes: Uint8Array) {
    if (isLockedResponse(bytes)) {
      this.emit('log', `${this.name} locked — open Zwift once to unlock (use Z on the right puck for −)`);
    }
  }

  private onMessage(bytes: Uint8Array) {
    const b = decodeClickMessage(bytes);
    if (b) {
      const dirs = this.edges.update(b);
      debugLog(`  → ${JSON.stringify(b)} adjust ${JSON.stringify(dirs)}`);
      for (const dir of dirs) this.emit('adjust', dir);
    }
  }
}
