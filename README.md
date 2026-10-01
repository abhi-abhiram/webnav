# webnav

MCP server that lets agents **learn any website and reuse what they learned**. Agents explore through your own browser, write per-site notes, and save small Playwright functions. Later runs reuse those functions, and fix them when the site changes.

- Attaches to the browser you already run, using your existing profile and logins. It never starts a browser unless you opt in.
- Per-site knowledge is plain files in a git repo: `notes.md`, `ui.ts` (shared locators), `functions/*.ts`.
- When a function fails, the result says what broke, where, and what the page looks like now, so the agent can fix it.
- Functions can be recorded to webm with a visible cursor, e.g. for PR demos.

## Setup

Requires Node.js 22.18+ (TypeScript runs directly, no build step) and git.

```sh
npm install
npm run check   # typecheck
npm run smoke   # stdio smoke run with temporary storage, no browser
```

Enable remote debugging in the browser you normally use: open `chrome://inspect/#remote-debugging` (also `brave://inspect`, `edge://inspect`) and allow it, or start the browser with `--remote-debugging-port=9222`. webnav finds it through the `DevToolsActivePort` file in the browser's user data dir.

Add the server to your MCP client, e.g. `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "webnav": {
      "command": "node",
      "args": ["/absolute/path/to/webnav/src/cli.ts"],
      "timeout": 660
    }
  }
}
```

Optionally install the workflow skill: `pi install /absolute/path/to/webnav`.

### Choosing the browser and profile

| Flag | Meaning |
|---|---|
| (none) | Attach to the one running browser that has remote debugging on. |
| `--user-data-dir <dir>` | Pick a browser when several are running, e.g. `~/.config/chromium`. |
| `--profile-directory "Profile 1"` | Open webnav's tab in that profile. Defaults to the profile pinned with pi-browser-harness (`/browser-profile`) when it is the same browser. |
| `--cdp-endpoint <url>` | Explicit local `http://` or `ws://` endpoint. |
| `--browser-executable <path>` | Browser binary, if it is not found automatically (used to open a window in a profile). |
| `--launch-user-data-dir <dir>` | **Opt-in only:** launch a browser with this user data dir instead of attaching. |
| `--no-browser-tools` | Hide `browser_*` tools, e.g. when pi-browser-harness does the exploring. |

webnav opens its own tab and never reads cookies or credentials. When a page looks like a login, it reports `login_suspected` and the agent asks you to sign in.

### Using it with pi-browser-harness

Both attach to the same running browser over CDP, and each keeps to its own tabs. webnav reuses the harness profile pin automatically. You can explore with the harness tools and use webnav for notes and functions (`--no-browser-tools` avoids duplicate tools), or use webnav's own `browser_*` tools.

## Storage

```text
~/.config/webnav/sites/<host>/      # one git repo per site; edit freely
  notes.md                          # map of pages, how to reach them, quirks
  ui.ts                             # shared locators
  functions/<name>.ts               # reusable functions
~/.local/share/webnav/
  runs/<host>.jsonl                 # run log (last result per function)
  screenshots/  videos/  tmp/
  browser.lock                      # serializes browser use across processes
```

`<host>` is the URL host, with `:port` written as `_port` (e.g. `localhost_3000`). Override the directories with `--config-dir` and `--data-dir` (absolute paths).

A function:

```ts
export const meta = { description: "Open Settings → Billing", safe: true };
export async function run({ page, args, call, ui, log }) {
  await ui.mainNav(page).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Billing" }).click();
  await page.getByRole("heading", { name: "Billing" }).waitFor();
}
```

`page` is a Playwright `Page`. `call(name, args)` runs another function of the same site, and `ui` is the object exported by `ui.ts`. `meta.safe` marks functions without side effects, which `fn_check` runs as a health check.

## Tools

| Tool | Purpose |
|---|---|
| `browser_open` | Attach, go to a URL or back/forward/reload; returns state + snapshot |
| `browser_snapshot` | Accessibility tree with `[ref=…]` handles |
| `browser_act` | click, dblclick, right_click, hover, fill, type, clear, press, select, check, uncheck, upload, focus, scroll |
| `browser_screenshot` | Image of the page |
| `site_list` / `site_get` | Known sites; notes, ui, functions and last runs |
| `site_write_notes` | Replace notes (committed) |
| `fn_read` / `fn_save` / `fn_delete` | Read, validate-and-commit, delete functions or `ui.ts` |
| `site_history` | Git history; `fn_read` with `revision` restores old code |
| `fn_try` | Run unsaved code |
| `fn_run` | Run a function; failure details for repair; `record` for video |
| `fn_check` | Run all `safe` functions |

## Trust model

Functions are local code written by agents and run with your logged-in browser session, without a sandbox. Every change is a commit in the site's repo, so review with `git log -p` in `~/.config/webnav/sites/<host>`. Page content is never executed as code. Keep CDP bound to loopback.

See [architecture](docs/architecture.md) and [AGENTS.md](AGENTS.md).
