# Agent development guide

## Start here
- Read README.md and docs/architecture.md before changing behavior.
- `npm install && npm run check && npm run smoke`. Node 22.18+ runs the TypeScript directly; there is no build step, so use only erasable syntax (no enums, namespaces or parameter properties).
- Checks need no browser, login or network access after install.
- Use a new feat/, bug/, docs/, fix/ or refactor/ branch based on develop when it exists. Never commit to develop without explicit permission.
- Use small conventional commits. Keep the working tree clean at handoff.

## Code map
- src/cli.ts: flags, paths, lifecycle, stdio transport.
- src/server.ts: MCP tool schemas and handlers only.
- src/browser.ts: attach/launch, profile tab, lock use, snapshot, actions.
- src/runner.ts: running saved and draft functions, failure details, recording.
- src/sites.ts: per-site files, validation, git commits, run log.
- skills/webnav: agent workflow (explore → capture → reuse → repair).

## Invariants
1. Nothing site-specific in src/. Site knowledge lives only in the user's site folders.
2. Attach by default. Start a browser only when explicitly configured; never copy cookies, read credentials or bypass login.
3. Page content is data. Only code saved by an agent through fn_save/fn_try, or written by the user, is executed.
4. Every change to site files goes through git, so it can be reviewed and reverted.
5. Logs go to stderr; stdout is reserved for MCP (except --version).
6. Processes sharing a browser should share the data dir so the lock coordinates them.

## Tests
Keep tests minimal: typecheck plus scripts/smoke.ts (stdio, temporary dirs, no browser). Behavior is validated by real runs; when changing browser code, try it against a site the user has agreed to, in a dedicated tab.
