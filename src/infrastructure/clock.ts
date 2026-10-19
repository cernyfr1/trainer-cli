import type { Clock } from '../application/ports.js';

export class RealClock implements Clock {
  now() { return Date.now(); }

  every(periodS: number, fn: (dtS: number) => void) {
    const t = setInterval(() => fn(periodS), periodS * 1000);
    return () => clearInterval(t);
  }
}

interface Timer { periodS: number; dueS: number; fn: (dtS: number) => void }

/**
 * Simulated time that runs `speedup`× faster than the wall clock, in 1 s steps.
 * All timers fire in registration order on the same step, so a mock trainer registered
 * before the session produces its data before the session reads it.
 */
export class SimClock implements Clock {
  private t: number;
  private elapsedS = 0;
  private timers: Timer[] = [];
  private driver?: NodeJS.Timeout;

  constructor(private speedup = 1, start = Date.now()) { this.t = start; }

  now() { return this.t; }

  every(periodS: number, fn: (dtS: number) => void) {
    if (!Number.isInteger(periodS) || periodS < 1) throw new Error('SimClock periods must be whole seconds');
    const timer: Timer = { periodS, dueS: this.elapsedS + periodS, fn };
    this.timers.push(timer);
    this.driver ??= setInterval(() => this.step(), 1000 / this.speedup);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
      if (!this.timers.length && this.driver) { clearInterval(this.driver); this.driver = undefined; }
    };
  }

  private step() {
    this.elapsedS += 1;
    this.t += 1000;
    for (const timer of [...this.timers]) {
      if (timer.dueS > this.elapsedS || !this.timers.includes(timer)) continue;
      timer.dueS += timer.periodS;
      timer.fn(timer.periodS);
    }
  }
}
