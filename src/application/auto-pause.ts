/** Pauses the ride after `afterS` seconds of no pedalling, resumes as soon as the rider pedals. */
export class AutoPause {
  private zeroFor = 0;
  private active = false;

  constructor(private afterS = 3) {}

  get isActive() { return this.active; }

  /** Feed one 1 s sample. Returns true when the auto-pause state changed. */
  update(powerW: number, cadenceRpm: number): boolean {
    this.zeroFor = powerW < 5 && cadenceRpm < 5 ? this.zeroFor + 1 : 0;
    const was = this.active;
    this.active = this.zeroFor >= this.afterS;
    return was !== this.active;
  }
}
