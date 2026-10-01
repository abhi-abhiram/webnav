#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { BrowserManager } from "./browser.ts";
import { defaultPaths, log } from "./paths.ts";
import { Runner } from "./runner.ts";
import { createServer, version } from "./server.ts";
import { Sites } from "./sites.ts";

const usage = `webnav-mcp [options]

MCP server (stdio) for exploring websites and building reusable Playwright functions.
Attaches to a browser you already run with remote debugging enabled; never starts one unless --launch-user-data-dir is given.

  --cdp-endpoint <url>          local http:// or ws:// CDP endpoint (default: $WEBNAV_CDP_ENDPOINT, else
                                discover DevToolsActivePort, else port 9222)
  --user-data-dir <dir>         browser user data dir to attach to (e.g. ~/.config/chromium)
  --profile-directory <name>    profile inside it, e.g. "Profile 1" (default: pi-browser-harness pin)
  --browser-executable <path>   browser binary used to open a window in that profile
  --launch-user-data-dir <dir>  opt in: launch a browser with this user data dir instead of attaching
  --config-dir <dir>            notes and functions (default: ~/.config/webnav)
  --data-dir <dir>              runs, screenshots, videos, lock (default: ~/.local/share/webnav)
  --no-browser-tools            hide browser_* tools (e.g. when pi-browser-harness does the exploring)
  --version, --help`;

const { values } = parseArgs({
  options: {
    "cdp-endpoint": { type: "string" },
    "user-data-dir": { type: "string" },
    "profile-directory": { type: "string" },
    "browser-executable": { type: "string" },
    "launch-user-data-dir": { type: "string" },
    "config-dir": { type: "string" },
    "data-dir": { type: "string" },
    "no-browser-tools": { type: "boolean" },
    version: { type: "boolean" },
    help: { type: "boolean" },
  },
});

if (values.version) {
  process.stdout.write(version + "\n");
  process.exit(0);
}
if (values.help) {
  process.stderr.write(usage + "\n");
  process.exit(0);
}

for (const flag of ["user-data-dir", "launch-user-data-dir", "config-dir", "data-dir"] as const) {
  if (values[flag] && !isAbsolute(values[flag])) {
    log(`--${flag} must be an absolute path`);
    process.exit(2);
  }
}

const defaults = defaultPaths();
const configDir = values["config-dir"] ?? defaults.config;
const dataDir = values["data-dir"] ?? defaults.data;
await mkdir(dataDir, { recursive: true, mode: 0o700 });

const launchDir = values["launch-user-data-dir"];
const browser = new BrowserManager({
  cdpEndpoint: values["cdp-endpoint"] ?? (process.env.WEBNAV_CDP_ENDPOINT || undefined),
  userDataDir: values["user-data-dir"],
  profileDirectory: values["profile-directory"],
  executable: values["browser-executable"],
  launch: launchDir ? { userDataDir: launchDir, executable: values["browser-executable"] } : undefined,
  lockPath: join(dataDir, "browser.lock"),
});
const sites = new Sites(configDir, dataDir);
const runner = new Runner(sites, browser, dataDir);
const server = createServer({ browser, sites, runner, dataDir, browserTools: !values["no-browser-tools"] });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await browser.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
log(`ready (config ${configDir}, data ${dataDir})`);
