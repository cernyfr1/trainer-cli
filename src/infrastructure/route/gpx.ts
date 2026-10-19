import { XMLParser } from 'fast-xml-parser';
import { Route, type RawRoutePoint } from '../../domain/route.js';
import type { RouteParser } from './route-parser.js';

export class GpxRouteParser implements RouteParser {
  readonly extensions = ['.gpx'];

  parse(data: Uint8Array, fallbackName = 'route'): Route {
    const xml = new TextDecoder().decode(data);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, isArray: (n) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept'].includes(n) });
    const doc = parser.parse(xml).gpx;
    if (!doc) throw new Error('Not a GPX file');
    const raw: RawRoutePoint[] = [];
    const push = (p: any) => raw.push({ lat: Number(p.lat), lon: Number(p.lon), ele: p.ele !== undefined ? Number(p.ele) : undefined });
    for (const trk of doc.trk ?? []) for (const seg of trk.trkseg ?? []) for (const p of seg.trkpt ?? []) push(p);
    if (!raw.length) for (const rte of doc.rte ?? []) for (const p of rte.rtept ?? []) push(p);
    const name = doc.trk?.[0]?.name ?? doc.rte?.[0]?.name ?? doc.metadata?.name ?? fallbackName;
    return Route.fromPoints(String(name), raw);
  }
}
