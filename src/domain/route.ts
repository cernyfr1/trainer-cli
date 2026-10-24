export interface RoutePoint { dist: number; ele: number; lat?: number; lon?: number }
export interface RouteSample extends RoutePoint { gradePct: number }

/** A point as read from a course file; any field may be missing. */
export type RawRoutePoint = { lat?: number; lon?: number; ele?: number; dist?: number };

const R = 6371008.8;

export class Route {
  readonly totalDist: number;
  readonly ascent: number;

  constructor(readonly name: string, readonly points: readonly RoutePoint[]) {
    if (points.length < 2) throw new Error('Route has fewer than 2 usable points');
    let ascent = 0;
    for (let i = 1; i < points.length; i++) ascent += Math.max(0, points[i].ele - points[i - 1].ele);
    this.totalDist = points[points.length - 1].dist;
    this.ascent = ascent;
  }

  /** Raw points → Route: fills missing distance (haversine) and elevation, drops stationary points. */
  static fromPoints(name: string, raw: readonly RawRoutePoint[]): Route {
    const pts: RoutePoint[] = [];
    let dist = 0;
    let lastEle = raw.find((p) => p.ele !== undefined)?.ele ?? 0;
    for (const p of raw) {
      const prev = pts[pts.length - 1];
      if (p.dist !== undefined) dist = p.dist;
      else if (prev && p.lat !== undefined && prev.lat !== undefined && p.lon !== undefined && prev.lon !== undefined) {
        dist += Route.haversine(prev.lat, prev.lon, p.lat, p.lon);
      }
      if (p.ele !== undefined && Number.isFinite(p.ele)) lastEle = p.ele;
      if (prev && dist <= prev.dist) continue; // drop duplicates / stationary points
      pts.push({ dist, ele: lastEle, lat: p.lat, lon: p.lon });
    }
    return new Route(name, pts);
  }

  private static haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Sequential distance lookup with grade smoothed over `window` metres. */
  cursor(window = 30) { return new RouteCursor(this, window); }
}

/** Distance-indexed lookup with smoothed grade. Keeps a cursor for O(1) sequential access. */
export class RouteCursor {
  private i = 0;
  constructor(readonly route: Route, private window = 30) {}

  private idx(d: number): number {
    const p = this.route.points;
    if (d < p[this.i].dist) this.i = 0;
    while (this.i < p.length - 2 && p[this.i + 1].dist <= d) this.i++;
    return this.i;
  }

  private interp(d: number): RoutePoint {
    const p = this.route.points;
    d = Math.max(0, Math.min(d, this.route.totalDist));
    const i = this.idx(d);
    const a = p[i], b = p[i + 1];
    const f = b.dist === a.dist ? 0 : (d - a.dist) / (b.dist - a.dist);
    const lerp = (x?: number, y?: number) => (x === undefined || y === undefined ? undefined : x + (y - x) * f);
    return { dist: d, ele: a.ele + (b.ele - a.ele) * f, lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon) };
  }

  /** Point at distance d; grade = elevation change across ±window/2 metres. */
  at(d: number): RouteSample {
    const h = this.window / 2;
    const lo = Math.max(0, d - h), hi = Math.min(this.route.totalDist, d + h);
    const here = this.interp(d);
    const e0 = this.interp(lo).ele, e1 = this.interp(hi).ele;
    this.interp(d); // restore cursor position near d
    const gradePct = hi > lo ? ((e1 - e0) / (hi - lo)) * 100 : 0;
    return { ...here, gradePct };
  }

  /** Downsampled elevation profile for the TUI. */
  profile(columns: number): number[] {
    const out: number[] = [];
    for (let c = 0; c < columns; c++) out.push(this.interp((this.route.totalDist * c) / (columns - 1)).ele);
    return out;
  }
}
