import { basename, extname } from 'node:path';

/** One file format: which extensions it claims, and how to turn file contents into T. */
export interface FileFormat<T, Data> {
  /** Lower-case extensions incl. the dot; the first one is shown in error hints. */
  readonly extensions: readonly string[];
  parse(data: Data, fallbackName: string): T;
}

/** Loads a file by picking the format that claims its extension. Subclasses decide how to read the file. */
export abstract class FormatLoader<T, Data> {
  constructor(private what: string, private formats: readonly FileFormat<T, Data>[]) {}

  protected abstract read(path: string): Promise<Data>;

  async load(path: string): Promise<T> {
    const ext = extname(path).toLowerCase();
    const format = this.formats.find((f) => f.extensions.includes(ext));
    if (!format) throw new Error(`Unsupported ${this.what} format "${ext}" — use ${this.formats.map((f) => f.extensions[0]).join(' or ')}`);
    return format.parse(await this.read(path), basename(path, ext));
  }
}
