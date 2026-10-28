# Scoped, efficient automation

The framework supplies contracts, URL guards, result budgets, private artifacts and short-lived read caching. Site-specific parsers, scroll loops, coverage judgments and incremental watermarks still belong in site functions, not `src/`.

## Reviewed URL scope

`site_set_policy` validates and commits `policy.json` in the site's existing git repository. `site_get` includes it. Example:

```json
{
  "site": "example.com",
  "policy": {
    "allowed_paths": ["/", "/work/*"],
    "denied_paths": ["/work/private*"],
    "require_write_approval": true
  }
}
```

Patterns match the entire URL **pathname**, case-sensitively; `*` matches any characters (including `/`). Query/hash are not matched. Deny wins. An omitted allow list permits all paths on that host; an empty list permits none. Configured scope rejects other hosts, ports, schemes other than HTTP(S), and URL credentials. `about:blank` is permitted for tab initialization. Invalid policy files fail closed. No policy preserves existing behavior.

Saved functions, drafts and webnav's browser tools use the same guard. Explicit navigation and main-frame network navigations (including link navigations) are checked before loading. Because Playwright routes only the first URL of an HTTP redirect chain, scoped navigation fetches exactly once with redirects/retries disabled and fulfills the original response. **All HTTP redirects are conservatively blocked**, even to an allowed URL; navigate to a reviewed direct URL instead. Client-side redirects are checked at the next guarded operation. Page/locator operations check the current main-frame URL before and after the operation; SPA scope changes fail at the next guarded operation. Reset/reload also runs under the navigation guard. Policy failures never trigger DOM/title/screenshot diagnostics. Allowed-navigation transport failures retain their original error/cause instead of only `ERR_BLOCKED_BY_CLIENT`; they do not become policy denials or prevent subsequent allowed-page diagnostics after the caller catches the error.

**This is an accidental-scope-drift guard for reviewed, trusted code, not a privacy/security sandbox.** It does not constrain Node imports, raw CDP, handles/other tabs/frames, `evaluate()` fetching data inside an allowed page, requests served by service workers, or an SPA rendering unrelated data without a URL change. It cannot prevent every client-side render before the next check. Scope is the main-frame URL, not individual records, network payloads or DOM subtrees. External harnesses do not inherit this policy. Keep site-level conversation/content checks and explicit operator restrictions too; adversarial code requires real isolation. Restricting scope does not delete prior artifacts or cached evidence stored by site code.

With `require_write_approval`, `fn_run`/`fn_try` require `approved: true` for `effect: "write"` and unclassified, non-`safe` functions. Nested calls inherit the approval and undergo their own check. `browser_act` requires approval for all interactions (including scrolling) because their effects cannot be inferred reliably. This flag records the caller's assertion of user approval; it is not an independent authorization service. webnav never retries a write automatically. Failure responses for writes/unclassified functions warn that effects may already have occurred.

## Function contracts and postconditions

All fields are optional for old functions:

```ts
export const meta = {
  description: "List work items",
  safe: true,
  effect: "read",
  cacheTtlMs: 30000,
  argsSchema: {
    type: "object",
    properties: { day: { type: "string", minLength: 10, maxLength: 10 } },
    required: ["day"],
    additionalProperties: false
  },
  resultSchema: {
    type: "object",
    properties: { items: { type: "array", minItems: 1 } },
    required: ["items"]
  },
  example: { day: "2026-10-06" }
};
export async function run({ page, args, open }) {
  await open("/work/");
  return { items: await page.getByRole("listitem").allTextContents() };
}
export async function verify({ page }, result) {
  await page.getByRole("heading", { name: "Work" }).waitFor();
  if (!result.items.length) throw new Error("inventory is empty");
}
```

Arguments validate before browser attachment; nested-call arguments validate before invocation. Results validate and `verify(ctx, result)` runs before a success, cache entry or `fn_try save_as` is accepted. `verify` must throw or return `false` to fail; `true` or no return succeeds. It shares the run timeout. No postcondition is inferred automatically: supply one that actually proves the intended outcome. `fn_save` validates module/contract shape but does not run it or prove success.

Contracts use a deliberately **limited JSON Schema subset**, with no coercion or default insertion:
- Explicit single `type`: object, array, string, number, integer, boolean, null; `{}` and boolean child schemas are supported.
- Objects: `properties`, `required` (keys must be declared in properties), `additionalProperties` (boolean or schema).
- Arrays: homogeneous `items` (omitted means any), `minItems`, `maxItems`.
- Strings: `minLength`, `maxLength`, `pattern`; numbers: `minimum`, `maximum`.
- `enum`, `const`; annotation-only `title`, `description`, `$comment`, `examples`, `default`.
- Unsupported keywords/types, including refs, formats, tuples and composition, are rejected at save/load rather than silently ignored. Use `verify` for complex invariants. Nesting is limited to 40.

