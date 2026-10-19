import { readFile } from 'node:fs/promises';
import type { RouteSource } from '../../application/ports.js';
import type { Route } from '../../domain/route.js';
import { FormatLoader } from '../format-loader.js';
import { FitRouteParser } from './fit.js';
import { GpxRouteParser } from './gpx.js';
import type { RouteParser } from './route-parser.js';

/** Course files. Add a format by adding a parser. */
export class RouteLoader extends FormatLoader<Route, Uint8Array> implements RouteSource {
  constructor(parsers: readonly RouteParser[] = [new GpxRouteParser(), new FitRouteParser()]) { super('route', parsers); }

  protected async read(path: string) { return new Uint8Array(await readFile(path)); }
}
