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
- **Functions** (`functions/*.ts`): small Playwright routines that call each other via `call`. Each one ends by waiting for proof of its result.

Running a function is its own test. A failure returns the error, the failing `file:line`, page state, a trimmed accessibility snapshot, a screenshot and the functions that depend on it, which is what an agent needs to repair it.

## Browser
- Attach only by default: an explicit endpoint, or the `DevToolsActivePort` of a running browser (found in known user data dirs, or the one given). Launching requires `--launch-user-data-dir`.
- Profiles: CDP cannot create tabs in a non-default profile, and Playwright files every page under the default context. To use a profile, webnav runs the browser binary with `--user-data-dir`, `--profile-directory` and a sentinel `file://` URL. The running instance opens that window, and webnav adopts the sentinel tab as its own. The default profile comes from the pi-browser-harness pin when it points at the same browser.
- One dedicated tab per server process. Closing it just makes the next call open another.
- `browser.lock` in the data dir serializes browser operations across webnav processes that share it. It does not coordinate with other tools or with a human using the same tab.
- Snapshots come from Playwright's `ariaSnapshot({ mode: "ai" })`. Refs resolve through the `aria-ref=` selector and are only valid until the page changes.

## Functions
- TypeScript runs without a build step (Node type stripping), so use only erasable syntax. Modules are imported with a content-hash query, so an edited file reloads without a restart.
- `fn_save` imports the module to validate its shape, restores the previous file if that fails, and commits it to the site's git repo as `webnav <webnav@localhost>`.
- The run log (`runs/<host>.jsonl`) is append-only and supplies `last_run` in `site_get`.
- Timeouts bound the tool call. A timed-out function may still finish in the background.
- Recording uses `page.screencast` with action overlays.

## Not here (on purpose)
No graph engine, fingerprints or crawler: exploration is agent-driven and guided by the skill. No sandbox: functions are trusted local code, reviewed through git history.
