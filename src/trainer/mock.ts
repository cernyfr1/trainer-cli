import { EventEmitter } from 'node:events';
import { decodeIndoorBikeData, encodeIndoorBikeData, type FtmsFeatures } from '../ftms/codec.js';
import { stepSpeed, type RiderModel } from '../physics.js';
import type { SimParams, Trainer } from './types.js';

/**
 * Fake FTMS trainer with a virtual rider attached.
 * - ERG mode: rider holds target ±noise.
 * - Sim mode: rider pedals a "natural" power that rises on climbs, eases on descents.
 * Data goes through the real FTMS encoder/decoder so the codec is exercised end-to-end.
 */
export class MockTrainer extends EventEmitter implements Trainer {
  readonly name = 'MockTrainer';
  readonly features: FtmsFeatures = {
    cadence: true, totalDistance: true, resistanceLevel: false, heartRate: true, power: true,
    targetResistance: false, targetPower: true, indoorBikeSimulation: true, spinDown: false,
  };

  private mode: 'erg' | 'sim' = 'sim';
  private ergW = 150;
  private grade = 0;
  private v = 0;
  private dist = 0;
  private power = 0;
  private hr = 95;
  private t = 0;

  constructor(private basePowerW = 200, private model: RiderModel = { massKg: 84, cda: 0.32, crr: 0.004 }) {
    super();
  }

  async connect() { this.emit('log', 'mock trainer connected'); }
  async disconnect() { this.emit('disconnect'); }
  async setErgPower(w: number) { this.mode = 'erg'; this.ergW = w; }
  async setSimulation(p: SimParams) { this.mode = 'sim'; this.grade = p.gradePct; }

  tick(dt: number) {
    this.t += dt;
    const noise = () => (Math.random() - 0.5) * 2;
    const target = this.mode === 'erg'
      ? this.ergW
      : Math.max(60, this.basePowerW * (1 + this.grade * 0.05));
    // rider responds with a short lag
    this.power += (target - this.power) * Math.min(1, dt * 0.6) + noise() * 6;
    this.power = Math.max(0, this.power);
    this.v = stepSpeed(this.v, this.power, this.mode === 'erg' ? 0 : this.grade, this.model, dt);
    this.dist += this.v * dt;
    const hrTarget = 70 + this.power * 0.38;
    this.hr += (hrTarget - this.hr) * Math.min(1, dt / 25);
    const cadence = this.power < 5 ? 0 : 82 + 8 * Math.sin(this.t / 47) + noise() * 2 - Math.max(0, this.grade) * 0.8;

    const wire = encodeIndoorBikeData({
      speedKmh: this.v * 3.6,
      cadenceRpm: Math.max(0, cadence),
      totalDistanceM: this.dist,
      powerW: this.power,
      heartRateBpm: this.hr,
    });
    this.emit('data', decodeIndoorBikeData(wire));
  }
}
