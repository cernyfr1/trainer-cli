import type { Route } from '../../domain/route.js';

/** One course file format. */
export interface RouteParser {
  /** Lower-case file extensions incl. the dot; the first one is shown in error hints. */
  readonly extensions: readonly string[];
  parse(data: Uint8Array, fallbackName: string): Route;
}
