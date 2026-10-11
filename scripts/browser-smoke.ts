// Opt-in integration check against an explicitly selected, already-running browser.
// Only a dedicated webnav tab and a synthetic loopback site are used. Never launches Chrome.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserManager } from "../src/browser.ts";
import { defaultPaths } from "../src/paths.ts";
import { policySchema, withPolicy } from "../src/policy.ts";

const endpoint = process.env.WEBNAV_CDP_ENDPOINT;
if (!endpoint) throw new Error("Set WEBNAV_CDP_ENDPOINT to the demo browser's local CDP endpoint; this test never launches a browser");
let deniedRequests = 0;
const fixture = createServer((req, res) => {
  if (req.url === "/blocked") { deniedRequests++; res.end("private fixture"); return; }
  if (req.url === "/redirect") { res.writeHead(302, {Location:"/blocked"}); res.end(); return; }
  res.setHeader("Content-Type","text/html");
  res.end('<h1>Allowed fixture</h1><a href="/blocked">Blocked link</a><button onclick="history.pushState({},\'\',\'/blocked\')">SPA change</button>');
});
await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));
const port = (fixture.address() as {port:number}).port;
const origin = `http://127.0.0.1:${port}`, site = `127.0.0.1_${port}`;
const policy = policySchema.parse({allowed_paths:["/allowed","/redirect"]});
await mkdir(defaultPaths().data,{recursive:true,mode:0o700});
const browser = new BrowserManager({cdpEndpoint:endpoint,lockPath:join(defaultPaths().data,"browser.lock")});
try {
  await browser.use(async page=>{
    await withPolicy(page,site,policy,async guarded=>{
      await guarded.goto(`${origin}/allowed`);
      assert.equal(await guarded.title(),"");
      assert.equal(await guarded.getByRole("heading").innerText(),"Allowed fixture");
    });
    await assert.rejects(withPolicy(page,site,policy,async guarded=>{await guarded.goto(`${origin}/blocked`);}));
    await assert.rejects(withPolicy(page,site,policy,async guarded=>{
      await guarded.goto(`${origin}/allowed`);
      await guarded.getByRole("link").click();
    }));
    await assert.rejects(withPolicy(page,site,policy,async guarded=>{await guarded.goto(`${origin}/redirect`);}));
    assert.equal(deniedRequests,0,"denied navigations, links and redirects never reach the fixture");
    await assert.rejects(withPolicy(page,site,policy,async guarded=>{
      await guarded.goto(`${origin}/allowed`);
      const heading=guarded.getByRole("heading");
      await guarded.getByRole("button").click();
      await heading.innerText();
    }),/denied/,"SPA URL changes fail before the next DOM read");
    console.error("browser smoke ok");
  });
} finally {
  await browser.close();
  await new Promise<void>(resolve=>fixture.close(()=>resolve()));
}
// An attached CDP socket is intentionally not closed with browser.close() (that quits Chrome).
process.exit(0);
