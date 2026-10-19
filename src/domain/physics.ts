import type { Config } from './config.js';

const G = 9.81;

/** Simple rider + bike longitudinal model. SI units throughout. */
export class RiderModel {
  constructor(
    readonly massKg: number,   // rider + bike
    readonly cda: number,      // m²
    readonly crr: number,
    readonly rho = 1.225,      // air density kg/m³
  ) {}

  static fromConfig(cfg: Config) { return new RiderModel(cfg.riderMassKg + cfg.bikeMassKg, cfg.cda, cfg.crr); }

  resistiveForce(v: number, gradePct: number): number {
    const theta = Math.atan(gradePct / 100);
    const aero = 0.5 * this.rho * this.cda * v * Math.abs(v);
    const roll = v > 0.05 ? this.crr * this.massKg * G * Math.cos(theta) : 0;
    const gravity = this.massKg * G * Math.sin(theta);
    return aero + roll + gravity;
  }

  /** Power needed to hold steady speed v on grade. */
  powerForSpeed(v: number, gradePct: number): number {
    return this.resistiveForce(v, gradePct) * v;
  }

  /** Steady-state speed for a given power (bisection — monotonic for P ≥ 0). */
  steadySpeed(powerW: number, gradePct: number): number {
    let lo = 0, hi = 40;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.powerForSpeed(mid, gradePct) > powerW) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Integrate one time step: m·dv/dt = P/v − F_resist.
   * Sub-stepped for stability; v floored at 0 (no rolling backwards).
   */
  stepSpeed(v: number, powerW: number, gradePct: number, dt: number): number {
    const sub = 10;
    const h = dt / sub;
    const effMass = this.massKg + 1.5; // + wheel rotational inertia
    for (let i = 0; i < sub; i++) {
      const drive = powerW / Math.max(v, 1.0); // cap force at very low speed
      const a = (drive - this.resistiveForce(v, gradePct)) / effMass;
      v = Math.max(0, v + a * h);
    }
    return v;
  }
}
