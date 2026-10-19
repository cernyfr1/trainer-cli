import type { Route } from '../../domain/route.js';
import type { FileFormat } from '../format-loader.js';

/** One course file format, parsed from raw bytes. */
export type RouteParser = FileFormat<Route, Uint8Array>;
