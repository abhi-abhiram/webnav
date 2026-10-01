import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { pageState, snapshot, type BrowserManager, type PageState } from "./browser.ts";
import { escape, items, navigation } from "./helpers.ts";
import { log } from "./paths.ts";
import { siteKey, validateFunction, type FunctionContext, type SiteFunction, type Sites } from "./sites.ts";

export type RunOptions = { timeoutMs?: number; record?: boolean };
export type RunResult = {
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
  at?: string;
  state?: PageState;
  snapshot?: string;
  screenshot?: string;
  dependents?: string[];
  video?: string;
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Point at the line inside the site's own code, not Playwright internals.
function locate(error: unknown, roots: string[]): string | undefined {
  const stack = (error as Error)?.stack ?? "";
  for (const line of stack.split("\n")) {
    if (!roots.some(r => line.includes(r))) continue;
    const m = line.match(/([^/\s(]+\.ts)(?:\?[^:]*)?:(\d+):\d+/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return undefined;
}

function compact(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 4000 ? text.slice(0, 4000) + "… truncated" : value;
}

export class Runner {
  private sites: Sites;
  private browser: BrowserManager;
  private dataDir: string;
  constructor(sites: Sites, browser: BrowserManager, dataDir: string) {
    this.sites = sites;
    this.browser = browser;
    this.dataDir = dataDir;
  }

  private async execute(site: string, label: string, fn: SiteFunction, args: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const key = siteKey(site);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    // Stacks show plain paths (Playwright) or file URLs (Node), so match both.
    const roots = [this.sites.dir(key), join(this.dataDir, "tmp")].flatMap(p => [p, pathToFileURL(p).href]);
    return this.browser.use(async (page: Page) => {
      const start = Date.now();
      const sites = this.sites;
      const ui = await sites.loadUi(key);
      const stack: string[] = [label];
      const nav = navigation(page, key);
      const context = (a: Record<string, unknown>): FunctionContext => ({
        page, args: a, ui, site: key, call, items, escape, ...nav,
        log: (...parts) => log(`${key}/${stack.at(-1)}:`, ...parts),
      });
      async function call(name: string, a: Record<string, unknown> = {}): Promise<unknown> {
        if (stack.includes(name) || stack.length >= 8) throw new Error(`call loop: ${[...stack, name].join(" → ")}`);
        stack.push(name);
        try {
          return await (await sites.load(key, name)).run(context(a));
        } finally {
          stack.pop();
        }
      }
      let video: string | undefined;
      let stopActions: (() => Promise<void>) | undefined;
      if (opts.record) {
        await mkdir(join(this.dataDir, "videos"), { recursive: true });
        video = join(this.dataDir, "videos", `${key}-${label}-${stamp()}.webm`);
        await page.screencast.start({ path: video });
        const shown = await page.screencast.showActions({ cursor: "pointer" });
        stopActions = () => shown.dispose();
      }
      try {
        const result = await withTimeout(fn.run(context(args)), timeoutMs);
        return { ok: true, ms: Date.now() - start, result: compact(result), state: await pageState(page), video };
      } catch (error) {
        const failed: RunResult = {
          ok: false,
          ms: Date.now() - start,
          error: String((error as Error)?.message ?? error).replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 6).join("\n"),
          at: locate(error, roots),
          video,
        };
        failed.state = await pageState(page).catch(() => undefined);
        failed.snapshot = await snapshot(page, { maxChars: 6_000 }).catch(() => undefined);
        await mkdir(join(this.dataDir, "screenshots"), { recursive: true });
        const shot = join(this.dataDir, "screenshots", `${key}-${label}-${stamp()}.png`);
        failed.screenshot = await page.screenshot({ path: shot }).then(() => shot, () => undefined);
        return failed;
      } finally {
        await stopActions?.().catch(() => {});
        if (opts.record) await page.screencast.stop().catch(() => {});
      }
    }, timeoutMs + 30_000);
  }

  async run(site: string, name: string, args: Record<string, unknown> = {}, opts: RunOptions = {}): Promise<RunResult> {
    const fn = await this.sites.load(site, name);
    const result = await this.execute(site, name, fn, args, opts);
    if (!result.ok) result.dependents = await this.sites.dependents(site, name);
    await this.sites.recordRun(site, {
      t: new Date().toISOString(), name, ok: result.ok, ms: result.ms,
      ...(result.error ? { error: result.error.split("\n")[0] } : {}), url: result.state?.url,
    });
    return result;
  }

  // Runs unsaved code so an agent can iterate before fn_save.
  async try(site: string, code: string, args: Record<string, unknown> = {}, opts: RunOptions = {}): Promise<RunResult> {
    const dir = join(this.dataDir, "tmp");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `try-${randomUUID()}.ts`);
    await writeFile(file, code);
    try {
      const fn = validateFunction(await import(pathToFileURL(file).href), "draft");
      return await this.execute(site, "draft", fn, args, opts);
    } finally {
      await rm(file, { force: true });
    }
  }

  // Health check: runs every function marked meta.safe, with meta.example as arguments.
  async check(site: string): Promise<{ name: string; ok: boolean; ms: number; error?: string; at?: string; skipped?: string }[]> {
    const out: { name: string; ok: boolean; ms: number; error?: string; at?: string; skipped?: string }[] = [];
    for (const name of await this.sites.names(site)) {
      let fn: SiteFunction;
      try {
        fn = await this.sites.load(site, name);
      } catch (error) {
        out.push({ name, ok: false, ms: 0, error: (error as Error).message });
        continue;
      }
      if (!fn.meta.safe) continue;
      if (fn.meta.params && Object.keys(fn.meta.params).length && !fn.meta.example) {
        out.push({ name, ok: true, ms: 0, skipped: "has params but no meta.example" });
        continue;
      }
      const r = await this.run(site, name, fn.meta.example ?? {});
      out.push({ name, ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error, at: r.at } : {}) });
    }
    return out;
  }
}
