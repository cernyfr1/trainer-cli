/** Rolling power figures for the dashboard: latest, 3 s average, and ride average over recorded time. */
export class PowerStats {
  private window: number[] = [];
  private sum = 0;
  private n = 0;

  add(powerW: number, recording: boolean) {
    this.window = [...this.window.slice(-2), powerW];
    if (recording) { this.sum += powerW; this.n++; }
  }

  get latestW() { return Math.round(this.window[this.window.length - 1] ?? 0); }
  get avg3sW() { return Math.round(this.window.reduce((a, b) => a + b, 0) / Math.max(1, this.window.length)); }
  get averageW() { return Math.round(this.n ? this.sum / this.n : 0); }
}
