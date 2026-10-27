// Browser-free stdio smoke check: starts the server with temporary storage and exercises the library tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "webnav-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/cli.ts", "--config-dir", join(root, "config"), "--data-dir", join(root, "data")],
  stderr: "ignore",
});
const client = new Client({ name: "smoke", version: "0" });

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text?: string }[] };
  return { error: !!r.isError, text: r.content.map(c => c.text ?? "").join("\n") };
}

try {
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  const tools = listed.map(t => t.name);
  const checkSchema = listed.find(t => t.name === "fn_check")!.inputSchema;
  for (const field of ["names", "timeout_ms", "action_timeout_ms", "diagnostics"]) assert.ok(field in checkSchema.properties!, field);
  for (const t of ["browser_open", "browser_act", "site_get", "fn_save", "fn_run", "fn_try", "fn_status", "fn_abort", "site_set_policy", "artifact_read", "fn_cache_clear", "fn_diagnostics"]) assert.ok(tools.includes(t), t);

  assert.equal((await call("fn_status")).text, "idle");
  assert.equal((await call("fn_abort")).text, "nothing is running");

  const site = "http://localhost:3000/dashboard";
  assert.equal(JSON.parse((await call("site_get", { site })).text).exists, false);

  const fn = `export const meta = { description: "Open settings", safe: true };
export async function run({ page }) {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
}`;
  const saved = await call("fn_save", { site, name: "goToSettings", code: fn });
  assert.equal(saved.error, false, saved.text);
  assert.deepEqual(JSON.parse(saved.text).warnings, []);

  const broken = await call("fn_save", { site, name: "goToSettings", code: "export const meta = {};" });
  assert.equal(broken.error, true);
  assert.equal((await call("fn_read", { site, name: "goToSettings" })).text, fn, "invalid save must roll back");

  const delegating = `export const meta = { description: "Settings via call" };
export async function run({ call }) { return call("goToSettings"); }`;
  assert.deepEqual(JSON.parse((await call("fn_save", { site, name: "viaCall", code: delegating })).text).warnings, []);

  await call("site_write_notes", { site, markdown: "# localhost_3000\n\n## Map\n- Settings: main nav\n" });
  const info = JSON.parse((await call("site_get", { site })).text);
  assert.equal(info.site, "localhost_3000");
  assert.equal(info.functions[0].name, "goToSettings");
  assert.ok(!info.ui.includes("./helpers.ts"), "new sites must not import a nonexistent helper module");
  assert.equal((await call("fn_check", { site, names: ["unknown"] })).error, true);
  assert.equal((await call("fn_check", { site, names: [] })).error, true);
  assert.match(info.notes, /Settings: main nav/);
  assert.match((await call("site_history", { site })).text, /fn\(goToSettings\): add/);
  assert.equal((await call("fn_save", { site, name: "../escape", code: fn })).error, true);
  const policy = {allowed_paths: ["/dashboard*"], denied_paths: ["/discussion*"], require_write_approval: true};
  assert.equal((await call("site_set_policy", {site, policy})).error, false);
  assert.deepEqual(JSON.parse((await call("site_get", {site})).text).policy, policy);
  assert.equal((await call("site_set_policy", {site, policy: {allowed_paths:["not/a/path"]}})).error, true);
  assert.match((await call("site_history", {site})).text, /policy: update scope/);
  assert.deepEqual(JSON.parse((await call("fn_cache_clear", {site})).text), {cleared:0});
  assert.equal((await call("artifact_read", {id:"../escape"})).error, true);
  console.error("smoke ok");
} finally {
  await client.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
