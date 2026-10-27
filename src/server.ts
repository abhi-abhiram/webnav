import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { act, actions, pageState, settle, snapshot, snapshotChanges, type BrowserManager } from "./browser.ts";
import type { Runner, RunOptions } from "./runner.ts";
import { siteKey, type Sites } from "./sites.ts";
import { Artifacts } from "./artifacts.ts";
import { policySchema, withPolicy } from "./policy.ts";
import type { Page } from "playwright-core";

export const version = "0.1.0";

type Deps = { browser: BrowserManager; sites: Sites; runner: Runner; dataDir: string; browserTools: boolean };

const text = (value: unknown, ...more: string[]): CallToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ...more.filter(Boolean).map(t => ({ type: "text" as const, text: t })),
  ],
});

// Turns errors into tool errors and appends browser notices (things webnav did on its own).
function guarded(notices: () => string[]) {
  return <A, E>(fn: (args: A, extra: E) => Promise<CallToolResult>): ((args: A, extra: E) => Promise<CallToolResult>) => async (args, extra) => {
    let result: CallToolResult;
    try {
      result = await fn(args, extra);
    } catch (error) {
      result = { isError: true, content: [{ type: "text", text: (error as Error).message ?? String(error) }] };
    }
    const pending = notices();
    if (pending.length) result.content = [...result.content, { type: "text", text: `notices:\n- ${pending.join("\n- ")}` }];
    return result;
  };
}

type Extra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
};

// Cancellation and progress for long runs: a cancelled request stops the function, and each
// ctx.log message is sent as a progress notification when the client asked for progress.
function runControls(extra: Extra): RunOptions {
  const token = extra._meta?.progressToken;
  let progress = 0;
  return {
    signal: extra.signal,
    onProgress: token === undefined ? undefined : message => {
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } }).catch(() => {});
    },
  };
}

const site = z.string().describe("Site host such as app.example.com or localhost:3000, or any URL on it");
const fnName = z.string().describe('Function name (letters, digits, _), or "ui" for the shared locator file');
const args = z.record(z.string(), z.unknown()).optional().describe("Arguments passed to the function as ctx.args");
const runFlags = {
  approved: z.boolean().optional().describe("Explicit user approval for this run's writes when required by site policy"),
  fresh: z.boolean().optional().describe("Bypass an opt-in read cache (reset/record also bypass it)"),
  diagnostics: z.enum(["compact", "full"]).optional().describe("Failure diagnostics: compact error/state by default; full opts into DOM snapshot and screenshot capture"),
  max_result_chars: z.number().int().min(256).max(100_000).optional().describe("Inline JSON result budget (default 8000); overflow is stored privately and returned as an artifact reference"),
  result_fields: z.array(z.string().min(1)).max(50).optional().describe("Project own-property dot paths, e.g. count or coverage.complete; no expressions"),
  store_result: z.boolean().optional().describe("Store the full result privately even when it fits inline; retain returned findings when result validation/postconditions fail"),
  timeout_ms: z.number().int().min(1000).max(600_000).optional()
    .describe("Whole-run limit (default 60000). On timeout the function is stopped by closing its tab"),
  action_timeout_ms: z.number().int().min(500).max(120_000).optional()
    .describe("Limit for each Playwright action or wait (default 10000); lower it to fail fast"),
  reset: z.boolean().optional().describe("Reload the page first, clearing leftover dialogs and half-filled forms"),
};

