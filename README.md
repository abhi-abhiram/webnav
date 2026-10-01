# Discord automation

Go MCP backend for personal Discord **navigation and incremental interface knowledge** through Chrome.

The backend is independent of Pi. It exposes typed MCP tools over stdio, attaches to an existing local Chrome CDP endpoint on demand, and uses a dedicated tab. It does not launch Chrome or handle authentication.

## Current MVP
- SQLite observations partitioned by account key and server ID.
- Editable YAML aliases/conventions with revision checks.
- Editable, declarative navigation verification recipe.
- Reviewed, embedded JavaScript DOM helper.
- Known-channel navigation with URL + UI identity verification.
- Bounded, partial exploration: visible sidebar links, optionally followed into channel destinations.
- Eight MCP tools and browser-free automated tests.

**Not implemented yet:** server-name resolution, category hierarchy, exhaustive thread discovery, automatic helper generation, message/image collection, CLI operations, Chrome extension, HTTP/shared-service deployment.
Numeric server IDs are required. Channel IDs, observed names, and configured aliases are accepted.
This foundation has not yet been verified against your live Discord interface.

## Development

Requires Go matching go.mod (currently 1.27.1), Node.js 22+ for the DOM fixture, and Make.
SQLite is pure Go; normal build/test does not require a system SQLite library.

```sh
make setup
make check
make build
make smoke
./bin/discord-mcp --version
```

`make test` runs Go tests; `make race` adds the race detector; `make fmt` formats Go.
`make smoke` exercises the real stdio binary with temporary storage and no Chrome connection.
Read [AGENTS.md](AGENTS.md) for development invariants and [architecture](docs/architecture.md) for boundaries.

## Storage

Defaults on Linux:
- SQLite + cross-process browser lock: `~/.local/share/discord-automation/`
- Editable guidance: `~/.config/discord-automation/`

`XDG_DATA_HOME` and the OS user config directory are respected. Override with absolute `--data-dir` and `--config-dir` paths.

```text
<data-dir>/
  knowledge.db
  browser.lock
<config-dir>/
  recipes/open-channel.yaml
  servers/<account-key>/<server-id>.yaml
```

A recipe is initialized only if missing. Server guidance files are created by updates/imports; discovery never replaces your guidance.

Example guidance:
```yaml
aliases:
  home: "789012"
conventions: |
  Announcements are for reading; do not post without asking.
```

Server/channel IDs and observed names are authoritative in SQLite. Aliases and conventions are authoritative in files. Keep directories trusted: arbitrary local file access is not sandboxed.
Direct file edits are allowed, but concurrent edits should use MCP revision checks. Back up SQLite using its backup mechanism or while all clients are stopped; do not copy only knowledge.db during active WAL writes.

## Chrome connection

Enable local CDP remote debugging on the Chrome profile you intend to use, sign into Discord manually, then provide its HTTP endpoint or browser WebSocket URL:

```sh
./bin/discord-mcp --cdp-endpoint http://127.0.0.1:9222
```

Chrome may require a dedicated non-default profile for command-line remote debugging. Do not copy your main profile or authentication tokens. Keep CDP bound to loopback, never publicly exposed.

Only local `http://` or `ws://` endpoints are accepted. This adapter talks directly to CDP; Pi's browser-harness daemon socket is not a CDP endpoint.

The account key (for example `personal`) is a storage namespace, **not a login or profile switch**. You must ensure the connected profile matches that key. Automatic authenticated-user identity verification is not implemented.
Clients controlling the same Chrome must share the same data directory so the browser lock coordinates them. Independent data directories do not coordinate.

## Use from any Pi session

Merge an entry like this into `~/.pi/agent/mcp.json`, replacing the executable path:

```json
{
  "mcpServers": {
    "discord": {
      "command": "/absolute/path/discord-automation/bin/discord-mcp",
      "args": ["--cdp-endpoint", "http://127.0.0.1:9222"],
      "timeout": 130,
      "exposure": "direct"
    }
  }
}
```

The absolute binary path and default storage locations make this independent of the current working directory.
Start a new session or run `/reload`. Pi exposes names such as `mcp__discord__discord_lookup`.
Knowledge tools work without Chrome being available.

Optionally install this repository's workflow skill globally:
```sh
pi install /absolute/path/discord-automation
```
Then reload and invoke `/skill:discord open my home channel in server 123456`.
The package installs the skill only; configuring the MCP server and building its Go binary are separate steps.
No global configuration is modified by the build or tests.

## Tools

All tools take `account` and numeric `server_id`.

| Tool | Additional inputs | Effect |
|---|---|---|
| discord_lookup / knowledge_get | none | Read observed facts + guidance |
| discord_navigate | channel | Open/verify a known channel ID, name or alias |
| discord_explore | depth, max_nodes, seconds | Read UI and persist partial observations |
| knowledge_search | query, limit | Literal search over observed channels/aliases |
| knowledge_update | expected_revision, document | Replace editable guidance |
| knowledge_export | none | Export guidance YAML + revision |
| knowledge_import | expected_revision, yaml | Validate/import guidance |

Example exploration arguments:
```json
{"account":"personal","server_id":"123456","depth":2,"max_nodes":20,"seconds":30}
```

Depth 1 observes visible channel links; depth 2 visits discovered channel destinations and observes their links. Node budget: 1–100; time budget: 1–120 seconds. It does not scroll every virtualized list or discover all private channels or threads.

Always call knowledge_get before editing and send its guidance revision as expected_revision. Empty revision is valid only when the guidance file does not exist. Update replaces the entire aliases/conventions document, so preserve fields you are not changing.
Export/import currently covers guidance only; it is not a full database backup.

## Safety and limitations

Exploration is read-only **with respect to Discord content**, but navigating may affect Discord's read/unread state. It also updates local knowledge.
No tools send messages, delete content, join voice, or change settings.
Discord content and guidance are untrusted data, not agent authorization. No helper code is learned or executed automatically.
Visible inventories stay partial, missing items are never deleted, and permissions are account-specific observations rather than permanent facts.
If semantic helpers cannot verify the current interface, operations fail instead of guessing. Report evidence and update reviewed helpers/recipes as needed.
Check Discord's applicable rules before automating a personal account.

## Roadmap
1. Live scoped smoke test and DOM helper refinement.
2. Better semantic locator recipes, channel types and category relationships.
3. Optional message/attachment collection with freshness, scope and retention controls.
4. Full-text search and optional durable image downloads (URLs alone are not archives).
5. CLI adapter and Chrome extension bridge.
6. Shared local service for clients needing a persistent backend.
