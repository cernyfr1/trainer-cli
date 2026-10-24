import type { Clock, Trainer } from './ports.js';

/**
 * Sends ERG / simulation targets to the trainer, but only when they actually change
 * (ERG ≥ 1 W; grade ≥ 0.1 % or every 5 s). Keeps BLE quiet — cheap trainers drop writes under load.
 */
export class TrainerCommander {
  private lastGrade?: number;
  private lastGradeAt = 0;
  private lastErg?: number;

  constructor(private trainer: Trainer, private clock: Clock, private sim: { crr: number; cw: number }) {}

  async sendGrade(gradePct: number) {
    const now = this.clock.now();
    const sent = Math.round(gradePct * 10) / 10;
    if (this.lastGrade !== undefined && Math.abs(sent - this.lastGrade) < 0.1 && now - this.lastGradeAt < 5000) return;
    this.lastGrade = sent;
    this.lastGradeAt = now;
    this.lastErg = undefined;
    await this.trainer.setSimulation({ gradePct: sent, crr: this.sim.crr, cw: this.sim.cw });
  }

  async sendErg(watts: number) {
    const w = Math.max(0, Math.round(watts));
    if (this.lastErg !== undefined && Math.abs(w - this.lastErg) < 1) return;
    this.lastErg = w;
    this.lastGrade = undefined;
    await this.trainer.setErgPower(w);
  }

  /** Forget what was sent, so the next target goes out even if unchanged. */
  invalidate() {
    this.lastGrade = undefined;
    this.lastErg = undefined;
  }
}