export function createServer({ browser, sites, runner, dataDir, browserTools }: Deps): McpServer {
  const server = new McpServer({ name: "webnav", version });
  const artifacts = new Artifacts(dataDir);
  const scopedUse = <T>(signal: AbortSignal, target: string | undefined, fn: (page: Page) => Promise<T>) => browser.use(async page => {
    const run = async (scoped: Page) => {
      if (signal.aborted) throw new Error("cancelled by the client");
      return fn(scoped);
    };
    if (signal.aborted) throw new Error("cancelled by the client");
    const url = target ?? page.url();
    if (url === "about:blank") return run(page);
    const key = siteKey(url);
    return withPolicy(page, key, await sites.policy(key), run);
  });
  const safe = guarded(() => browser.takeNotices());
  const read = { readOnlyHint: true, openWorldHint: false };
  const live = { readOnlyHint: false, openWorldHint: true };

  if (browserTools) {
    server.registerTool("browser_open", {
      description: "Attach to your running browser (dedicated tab) and optionally go to a URL or move through history. Returns page state and an accessibility snapshot with [ref=…] handles.",
      inputSchema: {
        url: z.string().optional(),
        history: z.enum(["back", "forward", "reload"]).optional(),
        snapshot: z.boolean().optional().describe("Include the snapshot (default true)"),
        cdp_endpoint: z.string().optional()
          .describe("Switch this session to the browser at this local http:// or ws:// CDP endpoint, e.g. http://127.0.0.1:9222"),
      },
      annotations: live,
    }, safe(async (a, extra: Extra) => {
      if (extra.signal.aborted) throw new Error("cancelled by the client");
      if (a.cdp_endpoint) { await browser.attachTo(a.cdp_endpoint); runner.clearCache(); }
      const navigates = !!(a.url || a.history);
      if (navigates) runner.clearCache();
      try {
        return await scopedUse(extra.signal, a.url, async page => {
          if (a.url) await page.goto(a.url);
          else if (a.history === "back") await page.goBack();
          else if (a.history === "forward") await page.goForward();
          else if (a.history === "reload") await page.reload();
          await settle(page);
          return text(await pageState(page), a.snapshot === false ? "" : await snapshot(page));
        });
      } finally {
        // Redirects/reloads can change session state even when navigation fails.
        if (navigates) runner.clearCache();
      }
    }));

    server.registerTool("browser_snapshot", {
      description: "Accessibility tree of the current page with [ref=…] handles for browser_act. Use within/depth to read one part of a large page. Refs stay valid until that element changes.",
      inputSchema: {
        within: z.string().optional().describe('Playwright selector to snapshot only that part, e.g. role=navigation[name="Main"]'),
        depth: z.number().int().min(1).max(50).optional().describe("Limit tree depth"),
        max_chars: z.number().int().min(1000).max(100_000).optional(),
      },
      annotations: read,
    }, safe(async (a, extra: Extra) => scopedUse(extra.signal, undefined, async page =>
      text(await pageState(page), await snapshot(page, { within: a.within, depth: a.depth, maxChars: a.max_chars })))));

    server.registerTool("browser_act", {
      description: "Perform one interaction on the current page, by snapshot ref or Playwright selector, then return the new state and snapshot. press without a target sends the key to the page; scroll without a target scrolls by value pixels.",
      inputSchema: {
        action: z.enum(actions),
        approved: z.boolean().optional().describe("Explicit user approval when site policy requires it for browser interactions"),
        ref: z.string().optional().describe("Ref from the latest snapshot, e.g. e12"),
        selector: z.string().optional().describe('Playwright selector, e.g. role=button[name="Save"] or text=Billing'),
        value: z.string().optional().describe("Text for fill/type, key for press (e.g. Enter), option for select, pixels for scroll"),
        values: z.array(z.string()).optional().describe("Several options for select"),
        files: z.array(z.string()).optional().describe("Absolute file paths for upload"),
        snapshot: z.enum(["changes", "full", "none"]).optional()
          .describe("What to return afterwards: changes since the last snapshot (default), the full tree, or nothing"),
      },
      annotations: live,
    }, safe(async (a, extra: Extra) => scopedUse(extra.signal, undefined, async page => {
      const policy = page.url() === "about:blank" ? null : await sites.policy(siteKey(page.url()));
      if (policy?.require_write_approval && !a.approved) throw new Error("site policy requires approved: true for browser interactions");
      // Any interaction may change what cached reads return, even one that throws partway.
      try { await act(page, a); } finally { runner.clearCache(); }
      await settle(page);
      const mode = a.snapshot ?? "changes";
      const tree = mode === "none" ? "" : mode === "full" ? await snapshot(page) : await snapshotChanges(page);
      return text(await pageState(page), tree);
    })));

    server.registerTool("browser_screenshot", {
      description: "Screenshot of the current page. Prefer snapshots for finding elements; use this to check how something looks.",
      inputSchema: { full_page: z.boolean().optional() },
      annotations: read,
    }, safe(async (a, extra: Extra) => scopedUse(extra.signal, undefined, async page => {
      await mkdir(join(dataDir, "screenshots"), { recursive: true, mode: 0o700 });
      const path = join(dataDir, "screenshots", `shot-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: a.full_page });
      return {
        content: [
          { type: "image", data: (await readFile(path)).toString("base64"), mimeType: "image/png" },
          { type: "text", text: path },
        ],
      };
    })));
  }

  server.registerTool("site_list", {
    description: "Sites that have notes or functions.",
    inputSchema: {},
    annotations: read,
  }, safe(async () => text(await sites.list())));

  server.registerTool("site_get", {
    description: "Everything known about a site: notes, shared ui locators, and functions with their descriptions, params and last run. Read this before exploring.",
    inputSchema: { site },
    annotations: read,
  }, safe(async a => text(await sites.describe(a.site))));

  server.registerTool("site_write_notes", {
    description: "Replace the site's notes.md (map of pages, how to reach them, quirks). Committed to the site's git history. Read site_get first and keep what is still true.",
    inputSchema: { site, markdown: z.string(), message: z.string().optional().describe("Short commit message") },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, safe(async a => text({ commit: await sites.writeNotes(a.site, a.markdown, a.message) })));

  server.registerTool("site_set_policy", {
    description: "Set reviewed URL-scope patterns and optional write approval for a site, committed to its git history. Missing policy preserves existing behavior. Guards trusted browser operations; not a sandbox for local code.",
    inputSchema: { site, policy: policySchema, message: z.string().optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, safe(async a => text({ commit: await sites.writePolicy(a.site, a.policy, a.message), cache_cleared: runner.clearCache(a.site) })));

  server.registerTool("artifact_read", {
    description: "Read a private stored JSON result in bounded character slices without rerunning the function. Optional case-insensitive find locates a passage. IDs are generated by fn_run/fn_try; arbitrary file paths are not accepted.",
    inputSchema: { id: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(30_000).optional(), find: z.string().min(1).max(500).optional() },
    annotations: read,
  }, safe(async a => text(await artifacts.read(a.id, a.offset, a.limit, a.find))));

  server.registerTool("fn_cache_clear", {
    description: "Clear this process's opt-in read cache for one site or all sites. Writes and source/UI/policy changes already invalidate it; use fresh=true after login/account changes.",
    inputSchema: { site: site.optional() },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, safe(async a => text({ cleared: runner.clearCache(a.site) })));

  server.registerTool("fn_diagnostics", {
    description: "Inspect the current tab after a failure without rerunning the function or its side effects. Returns state and a bounded accessibility snapshot; policy-denied pages are not read. Timed-out runs have already closed their original tab.",
    inputSchema: { site },
    annotations: read,
  }, safe(async a => text(await runner.diagnostics(a.site))));

  server.registerTool("fn_read", {
    description: "Source of a function or of ui.ts, optionally at an earlier git revision (see site_history).",
    inputSchema: { site, name: fnName, revision: z.string().optional() },
    annotations: read,
  }, safe(async a => text(await sites.read(siteKey(a.site), a.name, a.revision))));

  server.registerTool("fn_save", {
    description: "Create or replace a function (or ui.ts). The module must export meta = { description, params?, safe? } and async function run({ page, args, call, ui, log }). It is imported to validate it, rolled back if invalid, and committed.",
    inputSchema: { site, name: fnName, code: z.string(), message: z.string().optional().describe("Short commit message, e.g. why it changed") },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, safe(async a => text(await sites.save(a.site, a.name, a.code, a.message))));

  server.registerTool("fn_delete", {
    description: "Delete a function. The deletion is committed and can be restored from site_history.",
    inputSchema: { site, name: fnName, message: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, safe(async a => text({ commit: await sites.remove(a.site, a.name, a.message) })));

  server.registerTool("site_history", {
    description: "Git history of the site's notes and functions, or of one function.",
    inputSchema: { site, name: fnName.optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: read,
  }, safe(async a => text(await sites.history(siteKey(a.site), a.name, a.limit) || "no history")));

  server.registerTool("fn_try", {
    description: "Run unsaved function code in the browser tab. Same module shape and ctx as saved functions. With save_as, the code is saved (like fn_save) only if the run succeeds.",
    inputSchema: {
      site, code: z.string(), args, ...runFlags,
      save_as: z.string().optional().describe("Function name to save under when the run succeeds"),
      message: z.string().optional().describe("Commit message used with save_as"),
    },
    annotations: live,
  }, safe(async (a, extra: Extra) => {
    const result = await runner.try(a.site, a.code, a.args, {
      timeoutMs: a.timeout_ms, actionTimeoutMs: a.action_timeout_ms, reset: a.reset, approved: a.approved, diagnostics: a.diagnostics,
      maxResultChars: a.max_result_chars, resultFields: a.result_fields, storeResult: a.store_result, ...runControls(extra),
    });
    if (!result.ok || result.output_error || !a.save_as) return text(result);
    try {
      return text({ ...result, saved: await sites.save(a.site, a.save_as, a.code, a.message) });
    } catch (error) {
      return text({ ...result, save_error: (error as Error).message ?? String(error),
        retry_warning: "Function already completed; only saving failed. Do not rerun to recover output." });
    }
  }));

  server.registerTool("fn_run", {
    description: "Run a saved function with contracts/postconditions, URL-scope policy and opt-in read caching. Defaults to bounded inline output/artifact overflow and compact errors. Use fn_diagnostics without rerunning, or diagnostics=full for snapshot/screenshot capture. record=true saves a webm.",
    inputSchema: {
      site, name: z.string(), args, ...runFlags,
      record: z.boolean().optional(),
    },
    annotations: live,
  }, safe(async (a, extra: Extra) => text(await runner.run(a.site, a.name, a.args, {
    timeoutMs: a.timeout_ms, actionTimeoutMs: a.action_timeout_ms, reset: a.reset, record: a.record, approved: a.approved, fresh: a.fresh, diagnostics: a.diagnostics,
    maxResultChars: a.max_result_chars, resultFields: a.result_fields, storeResult: a.store_result, ...runControls(extra),
  }))));

  server.registerTool("fn_status", {
    description: "What fn_run/fn_try is doing right now: function, elapsed time, current URL and its latest log() lines. Use it when a run seems stuck.",
    inputSchema: {},
    annotations: read,
  }, safe(async () => text(runner.status() ?? "idle")));

  server.registerTool("fn_abort", {
    description: "Stop the running fn_run/fn_try. Its tab is closed so the function cannot keep driving the browser; the next call opens a new tab.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, safe(async () => {
    const stopped = runner.abort();
    return text(stopped ? { stopped } : "nothing is running");
  }));

  server.registerTool("fn_check", {
    description: "Run safe functions with example arguments to detect drift, bypassing caches. Optionally select names and per-function timeouts. Unsafe functions never run; skipped entries have ok=false and a skipped reason. Use result contracts/verify to make returned test failures fail the check.",
    inputSchema: {
      site,
      names: z.array(z.string().min(1)).min(1).max(100).optional().describe("Check only these functions; unknown names fail before any runs"),
      timeout_ms: runFlags.timeout_ms.describe("Limit for each checked function (default 60000), not the whole batch; timeout closes that function's tab"),
      action_timeout_ms: runFlags.action_timeout_ms,
      diagnostics: runFlags.diagnostics,
    },
    annotations: live,
  }, safe(async (a, extra: Extra) => text(await runner.check(a.site, {
    names: a.names, timeoutMs: a.timeout_ms, actionTimeoutMs: a.action_timeout_ms, diagnostics: a.diagnostics, ...runControls(extra),
  }))));

  return server;
}
