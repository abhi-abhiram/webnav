// Browser-free regression checks, with synthetic pages and private temporary storage.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifacts, project } from "../src/artifacts.ts";
import { assertSchema, canonical } from "../src/contracts.ts";
import { assertUrl, policySchema, withPolicy } from "../src/policy.ts";
import { Sites } from "../src/sites.ts";
import { Runner } from "../src/runner.ts";
import type { BrowserManager } from "../src/browser.ts";
import type { Page } from "playwright-core";

const root = await mkdtemp(join(tmpdir(), "webnav-regression-"));
let url = "about:blank", uses = 0, domReads = 0, screenshots = 0;
const locator: any = { count: async () => { domReads++; return 0; }, ariaSnapshot: async () => { domReads++; return "- heading \"Synthetic\""; } };
const page: any = {
  url: () => url, title: async () => { domReads++; return "Synthetic"; }, isClosed: () => false,
  locator: () => locator, getByRole: () => locator, route: async () => {}, unroute: async () => {},
  goto: async (target: string) => { url = target; }, reload: async () => {},
  ariaSnapshot: async () => { domReads++; return "- heading \"Synthetic\""; },
  setDefaultTimeout: () => {}, screenshot: async () => { screenshots++; return Buffer.alloc(0); },
};
locator.page = () => page;
locator.locator = () => locator;
const browser = { use: async (fn: any) => { uses++; return fn(page); }, discardTab: async () => { url = "about:blank"; } } as unknown as BrowserManager;
const sites = new Sites(join(root, "config"), join(root, "data"));
const runner = new Runner(sites, browser, join(root, "data"));
const artifacts = new Artifacts(join(root, "data"));
const site = "example.test";
try {
  assert.equal(canonical({b: 2, a: 1}), canonical({a: 1, b: 2}));
  assert.deepEqual(project({data: {count: 2}}, ["data.count"]), {"data.count": 2});
  assert.throws(() => project({}, ["__proto__.x"]));
  assert.throws(() => project({}, ["missing"]));
  assert.throws(() => assertSchema({type: "array", minItems: 1}, [], "result"));
  assert.throws(() => assertSchema({type:"string",format:"email"}, "bad", "result"), /unsupported/);
  assert.throws(() => assertSchema({type:"object",properties:{known:{}},required:["known"]}, {}, "result"), /required/);

  const large = {count: 1, body: "synthetic ".repeat(2000)};
  const overflow = await artifacts.output(large, {maxResultChars: 256});
  assert.equal(overflow.result_omitted, true);
  assert.ok(overflow.artifact);
  const ref = overflow.artifact!;
  const first = await artifacts.read(ref.id, 0, 100);
  assert.equal(first.returned_chars, 100);
  assert.equal(first.next_offset, 100);
  assert.equal(first.text, JSON.stringify(large).slice(0, 100));
  const found = await artifacts.read(ref.id, 0, 300, "synthetic");
  assert.ok("text" in found && found.text!.includes("synthetic"));
  await assert.rejects(artifacts.read("../secrets"));
  await assert.rejects(artifacts.read(ref.id, -1));
  if (process.platform !== "win32") assert.equal((await stat(join(root, "data", "artifacts", `${ref.id}.json`))).mode & 0o777, 0o600);
  const selected = await artifacts.output(large, {resultFields: ["count"], storeResult: true});
  assert.deepEqual(selected.result, {count: 1});
  assert.deepEqual(JSON.parse((await artifacts.read(selected.artifact!.id, 0, 30000)).text!), large);

  const original = `export const meta={description:"Count reads",effect:"read",cacheTtlMs:10000,argsSchema:{type:"object",properties:{value:{type:"integer"}},required:["value"],additionalProperties:false},resultSchema:{type:"object",properties:{calls:{type:"integer"}},required:["calls"]}};
let calls=0; export async function run({args}){return {calls:++calls,value:args.value};}`;
  await sites.save(site, "counter", original);
  await assert.rejects(sites.save(site, "counter", `export const meta={description:"bad",effect:"write",safe:true};export async function run(){}`));
  assert.equal(await sites.read(site, "counter"), original, "invalid metadata save rolls back");
  const before = uses;
  await assert.rejects(runner.run(site, "counter", {value:"wrong"}), /arguments/);
  assert.equal(uses, before, "bad args fail before browser attachment");
  const one = await runner.run(site, "counter", {value:1});
  const two = await runner.run(site, "counter", {value:1});
  assert.equal(one.ok, true); assert.equal(two.cached, true); assert.deepEqual(two.result, one.result);
  assert.equal(uses, before+1, "cache hit does not touch the browser");
  assert.equal((await runner.run(site, "counter", {value:1}, {fresh:true})).cached, undefined);
  await sites.save(site, "helper", `export const meta={description:"Helper",safe:true};export async function run(){return 1;}`);
  assert.equal((await runner.run(site, "counter", {value:1})).cached, undefined, "dependency edits invalidate cache");
  assert.equal(runner.clearCache(site), 2);

  const verified = await runner.try(site, `export const meta={description:"Empty inventory",resultSchema:{type:"array",minItems:1}};export async function run(){return [];}`);
  assert.equal(verified.ok, false); assert.match(verified.error!, /result/);
  const postcondition = await runner.try(site, `export const meta={description:"Wrong result"};export async function run(){return [];}export async function verify(ctx,value){if(!value.length)throw new Error("inventory is empty");}`);
  assert.equal(postcondition.ok, false); assert.match(postcondition.error!, /inventory is empty/);
  assert.equal(postcondition.snapshot, undefined); assert.equal(postcondition.screenshot, undefined);
  assert.equal(screenshots, 0, "compact failure captures no screenshot");
  await runner.try(site, `export const meta={description:"fail"};export async function run(){throw new Error("fail");}`, {}, {diagnostics:"full"});
  assert.equal(screenshots, 1);
  const falseVerification=await runner.try(site,`export const meta={description:"False postcondition"};export async function run(){return 1;}export async function verify(){return false;}`);
  assert.equal(falseVerification.ok,false);assert.match(falseVerification.error!,/postcondition failed/);
  await sites.save(site,"failingChild",`export const meta={description:"Bad child",safe:true,resultSchema:{type:"array",minItems:1}};export async function run(){return [];}`);
  const childResult=await runner.try(site,`export const meta={description:"Parent",safe:true};export async function run({call}){return call("failingChild");}`);
  assert.equal(childResult.ok,false);assert.match(childResult.error!,/failingChild result/);

  const policy = policySchema.parse({allowed_paths:["/work/*"],denied_paths:["/work/private*"],require_write_approval:true});
  assertUrl(site, policy, "https://example.test/work/public?sort=1");
  for (const blocked of ["https://example.test/discussions", "https://example.test/work/private", "https://other.test/work/public"]) assert.throws(() => assertUrl(site, policy, blocked));
  // Simulate intercepted HTTP navigation to verify redirect/retry options without Chrome.
  let handler: any, location: string | undefined, fetched=0, disposed=0, navigationUrl="about:blank";
  const frame={};
  const routedPage:any={...page,url:()=>navigationUrl,mainFrame:()=>frame,
    route:async (_pattern:any,cb:any)=>{handler=cb;},unroute:async()=>{handler=undefined;},
    goto:async (target:string)=>{
      let aborted=false;
      await handler({request:()=>({isNavigationRequest:()=>true,frame:()=>frame,url:()=>target}),
        fetch:async (options:any)=>{fetched++;assert.deepEqual(options,{maxRedirects:0,maxRetries:0});return {status:()=>location?302:200,headers:()=>location?{location}:{},dispose:async()=>{disposed++;}};},
        fulfill:async()=>{},abort:async()=>{aborted=true;},fallback:async()=>{throw new Error("navigation must not bypass routing");}});
      if(aborted)throw new Error("transport blocked");navigationUrl=target;
    }};
  await withPolicy(routedPage,site,policy,async guarded=>{await guarded.goto("https://example.test/work/public");});
  location="/work/private";
  await assert.rejects(withPolicy(routedPage,site,policy,async guarded=>{await guarded.goto("https://example.test/work/redirect");}),/denied/);
  location="/work/public";
  await assert.rejects(withPolicy(routedPage,site,policy,async guarded=>{await guarded.goto("https://example.test/work/redirect");}),/HTTP redirects/);
  assert.equal(fetched,3);assert.equal(disposed,3,"HTTP responses are released after fulfill or denial");
  await sites.writePolicy(site, policy);
  await sites.save(site,"writer",`export const meta={description:"Write",effect:"write"};export async function run(){return "done";}`);
  const priorUses=uses;
  await assert.rejects(runner.run(site,"writer"), /approved/);
  assert.equal(uses,priorUses,"unapproved write fails before attachment");
  url="https://example.test/work/public";
  assert.equal((await runner.run(site,"writer",{}, {approved:true})).ok,true);
  const denied = await runner.try(site,`export const meta={description:"Denied read",effect:"read"};export async function run({page}){await page.goto("https://example.test/discussions");return 1;}`);
  assert.equal(denied.ok,false); assert.equal(denied.snapshot,undefined);
  url="https://example.test/discussions";
  const beforeReads=domReads;
  const blockedRead=await runner.try(site,`export const meta={description:"Denied DOM",effect:"read"};export async function run({page}){return page.title();}`,{}, {diagnostics:"full"});
  assert.equal(blockedRead.ok,false); assert.equal(domReads,beforeReads, "denied reads and diagnostics do not access DOM");
  await assert.rejects(runner.diagnostics(site));
  url="https://example.test/work/public";
  await withPolicy(page as Page,site,policy,async guarded=>{
    const loc=guarded.getByRole("heading");
    url="https://example.test/discussions";
    assert.throws(()=>loc.count(), /denied/,"locators check scope at use, not creation");
  }).catch(error=>assert.match(error.message,/denied/));

  await sites.writePolicy(site,{});
  await sites.save(site,"drift",`export const meta={description:"Drift test",effect:"read",safe:true,cacheTtlMs:10000};let runs=0;export async function run(){if(++runs>1)throw new Error("fresh drift");return runs;}`);
  assert.equal((await runner.run(site,"drift")).ok,true);
  const checked=await runner.check(site);
  assert.equal(checked.find(r=>r.name==="drift")!.ok,false,"health checks must not hide drift behind cached success");
  const controller=new AbortController();controller.abort();
  const priorCancelled=uses;
  await assert.rejects(runner.run(site,"counter",{value:1},{signal:controller.signal}),/cancelled/);
  assert.equal(uses,priorCancelled);
  const circular=await runner.try(site,`export const meta={description:"non-JSON"};export async function run(){const value={};value.self=value;return value;}`);
  assert.equal(circular.ok,true);assert.match(circular.output_error!,/already completed/);
  url="about:blank";
  await sites.save(site,"expiring",`export const meta={description:"Expiry",effect:"read",cacheTtlMs:1};export async function run(){return 1;}`);
  await runner.run(site,"expiring");
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await runner.run(site,"expiring")).cached,undefined,"expired reads rerun");
  assert.equal((await runner.try(site,`export const meta={description:"Timeout",safe:true};export async function run(){await new Promise(()=>{});}`,{}, {timeoutMs:5})).aborted,true);
  const recoverable=await runner.try(site,`export const meta={description:"Projection",effect:"write"};export async function run(){return {count:1};}`,{}, {resultFields:["missing"]});
  assert.equal(recoverable.ok,true);assert.ok(recoverable.output_error);assert.ok(recoverable.artifact);
  assert.deepEqual(JSON.parse((await artifacts.read(recoverable.artifact!.id)).text!),{count:1});
  await writeFile(join(sites.dir(site),"policy.json"),'{"allowed_paths":"bad"}');
  const beforeInvalidPolicy=uses;
  await assert.rejects(runner.run(site,"expiring"));
  assert.equal(uses,beforeInvalidPolicy,"malformed policy fails before browser access");
  console.error("regression ok");
} finally { await rm(root,{recursive:true,force:true}); }
