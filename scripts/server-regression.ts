// Browser-tool cancellation/cache invalidation and draft output recovery over MCP; no Chrome/network.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import type { BrowserManager } from "../src/browser.ts";
import type { Runner } from "../src/runner.ts";
import type { Sites } from "../src/sites.ts";

let url = "about:blank", clears = 0, failNavigation = false;
const navigate = async (target: string) => {
  url = target;
  if (failNavigation) throw new Error("navigation failed after URL changed");
};
const page = {
  url: () => url, title: async () => "Fixture",
  locator: () => ({ count: async () => 0 }),
  goto: navigate, goBack: () => navigate("http://localhost:3000/back"),
  goForward: () => navigate("http://localhost:3000/forward"), reload: () => navigate(url),
  waitForLoadState: async () => {},
};
let queuedUse: { entered: () => void; gate: Promise<void>; done: () => void } | undefined;
const browser = { use: async (fn: any) => {
  const queued = queuedUse;
  if (queued) { queued.entered(); await queued.gate; }
  try { return await fn(page); } finally { queued?.done(); }
}, takeNotices: () => [] } as unknown as BrowserManager;
const completed = { ok: true, ms: 1, result: { created: "disposable-id" }, artifact: { id: "retained-id", chars: 12 }, state: { url: "http://localhost:3000/done", title: "Done", login_suspected: false } };
const runner = { clearCache: () => ++clears, try: async () => completed } as unknown as Runner;
const sites = { policy: async () => null, save: async () => { throw new Error("git save failed"); } } as unknown as Sites;
const server = createServer({ browser, runner, sites, dataDir: "unused-no-files-created", browserTools: true });
const client = new Client({ name: "server-regression", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "browser_open", arguments: { snapshot: false, ...args } });
  assert.ok(!(await call({ url: "http://localhost:3000/start" })).isError);
  assert.equal(clears, 2, "navigation invalidates before and after browser work");
  await call({});
  assert.equal(clears, 2, "a state-only read does not invalidate cached results");
  for (const history of ["back", "forward", "reload"]) await call({ history });
  assert.equal(clears, 8, "history changes invalidate too");
  failNavigation = true;
  assert.equal((await call({ url: "http://localhost:3000/fails" })).isError, true);
  assert.equal(clears, 10, "failed navigation can still change the session/page");
  failNavigation = false;
  let entered!: () => void, release!: () => void, done!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { done = resolve; });
  queuedUse = { entered, gate, done };
  const cancellation = new AbortController();
  const beforeCancelledNavigation = url;
  const pending = client.callTool({name:"browser_open",arguments:{url:"http://localhost:3000/must-not-open",snapshot:false}}, undefined, {signal:cancellation.signal});
  await waiting;
  cancellation.abort();
  await assert.rejects(pending);
  release(); await finished; queuedUse = undefined;
  assert.equal(url,beforeCancelledNavigation,"browser tools cancelled while queued must not navigate");
  const saveFailure = await client.callTool({ name: "fn_try", arguments: { site: "localhost:3000", code: "valid but already executed by fixture", save_as: "example" } }) as { isError?: boolean; content: { text: string }[] };
  assert.ok(!saveFailure.isError,"save failure must not discard successful execution output");
  const retained = JSON.parse((saveFailure.content[0] as {text:string}).text);
  assert.deepEqual(retained.result,completed.result);assert.deepEqual(retained.artifact,completed.artifact);
  assert.deepEqual(retained.state,completed.state);assert.equal(retained.ok,true);
  assert.match(retained.save_error,/git save failed/);assert.match(retained.retry_warning,/Do not rerun/);
  console.error("server regression ok");
} finally {
  await client.close();
  await server.close();
}
