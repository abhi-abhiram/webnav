import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { defaultActionTimeout, pageState, settle, snapshot, type BrowserManager, type PageState } from "./browser.ts";
import { escape, items, navigation, pick } from "./helpers.ts";
import { log } from "./paths.ts";
import { siteKey, validateFunction, type FunctionContext, type SiteFunction, type Sites } from "./sites.ts";

export type RunOptions = {
  timeoutMs?: number;
  record?: boolean;
  // Reload the page before running, clearing leftover dialogs and half-filled forms.
  reset?: boolean;
  // Default timeout for each Playwright action or wait in this run, to fail fast.
  actionTimeoutMs?: number;
  // Aborts the run, e.g. when the MCP client cancels the request.
  signal?: AbortSignal;
  // Receives each ctx.log message while the run is going.
  onProgress?: (message: string) => void;
};
export type RunResult = {
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
  at?: string;
  aborted?: boolean;
  state?: PageState;
  snapshot?: string;
  screenshot?: string;
  dependents?: string[];
  video?: string;
};
export type RunStatus = { site: string; name: string; elapsed_ms: number; url: string; log: string[] };

type Current = { site: string; name: string; start: number; page: Page; log: string[]; abort: AbortController };

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// Rejects when the signal aborts, so a run can stop waiting for a function that does not return.
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
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
  // Retrieval functions return real data; only guard against runaway output.
  return text.length > 100_000 ? text.slice(0, 100_000) + "… truncated" : value;
}

export class Runner {
  private sites: Sites;
  private browser: BrowserManager;
  private dataDir: string;
  private current: Current | null = null;
  constructor(sites: Sites, browser: BrowserManager, dataDir: string) {
    this.sites = sites;
    this.browser = browser;
    this.dataDir = dataDir;
  }

  // What is running now, for fn_status.
  status(): RunStatus | null {
    const c = this.current;
    if (!c) return null;
    return { site: c.site, name: c.name, elapsed_ms: Date.now() - c.start, url: c.page.isClosed() ? "" : c.page.url(), log: c.log.slice(-20) };
  }

  // Stops the running function, for fn_abort. Returns what was stopped.
  abort(reason = "aborted by fn_abort"): RunStatus | null {
    const status = this.status();
    this.current?.abort.abort(new Error(reason));
    return status;
  }

  private async execute(site: string, label: string, fn: SiteFunction, args: Record<string, unknown>, opts: RunOptions): Promise<RunResult> {
    const key = siteKey(site);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    // Stacks show plain paths (Playwright) or file URLs (Node), so match both.
    const roots = [this.sites.dir(key), join(this.dataDir, "tmp")].flatMap(p => [p, pathToFileURL(p).href]);
    return this.browser.use(async (page: Page) => {
      const start = Date.now();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      const cancelled = () => abort.abort(new Error("cancelled by the client"));
      opts.signal?.addEventListener("abort", cancelled, { once: true });
      const current: Current = { site: key, name: label, start, page, log: [], abort };
      this.current = current;
      const sites = this.sites;
      const ui = await sites.loadUi(key);
      const stack: string[] = [label];
      const nav = navigation(page, key);
      const context = (a: Record<string, unknown>): FunctionContext => ({
        page, args: a, ui, site: key, call, items, escape, pick, ...nav,
        log: (...parts) => {
          const message = `${stack.at(-1)}: ${parts.map(String).join(" ")}`;
          log(`${key}/${message}`);
          current.log.push(message);
          if (current.log.length > 200) current.log.shift();
          opts.onProgress?.(message);
        },
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
      if (opts.actionTimeoutMs) page.setDefaultTimeout(opts.actionTimeoutMs);
      try {
        if (opts.reset && page.url() !== "about:blank") {
          await page.reload();
          await settle(page);
        }
        if (opts.record) {
          await mkdir(join(this.dataDir, "videos"), { recursive: true });
          video = join(this.dataDir, "videos", `${key}-${label}-${stamp()}.webm`);
          await page.screencast.start({ path: video });
          const shown = await page.screencast.showActions({ cursor: "pointer" });
          stopActions = () => shown.dispose();
        }
        // After an abort the function keeps running until its page calls fail; whichever promise
        // loses the race must not become an unhandled rejection.
        const running = fn.run(context(args));
        const stopped = untilAborted(abort.signal);
        running.catch(() => {});
        stopped.catch(() => {});
        const result = await Promise.race([running, stopped]);
        return { ok: true, ms: Date.now() - start, result: compact(result), state: await pageState(page), video };
      } catch (error) {
        const aborted = abort.signal.aborted;
        const failed: RunResult = {
          ok: false,
          ms: Date.now() - start,
          error: String((error as Error)?.message ?? error).replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 6).join("\n"),
          at: locate(error, roots),
          ...(aborted ? { aborted: true } : {}),
          video,
        };
        failed.state = await pageState(page).catch(() => undefined);
        failed.snapshot = await snapshot(page, { maxChars: 6_000 }).catch(() => undefined);
        await mkdir(join(this.dataDir, "screenshots"), { recursive: true });
        const shot = join(this.dataDir, "screenshots", `${key}-${label}-${stamp()}.png`);
        failed.screenshot = await page.screenshot({ path: shot }).then(() => shot, () => undefined);
        if (aborted) {
          // The function may still be running; closing its tab makes its pending and later
          // Playwright calls fail, so it cannot keep driving the browser or holding the lock.
          await stopActions?.().catch(() => {});
          if (opts.record) await page.screencast.stop().catch(() => {});
          await this.browser.discardTab();
          failed.error += "\nstopped the function by closing its tab; the next call opens a new one";
        }
        return failed;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", cancelled);
        if (this.current === current) this.current = null;
        if (opts.actionTimeoutMs && !page.isClosed()) page.setDefaultTimeout(defaultActionTimeout);
        await stopActions?.().catch(() => {});
        if (opts.record && !page.isClosed()) await page.screencast.stop().catch(() => {});
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
