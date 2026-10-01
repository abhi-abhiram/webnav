import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright-core";
import type { Item } from "./helpers.ts";

const exec = promisify(execFile);

// safe: no side effects, so fn_check may run it (with example args when it has params).
export type FunctionMeta = {
  description: string;
  params?: Record<string, string>;
  safe?: boolean;
  example?: Record<string, unknown>;
};
export type FunctionContext = {
  page: Page;
  args: Record<string, unknown>;
  call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  ui: Record<string, any>;
  site: string;
  log: (...parts: unknown[]) => void;
  origin: string;
  open: (path?: string) => Promise<void>;
  ensureOnSite: (path?: string) => Promise<void>;
  items: (scope: Locator, role?: string | RegExp, opts?: { depth?: number }) => Promise<Item[]>;
  escape: (text: string) => string;
  pick: (trigger: Locator, options: string | RegExp | (string | RegExp)[]) => Promise<void>;
};
export type SiteFunction = { meta: FunctionMeta; run: (ctx: FunctionContext) => Promise<unknown> };
export type RunRecord = { t: string; name: string; ok: boolean; ms: number; error?: string; url?: string };

const functionName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// A site is the URL host (port kept as _port), e.g. app.example.com or localhost_3000.
export function siteKey(input: string): string {
  const host = input.includes("://") ? new URL(input).host : input;
  const key = host.toLowerCase().replace(":", "_");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}(_\d{1,5})?$/.test(key) || key.includes("..")) throw new Error(`invalid site ${JSON.stringify(input)}`);
  return key;
}

function checkName(name: string): void {
  if (name !== "ui" && !functionName.test(name)) throw new Error(`invalid function name ${JSON.stringify(name)}: use letters, digits and _`);
}

// Node caches modules by URL; a content hash reloads edited files without restarting.
async function importFresh(file: string): Promise<any> {
  const source = await readFile(file, "utf8");
  const version = createHash("sha1").update(source).digest("hex").slice(0, 12);
  return import(pathToFileURL(file).href + "?v=" + version);
}

export function validateFunction(mod: any, label: string): SiteFunction {
  if (typeof mod?.run !== "function") throw new Error(`${label} must export async function run(ctx)`);
  if (typeof mod?.meta?.description !== "string") throw new Error(`${label} must export meta = { description: "..." }`);
  return mod as SiteFunction;
}

const notesTemplate = (site: string) => `# ${site}

## Map
<!-- page → what is there → how to reach it -->

## Quirks
`;

const uiTemplate = `import type { Locator, Page } from "playwright-core";
import type { Item } from "./helpers.ts";

// Shared locators for this site. When the UI changes, fix them here once.
export const ui = {
  // mainNav: (page: Page) => page.getByRole("navigation", { name: "Main" }),
};
`;

export class Sites {
  private configDir: string;
  private dataDir: string;
  constructor(configDir: string, dataDir: string) {
    this.configDir = configDir;
    this.dataDir = dataDir;
  }

  dir(site: string): string {
    return join(this.configDir, "sites", siteKey(site));
  }

  private file(site: string, name: string): string {
    checkName(name);
    return name === "ui" ? join(this.dir(site), "ui.ts") : join(this.dir(site), "functions", `${name}.ts`);
  }

  private async git(site: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-c", "user.name=webnav", "-c", "user.email=webnav@localhost", ...args], { cwd: this.dir(site) });
    return stdout.trim();
  }

  private async commit(site: string, message: string): Promise<string | null> {
    await this.git(site, "add", "-A");
    const staged = await this.git(site, "diff", "--cached", "--name-only");
    if (!staged) return null;
    await this.git(site, "commit", "-q", "-m", message);
    return this.git(site, "rev-parse", "--short", "HEAD");
  }

  async ensure(site: string): Promise<string> {
    const key = siteKey(site);
    const dir = this.dir(key);
    await mkdir(join(dir, "functions"), { recursive: true });
    if (!existsSync(join(dir, ".git"))) await this.git(key, "init", "-q");
    if (!existsSync(join(dir, "notes.md"))) await writeFile(join(dir, "notes.md"), notesTemplate(key));
    if (!existsSync(join(dir, "ui.ts"))) await writeFile(join(dir, "ui.ts"), uiTemplate);
    await this.commit(key, "chore: start site");
    return key;
  }

