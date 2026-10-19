/** Simple rider + bike longitudinal model. SI units throughout. */

export interface RiderModel {
  massKg: number;   // rider + bike
  cda: number;      // m²
  crr: number;
  rho?: number;     // air density kg/m³
}

const G = 9.81;

export function resistiveForce(v: number, gradePct: number, m: RiderModel): number {
  const theta = Math.atan(gradePct / 100);
  const rho = m.rho ?? 1.225;
  const aero = 0.5 * rho * m.cda * v * Math.abs(v);
  const roll = v > 0.05 ? m.crr * m.massKg * G * Math.cos(theta) : 0;
  const gravity = m.massKg * G * Math.sin(theta);
  return aero + roll + gravity;
}

/** Power needed to hold steady speed v on grade. */
export function powerForSpeed(v: number, gradePct: number, m: RiderModel): number {
  return resistiveForce(v, gradePct, m) * v;
}

/** Steady-state speed for a given power (bisection — monotonic for P ≥ 0). */
export function steadySpeed(powerW: number, gradePct: number, m: RiderModel): number {
  let lo = 0, hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (powerForSpeed(mid, gradePct, m) > powerW) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Integrate one time step: m·dv/dt = P/v − F_resist.
 * Sub-stepped for stability; v floored at 0 (no rolling backwards).
 */
export function stepSpeed(v: number, powerW: number, gradePct: number, m: RiderModel, dt: number): number {
  const sub = 10;
  const h = dt / sub;
  const effMass = m.massKg + 1.5; // + wheel rotational inertia
  for (let i = 0; i < sub; i++) {
    const drive = powerW / Math.max(v, 1.0); // cap force at very low speed
    const a = (drive - resistiveForce(v, gradePct, m)) / effMass;
    v = Math.max(0, v + a * h);
  }
  return v;
}
