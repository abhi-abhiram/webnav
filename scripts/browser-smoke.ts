// Opt-in integration check against an explicitly selected, already-running browser.
// Only a dedicated webnav tab and a synthetic loopback site are used. Never launches Chrome.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserManager } from "../src/browser.ts";
import { defaultPaths } from "../src/paths.ts";
import { policySchema, withPolicy } from "../src/policy.ts";
import { pick } from "../src/helpers.ts";

const endpoint = process.env.WEBNAV_CDP_ENDPOINT;
if (!endpoint) throw new Error("Set WEBNAV_CDP_ENDPOINT to the demo browser's local CDP endpoint; this test never launches a browser");
let deniedRequests = 0;
const fixture = createServer((req, res) => {
  if (req.url === "/transport-failure") { req.socket.destroy(); return; }
  if (req.url === "/blocked") { deniedRequests++; res.end("private fixture"); return; }
  if (req.url === "/redirect") { res.writeHead(302, {Location:"/blocked"}); res.end(); return; }
  res.setHeader("Content-Type","text/html");
  if (req.url === "/dropdowns") {
    res.end(`<!doctype html><button aria-controls="choices" aria-expanded="false" onclick="choices.hidden=!choices.hidden;this.setAttribute('aria-expanded',String(!choices.hidden))">Choose</button>
      <div id="choices" role="listbox" hidden>
        <button role="option" onclick="document.querySelector('button').textContent=this.textContent">Alpha</button>
        <button role="option">Duplicate</button><button role="option">Duplicate</button>
      </div><div role="listbox" hidden><button role="option">Wrong hidden option</button></div>`);
    return;
  }
  res.end('<h1>Allowed fixture</h1><a href="/blocked">Blocked link</a><button onclick="history.pushState({},\'\',\'/blocked\')">SPA change</button>');
});
await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));
const port = (fixture.address() as {port:number}).port;
const origin = `http://127.0.0.1:${port}`, site = `127.0.0.1_${port}`;
const policy = policySchema.parse({allowed_paths:["/allowed","/redirect","/transport-failure"]});
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
    await page.goto(`${origin}/allowed`);
    await assert.rejects(withPolicy(page,site,policy,async guarded=>{
      await guarded.goto(`${origin}/transport-failure`);
    }), /socket hang up|ECONNRESET|connection reset/i, "real scoped navigation preserves the transport cause instead of ERR_BLOCKED_BY_CLIENT");
    await page.goto(`${origin}/dropdowns`);
    await pick(page.getByRole("button", { name: "Choose", exact: true }), "Alpha");
    assert.equal(await page.getByRole("listbox").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Alpha", exact: true }).count(), 1, "trigger name changes but the original handle still closes it");
    await assert.rejects(pick(page.getByRole("button", { name: "Alpha", exact: true }), "Duplicate"), /strict mode violation/, "ambiguous options never silently pick first");
    assert.equal(await page.locator("#choices").isVisible(), false, "failed picks clean up their dropdown without hiding the original error");
    await pick(page.getByRole("button", { name: "Alpha", exact: true }), "Alpha");
    assert.equal(await page.locator("#choices").isVisible(), false, "the next pick starts from clean UI state");
    await page.goto(`${origin}/dropdowns`);
    await page.getByRole("button", { name: "Choose", exact: true }).evaluate(el => el.removeAttribute("aria-controls"));
    await pick(page.getByRole("button", { name: "Choose", exact: true }), "Alpha");
    assert.equal(await page.locator("#choices").isVisible(), false, "fallback ignores hidden listboxes");
    await page.evaluate(() => {
      document.querySelector('[role="listbox"][hidden]:not(#choices)')!.removeAttribute("hidden");
      document.querySelectorAll('[role="option"]').forEach(option => option.addEventListener("click", () => document.body.dataset.optionClicked = "true"));
    });
    await assert.rejects(pick(page.getByRole("button", { name: "Alpha", exact: true }), "Alpha"), /strict mode violation/, "multiple visible listboxes without aria-controls fail instead of picking the last");
    assert.equal(await page.locator("body").getAttribute("data-option-clicked"), null, "ambiguous listboxes never select a record");
    assert.equal(await page.locator("#choices").isVisible(), false, "cleanup closes only the original expanded trigger");
    assert.equal(await page.getByRole("option", {name:"Wrong hidden option",exact:true}).isVisible(), true, "unrelated dropdown is left alone");
    await page.goto(`${origin}/dropdowns`);
    await page.locator('#choices [role="option"]').first().evaluate(option => option.setAttribute("onclick", "document.querySelector('button').textContent=this.textContent; document.querySelector('#choices').hidden=true"));
    await pick(page.getByRole("button", { name: "Choose", exact: true }), "Alpha");
    assert.equal(await page.getByRole("button", { name: "Alpha", exact: true }).getAttribute("aria-expanded"), "true", "fixture deliberately leaves stale ARIA state after auto-close");
    assert.equal(await page.locator("#choices").isVisible(), false, "cleanup must not reopen an auto-closed dropdown even if aria-expanded is stale");
    console.error("browser smoke ok");
  });
} finally {
  await browser.close();
  await new Promise<void>(resolve=>fixture.close(()=>resolve()));
}
// An attached CDP socket is intentionally not closed with browser.close() (that quits Chrome).
process.exit(0);
