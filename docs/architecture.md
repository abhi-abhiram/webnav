# Architecture

```text
Agent + skills/webnav ──MCP stdio──> src/server.ts (tool schemas)
                                        │
             ┌──────────────────────────┼─────────────────────────┐
        src/browser.ts             src/runner.ts             src/sites.ts
   attach · tab · lock ·      run / try / check functions,   notes, ui.ts, functions,
   snapshot · act · record    failure details, video         git commits, run log
             │                                                    │
   your running browser (CDP)                         ~/.config/webnav/sites/<host>/
```

## Idea
The server is thin. Knowledge lives in files the agent writes and maintains:
- **Notes** (`notes.md`): the site in prose: pages, how to reach them, quirks. They keep the *intent*, so a broken function can be rewritten from them.
- **Shared locators** (`ui.ts`): one place to fix when the UI moves.
- **Policy** (`policy.json`, optional): reviewed pathname patterns and write-approval requirements, committed with the same history.
- **Functions** (`functions/*.ts`): small Playwright routines that call each other via `call`. Each one ends by waiting for proof of its result.

Running a function is its own test. Optional argument/result contracts and `verify` postconditions must pass before a success is accepted. Failures default to compact error, `file:line`, state and dependents; `diagnostics: full` opts into snapshot/screenshot capture, or `fn_diagnostics` reads the current tab without replaying the function.

## Browser
- Attach only by default: an explicit endpoint (`--cdp-endpoint`, `WEBNAV_CDP_ENDPOINT`, or `browser_open { cdp_endpoint }` mid-session), else the `DevToolsActivePort` of a running browser (found in known user data dirs, or the one given), else port 9222. The file outlives its browser, so when the port serves `/json/version` the browser id must match. Launching requires `--launch-user-data-dir` and is headless.
- Notices: things webnav did on its own (opened a profile window, fell back to the default profile, waited for another call) are appended to the next tool result.
- Profiles: the `Default` profile uses a new tab without spawning a window. CDP cannot create tabs in another profile, and Playwright files every page under the default context. For a non-default profile, webnav runs the browser binary with `--user-data-dir`, `--profile-directory` and a sentinel `file://` URL. The running instance opens that window, and webnav adopts the sentinel tab as its own. This explicit profile workflow is not headless/focus-safe; failures stop without falling back to another profile. The default profile comes from the pi-browser-harness pin when it points at the same browser.
- One dedicated tab per server process. Closing it just makes the next call open another.
- `browser.lock` in the data dir serializes browser operations across webnav processes that share it. It does not coordinate with other tools or with a human using the same tab.
- Snapshots come from Playwright's `ariaSnapshot({ mode: "ai" })`. Refs resolve through the `aria-ref=` selector and are only valid until the page changes.

## Functions
- TypeScript runs without a build step (Node type stripping), so use only erasable syntax. Modules are imported with a content-hash query, so an edited file reloads without a restart.
- `fn_save` imports the module to validate its shape, restores the previous file if that fails, and commits it to the site's git repo as `webnav <webnav@localhost>`.
- The run log (`runs/<host>.jsonl`) is append-only and supplies `last_run` in `site_get`.
- A run stops on timeout, `fn_abort` or client cancellation. A promise cannot be cancelled, so webnav closes the run's tab: the function's pending and later Playwright calls fail, and the lock is released. The next call opens a new tab.
- `log()` lines are kept for `fn_status` and sent as MCP progress notifications when the client asks for progress.
- Explicit full failure snapshots list open dialogs before the page; denied pages never trigger DOM/title/screenshot diagnostics.
- `policy.ts` supplies the per-operation page/locator URL guard and main-frame navigation routing, reused by function execution and browser tools. It guards trusted-code scope drift, not arbitrary code/data access.
- `contracts.ts` validates a strict, documented JSON Schema subset and effect/cache metadata. Unsupported contracts fail rather than being silently ignored.
- `artifacts.ts` stores complete oversized/explicitly persisted JSON results privately and serves bounded reads by generated ID. Output projection never changes values received by nested functions or postconditions.
- Runner read caches are opt-in, process-local, TTL/memory-bounded and keyed by arguments plus site source/UI/policy hashes. Writes clear them; health checks bypass them. Cached state is historical, never presented as a fresh page observation.
- Recording uses `page.screencast` with action overlays.

## Not here (on purpose)
No graph engine, DOM fingerprinting or crawler: exploration is agent-driven and guided by the skill. Site-specific coverage, incremental watermarks and parsers remain in site functions. No sandbox: functions are trusted local code, reviewed through git history. See [efficient automation](efficient-automation.md) for defaults and guard limitations.
