import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Onion dependency rule: dependencies point inwards only.
 *   presentation → application → domain
 *   infrastructure → application, domain
 * Domain uses no packages at all; application only node:events.
 */
const SRC = resolve('src');
const LAYERS = ['domain', 'application', 'infrastructure', 'presentation'] as const;
type Layer = typeof LAYERS[number];

const ALLOWED: Record<Layer, Layer[]> = {
  domain: ['domain'],
  application: ['domain', 'application'],
  infrastructure: ['domain', 'application', 'infrastructure'],
  presentation: ['domain', 'application', 'infrastructure', 'presentation'],
};
const ALLOWED_PACKAGES: Partial<Record<Layer, string[]>> = {
  domain: [],
  application: ['node:events'],
};

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);

const layerOf = (file: string) => relative(SRC, file).split(/[\\/]/)[0] as Layer;
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\b(?:[^'"]*?from)?\s*['"]([^'"]+)['"]/gm)]
  .map((m) => m[1]);

describe('architecture', () => {
  it('every source file lives in a layer', () => {
    const stray = files(SRC).filter((f) => !LAYERS.includes(layerOf(f)));
    expect(stray.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('dependencies point inwards', () => {
    const violations: string[] = [];
    for (const file of files(SRC)) {
      const from = layerOf(file);
      for (const spec of importsOf(file)) {
        const name = relative(SRC, file);
        if (spec.startsWith('.')) {
          const to = layerOf(resolve(dirname(file), spec));
          if (!ALLOWED[from].includes(to)) violations.push(`${name} → ${spec} (${from} must not depend on ${to})`);
        } else {
          const allowed = ALLOWED_PACKAGES[from];
          if (allowed && !allowed.includes(spec)) violations.push(`${name} → ${spec} (no packages in ${from})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