  async list(): Promise<{ site: string; functions: number }[]> {
    const root = join(this.configDir, "sites");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries.filter(e => e.isDirectory())) out.push({ site: e.name, functions: (await this.names(e.name)).length });
    return out;
  }

  async notes(site: string): Promise<string> {
    return readFile(join(this.dir(site), "notes.md"), "utf8").catch(() => "");
  }

  async writeNotes(site: string, markdown: string, message?: string): Promise<string | null> {
    const key = await this.ensure(site);
    await writeFile(join(this.dir(key), "notes.md"), markdown);
    return this.commit(key, `notes: ${message ?? "update"}`);
  }

  async names(site: string): Promise<string[]> {
    const files = await readdir(join(this.dir(site), "functions")).catch(() => [] as string[]);
    return files.filter(f => f.endsWith(".ts")).map(f => f.slice(0, -3)).sort();
  }

  async read(site: string, name: string, revision?: string): Promise<string> {
    const file = this.file(site, name);
    if (!revision) return readFile(file, "utf8");
    const path = name === "ui" ? "ui.ts" : `functions/${name}.ts`;
    return this.git(site, "show", `${revision}:${path}`);
  }

  async history(site: string, name?: string, limit = 20): Promise<string> {
    const path = name ? [this.file(site, name)] : [];
    return this.git(site, "log", `-${limit}`, "--format=%h %ad %s", "--date=short", "--", ...path);
  }

  async load(site: string, name: string): Promise<SiteFunction> {
    if (name === "ui") throw new Error("ui is not a function");
    const file = this.file(site, name);
    if (!existsSync(file)) throw new Error(`unknown function ${name}; see site_get`);
    return validateFunction(await importFresh(file), name);
  }

  async loadUi(site: string): Promise<Record<string, any>> {
    const file = this.file(site, "ui");
    if (!existsSync(file)) return {};
    const mod = await importFresh(file);
    if (typeof mod.ui !== "object" || mod.ui === null) throw new Error("ui.ts must export const ui = { ... }");
    return mod.ui;
  }

  // Writes, validates by importing, and commits. Invalid code is rolled back.
  async save(site: string, name: string, code: string, message?: string): Promise<{ commit: string | null; warnings: string[] }> {
    const key = await this.ensure(site);
    const file = this.file(key, name);
    const previous = existsSync(file) ? await readFile(file, "utf8") : null;
    await writeFile(file, code);
    try {
      if (name === "ui") await this.loadUi(key);
      else await this.load(key, name);
    } catch (error) {
      if (previous === null) await rm(file, { force: true });
      else await writeFile(file, previous);
      throw new Error(`not saved: ${(error as Error).message}`);
    }
    const warnings: string[] = [];
    if (name !== "ui" && !/waitFor|expect\(|toBeVisible|toHaveURL|items\(/.test(code)) {
      warnings.push("no final wait found: end with a wait that proves the result (e.g. a heading or row .waitFor())");
    }
    const verb = previous === null ? "add" : "update";
    const commit = await this.commit(key, `${name === "ui" ? "ui" : `fn(${name})`}: ${message ?? verb}`);
    return { commit, warnings };
  }

  async remove(site: string, name: string, message?: string): Promise<string | null> {
    if (name === "ui") throw new Error("ui.ts cannot be deleted; empty it instead");
    await rm(this.file(site, name), { force: true });
    return this.commit(siteKey(site), `fn(${name}): ${message ?? "remove"}`);
  }

  async dependents(site: string, name: string): Promise<string[]> {
    const out: string[] = [];
    const call = new RegExp(`call\\(\\s*["'\`]${name}["'\`]`);
    for (const other of await this.names(site)) {
      if (other !== name && call.test(await this.read(site, other))) out.push(other);
    }
    return out;
  }

  private runsFile(site: string): string {
    return join(this.dataDir, "runs", `${siteKey(site)}.jsonl`);
  }

  async recordRun(site: string, run: RunRecord): Promise<void> {
    await mkdir(join(this.dataDir, "runs"), { recursive: true });
    await appendFile(this.runsFile(site), JSON.stringify(run) + "\n");
  }

  async lastRuns(site: string): Promise<Map<string, RunRecord>> {
    const text = await readFile(this.runsFile(site), "utf8").catch(() => "");
    const last = new Map<string, RunRecord>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const run = JSON.parse(line) as RunRecord;
        last.set(run.name, run);
      } catch {}
    }
    return last;
  }

  async describe(site: string) {
    const key = siteKey(site);
    const runs = await this.lastRuns(key);
    const functions = [];
    for (const name of await this.names(key)) {
      const run = runs.get(name);
      const last_run = run ? { ok: run.ok, at: run.t, ...(run.error ? { error: run.error } : {}) } : null;
      try {
        const { meta } = await this.load(key, name);
        functions.push({ name, ...meta, last_run });
      } catch (error) {
        functions.push({ name, load_error: (error as Error).message, last_run });
      }
    }
    return {
      site: key,
      exists: existsSync(this.dir(key)),
      dir: this.dir(key),
      notes: await this.notes(key),
      ui: await readFile(this.file(key, "ui"), "utf8").catch(() => ""),
      functions,
    };
  }
}
