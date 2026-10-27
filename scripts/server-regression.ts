// Exercise browser-tool cache invalidation over MCP without Chrome or network access.
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
const browser = { use: async (fn: any) => fn(page), takeNotices: () => [] } as unknown as BrowserManager;
const runner = { clearCache: () => ++clears } as unknown as Runner;
const sites = { policy: async () => null } as unknown as Sites;
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
  console.error("server regression ok");
} finally {
  await client.close();
  await server.close();
}
