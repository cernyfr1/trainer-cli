import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { RouteSource } from '../../application/ports.js';
import type { Route } from '../../domain/route.js';
import { FitRouteParser } from './fit.js';
import { GpxRouteParser } from './gpx.js';
import type { RouteParser } from './route-parser.js';

/** Picks a course parser by file extension. Add a format by adding a parser. */
export class RouteLoader implements RouteSource {
  constructor(private parsers: readonly RouteParser[] = [new GpxRouteParser(), new FitRouteParser()]) {}

  async load(path: string): Promise<Route> {
    const ext = extname(path).toLowerCase();
    const parser = this.parsers.find((p) => p.extensions.includes(ext));
    if (!parser) throw new Error(`Unsupported route format "${ext}" — use ${this.parsers.map((p) => p.extensions[0]).join(' or ')}`);
    return parser.parse(new Uint8Array(await readFile(path)), basename(path, ext));
  }
}
