import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Route } from '../../domain/route.js';
import { parseFit } from './fit.js';
import { parseGpx } from './gpx.js';

export async function loadRoute(path: string): Promise<Route> {
  const ext = extname(path).toLowerCase();
  if (ext === '.gpx') return parseGpx(await readFile(path, 'utf8'), basename(path, ext));
  if (ext === '.fit') return parseFit(new Uint8Array(await readFile(path)), basename(path, ext));
  throw new Error(`Unsupported route format "${ext}" — use .gpx or .fit`);
}
