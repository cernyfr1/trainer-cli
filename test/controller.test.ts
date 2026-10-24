import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ZwiftClick } from '../src/infrastructure/controller/zwift-click.js';
import { RIDE_ON, ZWIFT } from '../src/infrastructure/controller/zwift-codec.js';
import { DebugLog } from '../src/infrastructure/debug-log.js';
import { BleScanner } from '../src/infrastructure/trainer/ble.js';

const hex = (h: string) => Buffer.from(h.replace(/ /g, ''), 'hex');

class FakeCharacteristic extends EventEmitter {
  readonly properties = ['notify'];
  constructor(readonly uuid: string, private onWrite?: (c: FakeCharacteristic) => void) { super(); }
  async subscribeAsync() {}
  async readAsync() { return Buffer.alloc(0); }
  async writeAsync() { this.onWrite?.(this); }
}

/** A Click whose SyncTx answers every handshake write with `reply`. */
class FakePeripheral extends EventEmitter {
  readonly id = 'p1';
  readonly advertisement = { localName: 'Zwift Click', manufacturerData: hex('4a 09 09') };
  readonly syncTx = new FakeCharacteristic(ZWIFT.syncTx);
  disconnected = 0;
  private gate = Promise.resolve();
  constructor(private reply: Uint8Array) { super(); }
  /** Hold connectAsync until the returned function is called. */
  holdConnect() { let release!: () => void; this.gate = new Promise((r) => { release = r; }); return release; }
  async connectAsync() { await this.gate; }
  async disconnectAsync() { this.disconnected++; }
  async discoverAllServicesAndCharacteristicsAsync() {
    const syncRx = new FakeCharacteristic(ZWIFT.syncRx, () => this.syncTx.emit('data', Buffer.from(this.reply), true));
    return { services: [{ uuid: ZWIFT.rideService, characteristics: [new FakeCharacteristic(ZWIFT.async), syncRx, this.syncTx] }] };
  }
}

const connectClick = async (reply: Uint8Array) => {
  const click = new ZwiftClick(new FakePeripheral(reply), 'click-v1', new DebugLog('', false));
  const logs: string[] = [];
  const connected = vi.fn();
  click.on('log', (l: string) => logs.push(l));
  click.on('connected', connected);
  await click.connect();
  return { logs, connected };
};

describe('ZwiftClick handshake', () => {
  it('a RideOn echo means ready', async () => {
    const { logs, connected } = await connectClick(RIDE_ON);
    expect(connected).toHaveBeenCalled();
    expect(logs.some((l) => l.endsWith('ready'))).toBe(true);
  });

  it('a locked reply warns and is not reported as ready', async () => {
    const { logs, connected } = await connectClick(Uint8Array.from([0xff, 0x01]));
    expect(connected).toHaveBeenCalled();
    expect(logs.some((l) => l.includes('locked'))).toBe(true);
    expect(logs.some((l) => l.endsWith('ready'))).toBe(false);
  });

  it('disconnect() during connect() drops the link once it comes up', async () => {
    const p = new FakePeripheral(RIDE_ON);
    const release = p.holdConnect();
    const click = new ZwiftClick(p, 'click-v1', new DebugLog('', false));
    const connected = vi.fn();
    click.on('connected', connected);
    const connecting = click.connect();
    await click.disconnect();
    release();
    await connecting;
    expect(p.disconnected).toBe(1);
    expect(connected).not.toHaveBeenCalled();
  });
});

class FakeNoble extends EventEmitter {
  readonly state = 'poweredOn';
  readonly startScanningAsync = vi.fn(async () => undefined);
  readonly stopScanningAsync = vi.fn(async () => undefined);
  discover(manufacturerData: string, localName = 'Zwift Click') {
    this.emit('discover', { id: manufacturerData, advertisement: { localName, manufacturerData: hex(manufacturerData) } });
  }
}

const scannerWith = (noble: FakeNoble) => {
  const scanner = new BleScanner();
  (scanner as unknown as { noblePromise: Promise<FakeNoble> }).noblePromise = Promise.resolve(noble);
  return scanner;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('BleScanner.findClicks', () => {
  it('stops as soon as a v1 Click is found', async () => {
    const noble = new FakeNoble();
    const onFound = vi.fn();
    const done = scannerWith(noble).findClicks(undefined, 20, onFound);
    await tick();
    noble.discover('4a 09 09');
    await done;
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(noble.stopScanningAsync).toHaveBeenCalled();
    expect(noble.listenerCount('discover')).toBe(0);
  });

  it('waits for both sides of a v2 pair', async () => {
    const noble = new FakeNoble();
    const onFound = vi.fn();
    const done = scannerWith(noble).findClicks(undefined, 20, onFound);
    await tick();
    noble.discover('4a 09 0a 01');
    noble.discover('4a 09 0a 01'); // same side again
    expect(noble.stopScanningAsync).not.toHaveBeenCalled();
    noble.discover('4a 09 0b');
    await done;
    expect(onFound.mock.calls.map(([c]) => c.kind)).toEqual(['click-v2-right', 'click-v2-left']);
  });

  it('ignores Clicks whose name does not match the filter', async () => {
    const noble = new FakeNoble();
    const onFound = vi.fn();
    const ac = new AbortController();
    const done = scannerWith(noble).findClicks('left', 20, onFound, ac.signal);
    await tick();
    noble.discover('4a 09 09', 'Zwift Click');
    ac.abort();
    await done;
    expect(onFound).not.toHaveBeenCalled();
  });

  it('abort ends the scan, and Clicks seen afterwards are not handed out', async () => {
    const noble = new FakeNoble();
    const onFound = vi.fn();
    const ac = new AbortController();
    const done = scannerWith(noble).findClicks(undefined, 20, onFound, ac.signal);
    await tick();
    ac.abort();
    await done;
    noble.discover('4a 09 09');
    expect(onFound).not.toHaveBeenCalled();
    expect(noble.stopScanningAsync).toHaveBeenCalled();
  });

  it('an already aborted signal never starts scanning', async () => {
    const noble = new FakeNoble();
    const ac = new AbortController();
    ac.abort();
    await scannerWith(noble).findClicks(undefined, 20, vi.fn(), ac.signal);
    expect(noble.startScanningAsync).not.toHaveBeenCalled();
  });
});
