import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { defaultActionTimeout, pageState, settle, snapshot, type BrowserManager, type PageState } from "./browser.ts";
import { escape, items, navigation, pick } from "./helpers.ts";
import { log } from "./paths.ts";
import { siteKey, validateFunction, type FunctionContext, type SiteFunction, type Sites } from "./sites.ts";
import { assertSchema, canonical } from "./contracts.ts";
import { Artifacts, json, type OutputOptions } from "./artifacts.ts";
import { assertEffect, assertUrl, PolicyError, withPolicy } from "./policy.ts";

export type RunOptions = OutputOptions & {
  approved?: boolean;
  fresh?: boolean;
  diagnostics?: "compact" | "full";
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
  artifact?: { id: string; chars: number };
  result_omitted?: boolean;
  result_chars?: number;
  preview?: string;
  output_error?: string;
  retry_warning?: string;
  cached?: boolean;
  cache_age_ms?: number;
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

export type CheckOptions = Pick<RunOptions, "timeoutMs" | "actionTimeoutMs" | "signal" | "onProgress" | "diagnostics"> & { names?: string[] };
export type CheckResult = Pick<RunResult, "ok" | "ms" | "error" | "at" | "snapshot" | "screenshot" | "artifact"> & { name: string; skipped?: string };

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

// An open dialog is usually what a failed step was working in, so it leads the failure snapshot
// and is never cut off by a long page.
async function failureSnapshot(page: Page): Promise<string> {
  const parts: string[] = [];
  const dialogs = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible, dialog[open]');
  const count = Math.min(await dialogs.count().catch(() => 0), 3);
  for (let i = 0; i < count; i++) {
    const tree = await dialogs.nth(i).ariaSnapshot({ mode: "ai", timeout: 5_000 }).catch(() => "");
    if (tree) parts.push(tree.length > 6_000 ? tree.slice(0, 6_000) + "\n… truncated" : tree);
  }
  const pageTree = await snapshot(page, { maxChars: 6_000 }).catch(() => "");
  if (!parts.length) return pageTree;
  return `open dialogs:\n${parts.join("\n")}\n\npage:\n${pageTree}`;
}

export class Runner {
  private sites: Sites;
  private browser: BrowserManager;
  private dataDir: string;
  private current: Current | null = null;
  private artifacts: Artifacts;
  private cache = new Map<string, { site: string; at: number; expires: number; text: string; state?: PageState }>();
  constructor(sites: Sites, browser: BrowserManager, dataDir: string) {
    this.sites = sites;
    this.browser = browser;
    this.dataDir = dataDir;
    this.artifacts = new Artifacts(dataDir);
  }

  // Bumped on every invalidation, so a read that was already running cannot cache a result
  // that a later write (or browser interaction) has made stale.
  private generation = 0;
  clearCache(site?: string): number {
    this.generation++;
    let removed = 0;
    for (const [key, entry] of this.cache) if (!site || entry.site === siteKey(site)) { this.cache.delete(key); removed++; }
    return removed;
  }

  async diagnostics(site: string) {
    const key = siteKey(site), policy = await this.sites.policy(key);
    return this.browser.use(page => withPolicy(page, key, policy, async scoped => {
      assertUrl(key, policy, page.url());
      return { state: await pageState(scoped), snapshot: await failureSnapshot(scoped) };
    }));
  }

  private async publish(result: RunResult, opts: RunOptions): Promise<RunResult> {
    if (!result.ok) return result;
    const { result: value, ...rest } = result;
    try { return { ...rest, ...await this.artifacts.output(value, opts) }; }
    catch (error) {
      // Preserve recoverable output even if a requested projection was wrong; never replay.
      let artifact: RunResult["artifact"];
      try { if (value !== undefined) artifact = await this.artifacts.save(json(value)); } catch {}
      return { ...rest, ...(artifact ? { artifact } : {}), result_omitted: true, output_error: `${(error as Error).message}; function already completed, do not retry a write` };
    }
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
    if (opts.signal?.aborted) throw new Error("cancelled by the client");
    const policy = await this.sites.policy(key);
    assertEffect(policy, fn.meta.effect, fn.meta.safe, opts.approved);
    assertSchema(fn.meta.argsSchema, args, `${label} arguments`);
    // Stacks show plain paths (Playwright) or file URLs (Node), so match both.
    const roots = [this.sites.dir(key), join(this.dataDir, "tmp")].flatMap(p => [p, pathToFileURL(p).href]);
    const writes = fn.meta.effect !== "read";
    return this.browser.use(async (page: Page) => {
      // Invalidate inside the lock too: reads that held it before this write may have cached since.
      if (writes) this.clearCache(key);
      const start = Date.now();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      const cancelled = () => abort.abort(new Error("cancelled by the client"));
      opts.signal?.addEventListener("abort", cancelled, { once: true });
      const current: Current = { site: key, name: label, start, page, log: [], abort };
      this.current = current;
      const sites = this.sites;
      let ui: Record<string, any> = {};
      let guardedPage = page;
      // Preserve returned test findings on explicit request even if validation/verify fails.
      let completed: { value: unknown } | undefined;
      const stack: string[] = [label];
      // Effects of the functions currently running, so a write anywhere beneath a read fails.
      const effects: (string | undefined)[] = [];
      const context = (a: Record<string, unknown>): FunctionContext => ({
        page: guardedPage, args: a, ui, site: key, call, items, escape, pick, ...navigation(guardedPage, key),
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
          return await invoke(await sites.load(key, name), a, name);
        } finally {
          stack.pop();
        }
      }
      async function invoke(target: SiteFunction, a: Record<string, unknown>, name: string) {
        assertEffect(policy, target.meta.effect, target.meta.safe, opts.approved);
        if (effects.includes("read") && target.meta.effect === "write") throw new Error("read functions cannot call write functions");
        assertSchema(target.meta.argsSchema, a, `${name} arguments`);
        const ctx = context(a);
        effects.push(target.meta.effect);
        let value: unknown, verified: unknown;
        try {
          value = await target.run(ctx);
          if (stack.length === 1) completed = { value };
          assertSchema(target.meta.resultSchema, value, `${name} result`);
          verified = await target.verify?.(ctx, value);
        } finally { effects.pop(); }
        if (verified === false) throw new Error(`${name} postcondition failed`);
        if (verified !== undefined && verified !== true) throw new Error(`${name}.verify must return void or boolean`);
        return value;
      }
      let video: string | undefined;
      let stopActions: (() => Promise<void>) | undefined;
      if (opts.actionTimeoutMs) page.setDefaultTimeout(opts.actionTimeoutMs);
      try {
        // Scope reset/record setup too: a reload may redirect, and setup must share the timeout.
        const running = withPolicy(page, key, policy, async scoped => {
          guardedPage = scoped;
          ui = await sites.loadUi(key);
          if (opts.reset || opts.record) assertUrl(key, policy, page.url());
          if (opts.reset && page.url() !== "about:blank") {
            await scoped.reload();
            await settle(scoped);
          }
          if (opts.record) {
            await mkdir(join(this.dataDir, "videos"), { recursive: true, mode: 0o700 });
            video = join(this.dataDir, "videos", `${key}-${label}-${stamp()}.webm`);
            await scoped.screencast.start({ path: video });
            const shown = await scoped.screencast.showActions({ cursor: "pointer" });
            stopActions = () => shown.dispose();
          }
          if (abort.signal.aborted) throw abort.signal.reason;
          const result = await invoke(fn, args, label);
          return { result, state: await pageState(scoped) };
        });
        // A losing promise must not become an unhandled rejection after abort closes its tab.
        const stopped = untilAborted(abort.signal);
        running.catch(() => {});
        stopped.catch(() => {});
        const result = await Promise.race([running, stopped]);
        return { ok: true, ms: Date.now() - start, ...result, video };
      } catch (error) {
        const aborted = abort.signal.aborted;
        const failed: RunResult = {
          ok: false,
          ms: Date.now() - start,
          error: String((error as Error)?.message ?? error).replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 6).join("\n").slice(0, 2000),
          at: locate(error, roots),
          ...(fn.meta.effect !== "read" && !fn.meta.safe ? { retry_warning: "Writes may already have occurred. Inspect current state; do not automatically retry." } : {}),
          ...(aborted ? { aborted: true } : {}),
          video,
        };
        if (completed && opts.storeResult && !(error instanceof PolicyError)) {
          try { failed.artifact = await this.artifacts.save(json(completed.value)); } catch {} // Never replace the original failure.
        }
        // Never capture DOM/title/screenshots from a policy-denied page.
        let permitted = !(error instanceof PolicyError);
        try { assertUrl(key, policy, page.url()); } catch { permitted = false; }
        failed.state = permitted ? await pageState(page).catch(() => undefined) : { url: page.url(), title: "", login_suspected: false };
        if (permitted && opts.diagnostics === "full") {
          failed.snapshot = await failureSnapshot(page);
          await mkdir(join(this.dataDir, "screenshots"), { recursive: true, mode: 0o700 });
          const shot = join(this.dataDir, "screenshots", `${key}-${label}-${stamp()}.png`);
          failed.screenshot = await page.screenshot({ path: shot }).then(() => shot, () => undefined);
        }
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
        if (writes) this.clearCache(key);
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
    if (opts.signal?.aborted) throw new Error("cancelled by the client");
    const fn = await this.sites.load(site, name);
    assertEffect(await this.sites.policy(siteKey(site)), fn.meta.effect, fn.meta.safe, opts.approved);
    assertSchema(fn.meta.argsSchema, args, `${name} arguments`);
    const cacheable = fn.meta.effect === "read" && fn.meta.cacheTtlMs !== undefined;
    const cacheKey = cacheable ? canonical([siteKey(site), name, await this.sites.fingerprint(site), args]) : "";
    const entry = this.cache.get(cacheKey);
    if (entry && entry.expires > Date.now() && !opts.fresh && !opts.reset && !opts.record) {
      return this.publish({ ok: true, ms: 0, result: JSON.parse(entry.text), state: entry.state, cached: true, cache_age_ms: Date.now() - entry.at }, opts);
    }
    if (fn.meta.effect !== "read") this.clearCache(site);
    const generation = this.generation;
    const result = await this.execute(site, name, fn, args, opts);
    if (result.ok && cacheable && generation === this.generation && result.result !== undefined && !opts.record) {
      try {
        const text = json(result.result), at = Date.now();
        if (text.length <= 1_000_000) {
          this.cache.set(cacheKey, { site: siteKey(site), at, expires: at + fn.meta.cacheTtlMs!, text, state: result.state });
          while (this.cache.size > 64 || [...this.cache.values()].reduce((n, e) => n + e.text.length, 0) > 8_000_000) this.cache.delete(this.cache.keys().next().value!);
        }
      } catch {} // Non-JSON output is reported by publish, never cached.
    }
    if (!result.ok) result.dependents = await this.sites.dependents(site, name);
    await this.sites.recordRun(site, {
      t: new Date().toISOString(), name, ok: result.ok, ms: result.ms,
      ...(result.error ? { error: result.error.split("\n")[0] } : {}), url: result.state?.url,
    });
    return this.publish(result, opts);
  }

  // Runs unsaved code so an agent can iterate before fn_save.
  async try(site: string, code: string, args: Record<string, unknown> = {}, opts: RunOptions = {}): Promise<RunResult> {
    const dir = join(this.dataDir, "tmp");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `try-${randomUUID()}.ts`);
    await writeFile(file, code);
    try {
      const fn = validateFunction(await import(pathToFileURL(file).href), "draft");
      this.clearCache(site);
      return await this.publish(await this.execute(site, "draft", fn, args, opts), opts);
    } finally {
      await rm(file, { force: true });
    }
  }

  // Health check: runs every function marked meta.safe, with meta.example as arguments.
  async check(site: string, opts: CheckOptions = {}): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    const available = await this.sites.names(site);
    const names = opts.names ? [...new Set(opts.names)] : available;
    for (const name of names) if (!available.includes(name)) throw new Error(`unknown function ${name}; see site_get`);
    for (const name of names) {
      if (opts.signal?.aborted) throw new Error("cancelled by the client");
      let fn: SiteFunction;
      try {
        fn = await this.sites.load(site, name);
      } catch (error) {
        out.push({ name, ok: false, ms: 0, error: (error as Error).message });
        continue;
      }
      if (!fn.meta.safe) {
        if (opts.names) out.push({ name, ok: true, ms: 0, skipped: "not marked meta.safe; never run by fn_check" });
        continue;
      }
      // A schema distinguishes optional arguments from required ones; legacy params cannot.
      const needsArgs = fn.meta.argsSchema ? Array.isArray(fn.meta.argsSchema.required) && fn.meta.argsSchema.required.length > 0 : Object.keys(fn.meta.params ?? {}).length > 0;
      if (!fn.meta.example && needsArgs) {
        out.push({ name, ok: true, ms: 0, skipped: "has params but no meta.example" });
        continue;
      }
      try {
        const r = await this.run(site, name, fn.meta.example ?? {}, { ...opts, fresh: true });
        out.push({ name, ok: r.ok && !r.output_error, ms: r.ms,
          ...(r.error || r.output_error ? { error: r.error ?? r.output_error, at: r.at } : {}),
          ...(r.snapshot ? { snapshot: r.snapshot } : {}), ...(r.screenshot ? { screenshot: r.screenshot } : {}),
          ...(r.artifact ? { artifact: r.artifact } : {}),
        });
      } catch (error) { out.push({ name, ok: false, ms: 0, error: (error as Error).message }); }
    }
    return out;
  }
}
