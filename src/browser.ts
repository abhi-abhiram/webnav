import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { withFileLock } from "./lock.ts";
import { log } from "./paths.ts";

export type BrowserOptions = {
  cdpEndpoint?: string;
  userDataDir?: string;
  // Profile folder inside the user data dir, e.g. "Profile 1". Defaults to the pi-browser-harness pin.
  profileDirectory?: string;
  executable?: string;
  // Launching is opt-in only: webnav never starts a browser unless explicitly configured.
  launch?: { userDataDir: string; executable?: string };
  lockPath: string;
};

export type PageState = { url: string; title: string; login_suspected: boolean };

export const actions = [
  "click", "dblclick", "right_click", "hover", "fill", "type", "clear", "press",
  "select", "check", "uncheck", "upload", "focus", "scroll",
] as const;
export type Action = (typeof actions)[number];
export type ActInput = {
  ref?: string;
  selector?: string;
  action: Action;
  value?: string;
  values?: string[];
  files?: string[];
};

const knownUserDataDirs = process.platform === "darwin"
  ? ["Google/Chrome", "Google/Chrome Beta", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge"]
      .map(d => join(homedir(), "Library", "Application Support", d))
  : ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge"]
      .map(d => join(homedir(), ".config", d));

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 500 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

// Chrome writes DevToolsActivePort when remote debugging is on, either from
// chrome://inspect/#remote-debugging or --remote-debugging-port.
async function endpointFromProfile(userDataDir: string): Promise<string | null> {
  const text = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8").catch(() => null);
  if (!text) return null;
  const [port, path] = text.split("\n").map(s => s.trim());
  if (!/^\d+$/.test(port) || !path?.startsWith("/devtools/browser/")) return null;
  return (await portOpen(Number(port))) ? `ws://127.0.0.1:${port}${path}` : null;
}

export function validateEndpoint(endpoint: string): string {
  const u = new URL(endpoint);
  if (!["http:", "ws:"].includes(u.protocol) || u.username || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new Error("CDP endpoint must be a local http:// or ws:// URL");
  }
  return endpoint;
}

type Endpoint = { endpoint: string; userDataDir?: string };

async function resolveEndpoint(opts: BrowserOptions): Promise<Endpoint> {
  if (opts.cdpEndpoint) return { endpoint: validateEndpoint(opts.cdpEndpoint), userDataDir: opts.userDataDir };
  const enable = "enable remote debugging at chrome://inspect/#remote-debugging (or start the browser with --remote-debugging-port)";
  if (opts.userDataDir) {
    const endpoint = await endpointFromProfile(opts.userDataDir);
    if (!endpoint) throw new Error(`no running browser with remote debugging for ${opts.userDataDir}; ${enable}`);
    return { endpoint, userDataDir: opts.userDataDir };
  }
  const found: { dir: string; endpoint: string }[] = [];
  for (const dir of knownUserDataDirs) {
    const endpoint = await endpointFromProfile(dir);
    if (endpoint) found.push({ dir, endpoint });
  }
  if (found.length === 1) return { endpoint: found[0].endpoint, userDataDir: found[0].dir };
  if (found.length > 1) {
    throw new Error(`several browsers allow remote debugging; choose one with --user-data-dir: ${found.map(f => f.dir).join(", ")}`);
  }
  throw new Error(`no running browser found; open your usual browser and ${enable}`);
}

// Reuse the profile pinned with pi-browser-harness (/browser-profile) when it is the same browser.
async function harnessProfile(userDataDir: string): Promise<string | undefined> {
  const text = await readFile(join(homedir(), ".pi", "agent", "browser-harness.json"), "utf8").catch(() => "");
  try {
    const pin = JSON.parse(text)?.profile;
    if (pin?.userDataDir === userDataDir && typeof pin.profileDir === "string") return pin.profileDir;
  } catch {}
  return undefined;
}

const executableNames: Record<string, string[]> = {
  "chromium": ["chromium", "chromium-browser"],
  "google-chrome": ["google-chrome-stable", "google-chrome"],
  "google-chrome-beta": ["google-chrome-beta"],
  "google-chrome-unstable": ["google-chrome-unstable"],
  "Brave-Browser": ["brave", "brave-browser"],
  "microsoft-edge": ["microsoft-edge-stable", "microsoft-edge"],
};
const macExecutables: Record<string, string> = {
  "Chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chrome Beta": "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "Chromium": "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "Brave-Browser": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "Microsoft Edge": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};

function onPath(names: string[]): string | undefined {
  for (const candidate of names) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  return undefined;
}

function findExecutable(userDataDir: string): string | undefined {
  const name = basename(userDataDir);
  if (process.platform === "darwin") return macExecutables[name] ?? Object.values(macExecutables).find(existsSync);
  return onPath(executableNames[name] ?? Object.values(executableNames).flat());
}

// CDP cannot open a tab in another profile. Handing --profile-directory to the browser
// binary makes the already-running instance (same user data dir) open a window there;
// the sentinel URL identifies that window.
async function openProfileTab(context: BrowserContext, executable: string, userDataDir: string, profile: string): Promise<Page> {
  const token = `webnav-${randomUUID()}`;
  const file = join(tmpdir(), `${token}.html`);
  await writeFile(file, `<!doctype html><title>${token}</title><p>webnav: opening ${profile}…`);
  const url = pathToFileURL(file).href;
  try {
    const opened = context.waitForEvent("page", { predicate: p => p.url() === url, timeout: 15_000 });
    const child = spawn(executable, [`--user-data-dir=${userDataDir}`, `--profile-directory=${profile}`, "--new-window", url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    const page = await opened.catch(() => {
      throw new Error(`could not open a window in profile "${profile}"; open one manually and retry`);
    });
    await page.goto("about:blank");
    return page;
  } finally {
    await rm(file, { force: true });
  }
}

export async function loginSuspected(page: Page): Promise<boolean> {
  const path = new URL(page.url()).pathname;
  if (/(^|\/)(login|log-in|signin|sign-in|sso|auth)(\/|$)/i.test(path)) return true;
  return (await page.locator("input[type=password]:visible").count().catch(() => 0)) > 0;
}

export async function pageState(page: Page): Promise<PageState> {
  return { url: page.url(), title: await page.title().catch(() => ""), login_suspected: await loginSuspected(page) };
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

export async function snapshot(page: Page, maxChars = 15_000): Promise<string> {
  const tree = await page.ariaSnapshot({ mode: "ai", timeout: 10_000 });
  return tree.length > maxChars ? tree.slice(0, maxChars) + `\n… truncated (${tree.length} chars)` : tree;
}

export async function act(page: Page, input: ActInput): Promise<void> {
  const target: Locator | null = input.ref ? page.locator(`aria-ref=${input.ref}`)
    : input.selector ? page.locator(input.selector) : null;
  const need = (): Locator => {
    if (!target) throw new Error(`${input.action} needs a ref or selector`);
    return target;
  };
  const value = input.value ?? "";
  switch (input.action) {
    case "click": return need().click();
    case "dblclick": return need().dblclick();
    case "right_click": return need().click({ button: "right" });
    case "hover": return need().hover();
    case "fill": return need().fill(value);
    case "type": return need().pressSequentially(value, { delay: 30 });
    case "clear": return need().clear();
    case "press": return target ? target.press(value) : page.keyboard.press(value);
    case "select": await need().selectOption(input.values ?? [value]); return;
    case "check": return need().check();
    case "uncheck": return need().uncheck();
    case "upload": return need().setInputFiles(input.files ?? []);
    case "focus": return need().focus();
    case "scroll":
      if (target) return target.scrollIntoViewIfNeeded();
      return page.mouse.wheel(0, Number(value) || 600);
  }
}

// Owns one dedicated tab in an already-running browser profile.
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tab: Page | null = null;
  private userDataDir?: string;
  private profile?: string;
  private opts: BrowserOptions;
  constructor(opts: BrowserOptions) {
    this.opts = opts;
  }

  private async connect(): Promise<BrowserContext> {
    if (this.context && (this.browser?.isConnected() ?? true)) return this.context;
    if (this.opts.launch) {
      log("launching browser with", this.opts.launch.userDataDir);
      this.context = await chromium.launchPersistentContext(this.opts.launch.userDataDir, {
        headless: false, viewport: null,
        executablePath: this.opts.launch.executable ?? findExecutable(this.opts.launch.userDataDir),
      });
      this.context.on("close", () => { this.context = null; this.tab = null; });
      return this.context;
    }
    const { endpoint, userDataDir } = await resolveEndpoint(this.opts);
    log("attaching to", endpoint.replace(/\/devtools\/browser\/.*/, ""), userDataDir ? `(${userDataDir})` : "");
    this.userDataDir = userDataDir;
    this.profile = this.opts.profileDirectory ?? (userDataDir ? await harnessProfile(userDataDir) : undefined);
    if (this.profile) log("using profile", this.profile);
    this.browser = await chromium.connectOverCDP(endpoint);
    this.browser.on("disconnected", () => { this.browser = null; this.context = null; this.tab = null; });
    const context = this.browser.contexts()[0];
    if (!context) throw new Error("connected browser has no default profile context");
    this.context = context;
    return context;
  }

  private async page(): Promise<Page> {
    if (this.tab && !this.tab.isClosed()) return this.tab;
    const context = await this.connect();
    if (this.profile && !this.opts.launch) {
      if (!this.userDataDir) throw new Error("--profile-directory needs --user-data-dir when using --cdp-endpoint");
      const executable = this.opts.executable ?? findExecutable(this.userDataDir);
      if (!executable) throw new Error("browser executable not found; pass --browser-executable");
      this.tab = await openProfileTab(context, executable, this.userDataDir, this.profile);
    } else {
      this.tab = await context.newPage();
    }
    this.tab.setDefaultTimeout(10_000);
    return this.tab;
  }

  // Every browser operation runs under the shared lock.
  use<T>(fn: (page: Page) => Promise<T>, timeoutMs = 30_000): Promise<T> {
    return withFileLock(this.opts.lockPath, timeoutMs, async () => fn(await this.page()));
  }

  async close(): Promise<void> {
    if (this.opts.launch) {
      await this.context?.close().catch(() => {});
    } else {
      // Never browser.close() on an attached browser: it can quit the user's browser.
      // Close only our tab, and only if it is not the last one (closing the last window quits Chromium).
      const others = this.context?.pages().filter(p => p !== this.tab && !p.isClosed()) ?? [];
      if (others.length > 0) await this.tab?.close().catch(() => {});
    }
    this.tab = null;
    this.context = null;
    this.browser = null;
  }
}
