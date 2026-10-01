# Architecture and ownership

```text
MCP client -> mcpserver -> core -> Browser interface -> CDP -> Chrome/Discord
                           |
                       Store + Guidance
```

## Boundaries
- MCP adapter translates typed parameters and results; it does not own automation.
- Core resolves channel IDs/names/file aliases and verifies browser results.
- Browser adapter owns CDP handles and a dedicated tab. DOM helpers are embedded at build time.
- SQLite stores observed facts and partial exploration progress, partitioned by caller-provided account key.
- Guidance files store editable intent, aliases and reviewed declarative recipe settings.
- Session refs and tab handles are never persisted.

The current Browser interface exposes Open + observation + Close. Expand it with scoped operations as features require them; do not expose unrestricted evaluate/click tools to agents.

## Navigation
1. Validate account and server ID.
2. Resolve channel from ID, file alias, or observed exact name. Reject ambiguous names.
3. Read the recipe (version 1, selected_or_heading or selected_only, timeout).
4. Acquire cross-process browser lock.
5. Navigate to a generated Discord URL.
6. Require exact destination URL and selected channel identity, or a matching known heading.
7. Return compact evidence. Do not claim success for URL-only navigation.

Unknown channel IDs may be navigated directly, but require selected-channel evidence because their name is not yet known.
Browser observations are heuristics, not a complete Discord semantic model.

## Exploration
The MVP frontier is server -> visible channel destinations, not an exhaustive Discord graph.
Deduplicate by channel ID, reject foreign-server and malformed IDs, bound observations and visits, and honor time/cancellation budgets.
A depth-2 queue may grow from newly observed links. Visited destinations are verified before their observations are accepted.
Persist partial progress without inferring deletion or permanent inaccessibility.
Initial discovery failure returns an error; later per-channel failures become warnings.
Depth beyond 2, category traversal and thread traversal are intentionally not implemented yet.

## Files and database
SQLite schema v1:
- channels(account, server_id, id, name, last_observed)
- exploration(account, server_id, status, observed, visited, last_observed)

The server ID is currently an explicit scope rather than a separately named server record.
Name discovery is derived from visible link labels; future migrations can add channel type/category/source evidence.
Upserts preserve existing names if an observation has an empty label. Missing observations never remove data.
SQLite uses WAL, a busy timeout and one connection per process. A future schema version is rejected, not overwritten.

Guidance:
- strict, bounded, single-document YAML; unknown fields rejected
- numeric ID targets for aliases
- SHA-256 revision tokens
- per-file cross-process lock and atomic replacement for MCP writes
- direct user edits supported; editors must avoid racing managed updates

Editable conventions are returned as data, not interpreted as permissions by the backend.
Recipes select reviewed strategies and timeouts, never executable code. DOM helper changes require rebuild/review.

## Multi-client lifecycle
Stdio starts one process per client. Default shared data-dir makes SQLite/locks coordinate those processes.
Each process creates a dedicated tab lazily; no browser is launched and no login is automated.
Browser actions are serialized across processes sharing the lock; tools that only read knowledge do not require it.
Tab state remains process-local and is closed on shutdown.
The browser lock does not prevent a human, another automation tool, or a client with another data-dir from changing the UI.
Core currently assumes the caller's account namespace matches the attached Chrome profile.

## Future adapters
- CLI: call core directly for a simple first implementation. A future shared-service client can avoid separate process lifecycle.
- Chrome extension: implement Browser through a reviewed Native Messaging or authenticated localhost bridge. The extension is a browser adapter, not inherently an MCP client.
- Shared service: expose MCP HTTP and a local CLI/extension bridge while reusing core; authenticate local channels and queue browser jobs.

## Future content store
Add messages, authors and attachment metadata through explicit migrations, not guidance files.
Keep original content separate from annotations/summaries; track collection scope, provenance and edits/deletions.
Use FTS5 before considering embeddings.
Downloaded assets live outside SQLite with checksums and retention controls. Expiring attachment URLs are references, not archival storage.
