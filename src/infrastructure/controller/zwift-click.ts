import { EventEmitter } from 'node:events';
import type { Controller } from '../../application/ports.js';
import { norm } from '../ble-uuid.js';
import { hex, type DebugLog } from '../debug-log.js';
import {
  CLICK_LABEL, ClickEdgeDetector, RIDE_ON, RIDE_ON_START, ZWIFT, decodeClickMessage, isLockedResponse, type ClickKind,
} from './zwift-codec.js';

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

/** One Click puck. Writes the RideOn handshake, decodes button messages into 'adjust' events. */
export class ZwiftClick extends EventEmitter implements Controller {
  private edges = new ClickEdgeDetector();
  private connected = false;
  private replied = false;     // SyncTx answered the handshake
  private locked = false;      // ...with the "locked" challenge
  private closed = false;      // disconnect() called, possibly while connect() was in flight

  constructor(private p: Peripheral, readonly kind: ClickKind, private debug: DebugLog) { super(); }

  get name(): string { return CLICK_LABEL[this.kind]; }

  async connect(): Promise<void> {
    await this.p.connectAsync();
    if (this.closed) { await this.p.disconnectAsync(); return; }
    this.connected = true;
    this.p.once('disconnect', () => { this.connected = false; this.emit('disconnect'); });

    const { services } = await this.p.discoverAllServicesAndCharacteristicsAsync();
    this.debug.write(`${this.name} [${this.p.id}] adv ${hex(this.p.advertisement?.manufacturerData ?? new Uint8Array())}`);
    for (const s of services) {
      this.debug.write(`  service ${norm(s.uuid)}: ${s.characteristics.map((c: Characteristic) => `${norm(c.uuid)}(${c.properties.join(',')})`).join(' ')}`);
    }
    const svc = services.find((s: any) => norm(s.uuid) === ZWIFT.rideService)
      ?? services.find((s: any) => norm(s.uuid) === ZWIFT.service);
    if (!svc) throw new Error(`${this.name}: Zwift service not found — update its firmware in Zwift Companion`);
    const byId = (u: string) => svc.characteristics.find((c: Characteristic) => norm(c.uuid) === u);
    const asyncCh = byId(ZWIFT.async), syncRx = byId(ZWIFT.syncRx), syncTx = byId(ZWIFT.syncTx);
    if (!asyncCh || !syncRx || !syncTx) throw new Error(`${this.name}: Zwift characteristics not found`);

    this.debug.write(`  using service ${norm(svc.uuid)}`);
    asyncCh.on('data', (d: Buffer) => { this.debug.write(`${this.name} async  ${hex(d)}`); this.onMessage(new Uint8Array(d)); });
    syncTx.on('data', (d: Buffer, isNotification: boolean) => {
      this.debug.write(`${this.name} syncTx ${hex(d)}${isNotification ? '' : ' (read)'}`);
      if (!isNotification || !d.length) return; // our own readAsync also fires 'data'
      this.replied = true;
      this.onSync(new Uint8Array(d));
    });
    for (const c of [asyncCh, syncTx]) c.on('notify', (on: boolean) => this.debug.write(`  ${norm(c.uuid)} notify=${on}`));
    await asyncCh.subscribeAsync();
    this.debug.write('  subscribed async');
    await syncTx.subscribeAsync();
    this.debug.write('  subscribed syncTx');

    if (this.debug.enabled) await this.debugProbe(services, [asyncCh, syncTx]);

    const fw = await this.firmware(services);
    const old = fw !== undefined && olderThan(fw, MIN_FIRMWARE);
    if (old) this.emit('log', `${this.name} firmware ${fw} — update to ${MIN_FIRMWARE}+ in Zwift Companion`);

    if (this.closed) return; // disconnect() landed during GATT setup
    this.emit('connected');
    const ok = await this.handshake(syncRx, syncTx);
    if (this.closed) return;
    if (!ok) {
      this.emit('log', `${this.name} isn't answering the RideOn handshake — buttons won't work${old ? ' (update its firmware)' : ''}`);
    } else if (!this.locked) {
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
          this.debug.write(`  ${info[id]}: ${v ? Buffer.from(v).toString('utf8') : '?'}`);
        }
        if (already.includes(c) || !c.properties.some((p: string) => p === 'notify' || p === 'indicate')) continue;
        c.on('data', (d: Buffer, isNotification: boolean) => this.debug.write(`${this.name} ${id} ${hex(d)}${isNotification ? '' : ' (read)'}`));
        await c.subscribeAsync()
          .then(() => this.debug.write(`  subscribed ${id}`))
          .catch((e: Error) => this.debug.write(`  subscribe ${id} failed: ${e.message}`));
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
      if (this.closed) return false;
      const what = `${hex(bytes)} (attempt ${attempt + 1}, withoutResponse=${withoutResponse})`;
      try {
        await syncRx.writeAsync(Buffer.from(bytes), withoutResponse);
        this.debug.write(`  handshake written: ${what}`);
      } catch (e: any) {
        this.debug.write(`  handshake write failed: ${what}: ${e.message}`);
      }
      for (let i = 0; i < 20 && !this.replied && !this.closed; i++) await new Promise((r) => setTimeout(r, 100));
      if (this.replied) return true;
      try {
        this.debug.write(`  no reply; syncTx read: ${hex(new Uint8Array(await syncTx.readAsync()))}`);
      } catch (e: any) {
        this.debug.write(`  no reply; syncTx read failed: ${e.message}`);
      }
    }
    return false;
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (!this.connected) return;
    this.p.removeAllListeners('disconnect');
    this.connected = false;
    await this.p.disconnectAsync();
  }

  private onSync(bytes: Uint8Array) {
    if (isLockedResponse(bytes)) {
      this.locked = true;
      this.emit('log', `${this.name} locked — open Zwift once to unlock (use Z on the right puck for −)`);
    }
  }

  private onMessage(bytes: Uint8Array) {
    const b = decodeClickMessage(bytes);
    if (b) {
      const dirs = this.edges.update(b);
      this.debug.write(`  → ${JSON.stringify(b)} adjust ${JSON.stringify(dirs)}`);
      for (const dir of dirs) this.emit('adjust', dir);
    }
  }
}
