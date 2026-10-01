import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { act, actions, pageState, settle, snapshot, type BrowserManager } from "./browser.ts";
import type { Runner } from "./runner.ts";
import { siteKey, type Sites } from "./sites.ts";

export const version = "0.1.0";

type Deps = { browser: BrowserManager; sites: Sites; runner: Runner; dataDir: string; browserTools: boolean };

const text = (value: unknown, ...more: string[]): CallToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ...more.filter(Boolean).map(t => ({ type: "text" as const, text: t })),
  ],
});

function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async args => {
    try {
      return await fn(args);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message ?? String(error) }] };
    }
  };
}

const site = z.string().describe("Site host such as app.example.com or localhost:3000, or any URL on it");
const fnName = z.string().describe('Function name (letters, digits, _), or "ui" for the shared locator file');
const args = z.record(z.string(), z.unknown()).optional().describe("Arguments passed to the function as ctx.args");

export function createServer({ browser, sites, runner, dataDir, browserTools }: Deps): McpServer {
  const server = new McpServer({ name: "webnav", version });
  const read = { readOnlyHint: true, openWorldHint: false };
  const live = { readOnlyHint: false, openWorldHint: true };

  if (browserTools) {
    server.registerTool("browser_open", {
      description: "Attach to your running browser (dedicated tab) and optionally go to a URL or move through history. Returns page state and an accessibility snapshot with [ref=…] handles.",
      inputSchema: {
        url: z.string().optional(),
        history: z.enum(["back", "forward", "reload"]).optional(),
        snapshot: z.boolean().optional().describe("Include the snapshot (default true)"),
      },
      annotations: live,
    }, safe(async a => browser.use(async page => {
      if (a.url) await page.goto(a.url);
      else if (a.history === "back") await page.goBack();
      else if (a.history === "forward") await page.goForward();
      else if (a.history === "reload") await page.reload();
      await settle(page);
      return text(await pageState(page), a.snapshot === false ? "" : await snapshot(page));
    })));

    server.registerTool("browser_snapshot", {
      description: "Accessibility tree of the current page with [ref=…] handles for browser_act. Refs are only valid until the page changes.",
      inputSchema: { max_chars: z.number().int().min(1000).max(100_000).optional() },
      annotations: read,
    }, safe(async a => browser.use(async page => text(await pageState(page), await snapshot(page, a.max_chars)))));

    server.registerTool("browser_act", {
      description: "Perform one interaction on the current page, by snapshot ref or Playwright selector, then return the new state and snapshot. press without a target sends the key to the page; scroll without a target scrolls by value pixels.",
      inputSchema: {
        action: z.enum(actions),
        ref: z.string().optional().describe("Ref from the latest snapshot, e.g. e12"),
        selector: z.string().optional().describe('Playwright selector, e.g. role=button[name="Save"] or text=Billing'),
        value: z.string().optional().describe("Text for fill/type, key for press (e.g. Enter), option for select, pixels for scroll"),
        values: z.array(z.string()).optional().describe("Several options for select"),
        files: z.array(z.string()).optional().describe("Absolute file paths for upload"),
        snapshot: z.boolean().optional().describe("Include the snapshot afterwards (default true)"),
      },
      annotations: live,
    }, safe(async a => browser.use(async page => {
      await act(page, a);
      await settle(page);
      return text(await pageState(page), a.snapshot === false ? "" : await snapshot(page));
    })));

    server.registerTool("browser_screenshot", {
      description: "Screenshot of the current page. Prefer snapshots for finding elements; use this to check how something looks.",
      inputSchema: { full_page: z.boolean().optional() },
      annotations: read,
    }, safe(async a => browser.use(async page => {
      await mkdir(join(dataDir, "screenshots"), { recursive: true });
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
    description: "Run unsaved function code in the browser tab to test it before fn_save. Same module shape and ctx as saved functions; ctx.call can use saved functions.",
    inputSchema: { site, code: z.string(), args, timeout_ms: z.number().int().min(1000).max(600_000).optional() },
    annotations: live,
  }, safe(async a => text(await runner.try(a.site, a.code, a.args, { timeoutMs: a.timeout_ms }))));

  server.registerTool("fn_run", {
    description: "Run a saved function in the browser tab. On failure returns the error, the failing line, page state, a snapshot, a screenshot path and dependent functions, so the function can be fixed. record=true saves a webm with a visible cursor.",
    inputSchema: {
      site, name: z.string(), args,
      timeout_ms: z.number().int().min(1000).max(600_000).optional(),
      record: z.boolean().optional(),
    },
    annotations: live,
  }, safe(async a => text(await runner.run(a.site, a.name, a.args, { timeoutMs: a.timeout_ms, record: a.record }))));

  server.registerTool("fn_check", {
    description: "Run every function marked meta.safe (no arguments) to detect site changes early.",
    inputSchema: { site },
    annotations: live,
  }, safe(async a => text(await runner.check(a.site))));

  return server;
}
