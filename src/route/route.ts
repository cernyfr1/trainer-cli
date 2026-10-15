import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { Decoder, Stream } from '@garmin/fitsdk';

export interface RoutePoint { dist: number; ele: number; lat?: number; lon?: number }
export interface Route {
  name: string;
  points: RoutePoint[];
  totalDist: number;
  ascent: number;
}
export interface RouteSample extends RoutePoint { gradePct: number }

const R = 6371008.8;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export async function loadRoute(path: string): Promise<Route> {
  const ext = extname(path).toLowerCase();
  if (ext === '.gpx') return parseGpx(await readFile(path, 'utf8'), basename(path, ext));
  if (ext === '.fit') return parseFit(new Uint8Array(await readFile(path)), basename(path, ext));
  throw new Error(`Unsupported route format "${ext}" — use .gpx or .fit`);
}

type RawPt = { lat?: number; lon?: number; ele?: number; dist?: number };

export function parseGpx(xml: string, fallbackName = 'route'): Route {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, isArray: (n) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept'].includes(n) });
  const doc = parser.parse(xml).gpx;
  if (!doc) throw new Error('Not a GPX file');
  const raw: RawPt[] = [];
  const push = (p: any) => raw.push({ lat: Number(p.lat), lon: Number(p.lon), ele: p.ele !== undefined ? Number(p.ele) : undefined });
  for (const trk of doc.trk ?? []) for (const seg of trk.trkseg ?? []) for (const p of seg.trkpt ?? []) push(p);
  if (!raw.length) for (const rte of doc.rte ?? []) for (const p of rte.rtept ?? []) push(p);
  const name = doc.trk?.[0]?.name ?? doc.rte?.[0]?.name ?? doc.metadata?.name ?? fallbackName;
  return buildRoute(String(name), raw);
}

export function parseFit(bytes: Uint8Array, fallbackName = 'route'): Route {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  if (!decoder.isFIT()) throw new Error('Not a FIT file');
  const { messages, errors } = decoder.read({ convertTypesToStrings: true });
  if (errors.length) throw new Error(`FIT decode: ${errors[0].message}`);
  const semi = 180 / 2 ** 31;
  const raw: RawPt[] = (messages.recordMesgs ?? []).map((r: any) => ({
    lat: r.positionLat !== undefined ? r.positionLat * semi : undefined,
    lon: r.positionLong !== undefined ? r.positionLong * semi : undefined,
    ele: r.enhancedAltitude ?? r.altitude,
    dist: r.distance,
  }));
  const name = messages.courseMesgs?.[0]?.name ?? fallbackName;
  return buildRoute(String(name), raw);
}

function buildRoute(name: string, raw: RawPt[]): Route {
  const pts: RoutePoint[] = [];
  let dist = 0;
  let lastEle = raw.find((p) => p.ele !== undefined)?.ele ?? 0;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const prev = pts[pts.length - 1];
    if (p.dist !== undefined) dist = p.dist;
    else if (prev && p.lat !== undefined && prev.lat !== undefined && p.lon !== undefined && prev.lon !== undefined) {
      dist += haversine(prev.lat, prev.lon, p.lat, p.lon);
    }
    if (p.ele !== undefined && Number.isFinite(p.ele)) lastEle = p.ele;
    if (prev && dist <= prev.dist) continue; // drop duplicates / stationary points
    pts.push({ dist, ele: lastEle, lat: p.lat, lon: p.lon });
  }
  if (pts.length < 2) throw new Error('Route has fewer than 2 usable points');
  let ascent = 0;
  for (let i = 1; i < pts.length; i++) ascent += Math.max(0, pts[i].ele - pts[i - 1].ele);
  return { name, points: pts, totalDist: pts[pts.length - 1].dist, ascent };
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
