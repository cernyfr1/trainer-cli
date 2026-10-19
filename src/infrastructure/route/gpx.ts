import { XMLParser } from 'fast-xml-parser';
import { buildRoute, type RawRoutePoint, type Route } from '../../domain/route.js';

export function parseGpx(xml: string, fallbackName = 'route'): Route {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, isArray: (n) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept'].includes(n) });
  const doc = parser.parse(xml).gpx;
  if (!doc) throw new Error('Not a GPX file');
  const raw: RawRoutePoint[] = [];
  const push = (p: any) => raw.push({ lat: Number(p.lat), lon: Number(p.lon), ele: p.ele !== undefined ? Number(p.ele) : undefined });
  for (const trk of doc.trk ?? []) for (const seg of trk.trkseg ?? []) for (const p of seg.trkpt ?? []) push(p);
  if (!raw.length) for (const rte of doc.rte ?? []) for (const p of rte.rtept ?? []) push(p);
  const name = doc.trk?.[0]?.name ?? doc.rte?.[0]?.name ?? doc.metadata?.name ?? fallbackName;
  return buildRoute(String(name), raw);
}
