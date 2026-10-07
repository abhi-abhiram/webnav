import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ArtifactRef = { id: string; chars: number };
export type OutputOptions = { maxResultChars?: number; resultFields?: string[]; storeResult?: boolean };
export type OutputResult = { result?: unknown; artifact?: ArtifactRef; result_omitted?: boolean; result_chars?: number; preview?: string };
const maxArtifactChars = 10_000_000;

export function json(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("function result is not JSON serializable");
  if (text.length > maxArtifactChars) throw new Error("function result exceeds the 10 million character limit");
  return text;
}

// Select own properties only; never evaluate expressions or traverse object prototypes.
export function project(value: unknown, paths: string[]): Record<string, unknown> {
  return Object.fromEntries(paths.map(path => {
    const parts = path.split(".");
    if (!path || parts.some(p => !p || ["__proto__", "constructor", "prototype"].includes(p))) throw new Error(`invalid result field ${path}`);
    let selected: any = value;
    for (const part of parts) {
      if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, part)) throw new Error(`result field not found: ${path}`);
      selected = selected[part];
    }
    return [path, selected];
  }));
}

export class Artifacts {
  constructor(privateDir: string) { this.dir = join(privateDir, "artifacts"); }
  private dir: string;

  async save(text: string): Promise<ArtifactRef> {
    if (text.length > maxArtifactChars) throw new Error("artifact exceeds the 10 million character limit");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    await writeFile(join(this.dir, `${id}.json`), text, { mode: 0o600, flag: "wx" });
    return { id, chars: text.length };
  }

  async read(id: string, offset = 0, limit = 8000, find?: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error("invalid artifact id");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30_000) throw new Error("invalid artifact read bounds");
    const text = await readFile(join(this.dir, `${id}.json`), "utf8");
    if (find !== undefined) {
      if (!find || find.length > 500) throw new Error("find must contain 1–500 characters");
      const match = text.toLowerCase().indexOf(find.toLowerCase(), offset);
      if (match < 0) return { id, found: false, chars: text.length };
      offset = Math.max(0, match - 200);
    }
    const chunk = text.slice(offset, offset + limit);
    return { id, offset, chars: text.length, returned_chars: chunk.length, next_offset: offset + chunk.length < text.length ? offset + chunk.length : null, text: chunk };
  }

  async output(value: unknown, opts: OutputOptions = {}): Promise<OutputResult> {
    if (value === undefined) return {};
    const selected = opts.resultFields ? project(value, opts.resultFields) : value;
    const text = json(selected);
    const budget = opts.maxResultChars ?? 8000;
    if (!Number.isInteger(budget) || budget < 256 || budget > 100_000) throw new Error("max_result_chars must be 256–100000");
    const truncated = text.length > budget;
    const artifact = truncated || opts.storeResult ? await this.save(opts.resultFields ? json(value) : text) : undefined;
    return truncated
      ? { artifact, result_omitted: true, result_chars: text.length, preview: text.slice(0, Math.min(budget, 1000)) }
      : { result: selected, ...(artifact ? { artifact } : {}) };
  }
}
