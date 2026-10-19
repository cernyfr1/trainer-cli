import { Decoder, Stream } from '@garmin/fitsdk';
import { Route, type RawRoutePoint } from '../../domain/route.js';
import type { RouteParser } from './route-parser.js';

export class FitRouteParser implements RouteParser {
  readonly extensions = ['.fit'];

  parse(bytes: Uint8Array, fallbackName = 'route'): Route {
    const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
    if (!decoder.isFIT()) throw new Error('Not a FIT file');
    const { messages, errors } = decoder.read({ convertTypesToStrings: true });
    if (errors.length) throw new Error(`FIT decode: ${errors[0].message}`);
    const semi = 180 / 2 ** 31;
    const raw: RawRoutePoint[] = (messages.recordMesgs ?? []).map((r: any) => ({
      lat: r.positionLat !== undefined ? r.positionLat * semi : undefined,
      lon: r.positionLong !== undefined ? r.positionLong * semi : undefined,
      ele: r.enhancedAltitude ?? r.altitude,
      dist: r.distance,
    }));
    const name = messages.courseMesgs?.[0]?.name ?? fallbackName;
    return Route.fromPoints(String(name), raw);
  }
}