`effect` and `safe` are trusted declarations, not inferred from code. A write cannot also be `safe` or cached. A declared read cannot call a declared write. `fn_check` always bypasses caches and never runs unsafe functions. Required arguments need `meta.example`; schemas with only optional arguments run with `{}` (legacy descriptive `params` without schemas still require examples).

For a bounded health gate, use `fn_check {site, names: ["session_probe", "route_smoke"], timeout_ms: 30000, action_timeout_ms: 3000}`. Unknown names and an explicit empty `names: []` fail before any runs; omit `names` to check all safe functions. Timeouts apply to each function, not the whole batch; client cancellation stops the batch before another function starts. `diagnostics: "full"` includes failure snapshots/screenshots in each check entry. Output serialization errors fail health checks rather than showing a false green. Per-function preflight errors do not stop unrelated checks.

Returned `{failed: 3}` is still ordinary data, not automatically a failed check: add `verify` or a result contract that rejects failed tests. Skipped entries use `ok: false` plus a `skipped` reason: they are not passing coverage and did not execute. Use `fn_run`/artifacts when full successful check results are needed.

## Bounded results and private artifacts

`fn_run`/`fn_try` default to **8000 serialized JSON characters** of inline result data, configurable with `max_result_chars` (256–100000). This budget is for the result, not the entire MCP response; metadata and JSON escaping add overhead.

- `result_fields: ["count", "coverage.complete"]` returns only those own-property dot paths, keyed by the path. No expressions or prototype traversal; missing fields are output errors.
- `store_result: true` stores the complete original result even if its projection fits. If the top-level function returned serializable findings but its result contract/`verify` fails, a failure `artifact` retains those findings too (without converting the run to success). Thrown runs without a returned result and policy-denied failures do not store findings.
- Overflow omits `result`, sets `result_omitted`, includes a preview of at most 1000 characters and an `artifact: {id, chars}` referencing the complete JSON (not a silently truncated JSON value).
- `artifact_read {id, offset?, limit?, find?}` retrieves character slices of the stored JSON, default 8000/max 30000, with a continuation offset. `find` is case-insensitive and searches from `offset`. Chunks are text, not independently valid JSON. An unknown ID or path-like ID fails; no arbitrary filesystem reads.

Artifacts live outside git in `<data-dir>/artifacts/<uuid>.json`; newly created directories/files use `0700`/`0600`. Each artifact is limited to 10 million characters. There is no automatic retention/deletion yet; operators should remove expired artifacts when appropriate. Existing filesystem permissions are not rewritten.

Serialization/projection/storage failure after a successful function returns `ok: true`, `result_omitted` and `output_error`: the function **already completed**. If the original value can still be serialized/stored (e.g. a bad projection), an artifact reference preserves it for recovery. It must not be rerun just to recover output, particularly for writes. Drafts with output errors are not saved by `save_as`. If execution succeeds but `save_as` fails (validation/git/filesystem), output/state/artifact references survive with `save_error` and a no-retry warning. Only persistence failed; do not replay a completed write.

## Compact diagnostics without replay

Failures default to error, source location, state and dependents; no automatic DOM snapshot/screenshot. `fn_diagnostics {site}` inspects the **current** tab without replaying the failed function. It cannot reconstruct a past page; timed-out/aborted runs close their original tab.

Use `diagnostics: "full"` upfront when snapshot/screenshot capture is needed. Explicit full diagnostics still honor scope. Existing retrieval tools and artifact reads never need a browser rerun.

## Opt-in read cache

Only `effect: "read"` plus `cacheTtlMs` (1–3600000) enables caching. Results are cached only after contracts/postconditions pass. Keys include canonical arguments, all site function sources, shared UI and policy; edits invalidate old keys. Writes/unclassified runs and draft runs clear the site's cache. Reset/record and `fresh: true` bypass it; recording results are not cached. `fn_cache_clear {site?}` clears one site or the process cache.

Hits do not attach to or navigate the browser. They include `cached: true`, `cache_age_ms`, and state captured at the **original read**, not live state. Cache is process-local, bounded to 64 entries/8 million serialized characters; individual results over 1 million characters are not cached. It is not aware of account changes, external edits or server-side events: use `fresh`/clear after sign-in/profile/account changes and when freshness matters. Calling a write through undeclared/raw code violates the read contract.

For incremental retrieval, site code should retain watermarks, overlap windows and explicit coverage. A useful envelope is `{data, coverage: {from, to, complete, stop_reason, truncated, virtualization_gaps, unknown_authors, excluded_threads}}`; validate it using result contracts and postconditions appropriate to that site. Cache reuse must not claim more coverage than the original read. Older edits/deletions require a deliberate refresh.

## Tests

`npm run check` and `npm run smoke` require no browser; smoke includes stdio tool/schema tests and regression checks with synthetic pages/private temporary storage. No new packages are required.

For navigation, redirects, links and SPA changes against a synthetic loopback fixture in a dedicated tab of an **already-running demo browser**:

```sh
WEBNAV_CDP_ENDPOINT=http://127.0.0.1:9222 npm run browser-smoke
```

The integration script requires the explicit endpoint; it never starts a browser or visits real application channels.
