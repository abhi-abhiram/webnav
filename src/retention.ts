import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./paths.ts";

const day = 86_400_000;
// Run logs above this many lines are compacted at startup.
const maxRunLines = 5_000;
const keepRunLines = 1_000;

async function pruneDir(dir: string, maxAgeMs: number): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = join(dir, e.name);
    const info = await stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs) { await rm(file, { force: true }); removed++; }
  }
  return removed;
}

// Keeps the latest lines plus the last record of every function, so site_get's last_run survives.
export function compactRunLog(text: string): string | null {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxRunLines) return null;
  const keep = new Set<number>();
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    let name: unknown;
    try { name = JSON.parse(lines[i]).name; } catch { continue; }
    if (i >= lines.length - keepRunLines || (typeof name === "string" && !seen.has(name))) keep.add(i);
    if (typeof name === "string") seen.add(name);
  }
  return [...keep].sort((a, b) => a - b).map(i => lines[i]).join("\n") + "\n";
}

// Artifacts, screenshots and videos are evidence for recent runs, not an archive. Drafts left in
// tmp by a crash are removed after a day. Site folders (notes, functions) are never touched.
export async function prune(dataDir: string, retentionDays: number): Promise<void> {
  let removed = await pruneDir(join(dataDir, "tmp"), day);
  if (retentionDays > 0) {
    for (const sub of ["artifacts", "screenshots", "videos"]) removed += await pruneDir(join(dataDir, sub), retentionDays * day);
  }
  const runs = join(dataDir, "runs");
  for (const name of await readdir(runs).catch(() => [] as string[])) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(runs, name);
    const compacted = compactRunLog(await readFile(file, "utf8").catch(() => ""));
    if (compacted !== null) await writeFile(file, compacted);
  }
  if (removed) log(`removed ${removed} old files from ${dataDir}`);
}
