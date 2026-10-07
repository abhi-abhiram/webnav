import { z } from "zod";
import type { Page, Locator, Route } from "playwright-core";

const pathPattern = z.string().startsWith("/").max(1000).refine(s => !/[?#]/.test(s), "use pathname patterns without query/hash");
export const policySchema = z.object({
  allowed_paths: z.array(pathPattern).optional(),
  denied_paths: z.array(pathPattern).default([]),
  require_write_approval: z.boolean().default(false),
}).strict();
export type SitePolicy = z.infer<typeof policySchema>;
export class PolicyError extends Error {}

function matches(path: string, pattern: string): boolean {
  const regex = pattern.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${regex}$`).test(path);
}
export function assertUrl(site: string, policy: SitePolicy | null, input: string): void {
  if (!policy || input === "about:blank") return;
  const url = new URL(input);
  const host = url.host.toLowerCase().replace(":", "_");
  if (host !== site || !["http:", "https:"].includes(url.protocol) || url.username || url.password || policy.denied_paths.some(p => matches(url.pathname, p)) || (policy.allowed_paths && !policy.allowed_paths.some(p => matches(url.pathname, p)))) {
    throw new PolicyError(`site policy denied URL: ${url.origin}${url.pathname}`);
  }
}
export function assertEffect(policy: SitePolicy | null, effect: "read" | "write" | undefined, safe: boolean | undefined, approved: boolean | undefined): void {
  if (policy?.require_write_approval && effect !== "read" && !safe && !approved) throw new PolicyError("site policy requires approved: true for write or unclassified functions");
}

// Guard accidental scope drift in trusted local code. This is NOT a JavaScript sandbox:
// imports, evaluate() inside an allowed page, element/frame handles, and raw CDP can bypass it.
// Denied main-frame network navigations are blocked before loading. HTTP redirects are
// blocked conservatively: Playwright routes only the first URL in a redirect chain. SPA
// path changes fail at the next guarded operation. Do not use this as adversarial-code confinement.
export async function withPolicy<T>(page: Page, site: string, policy: SitePolicy | null, fn: (guarded: Page) => Promise<T>): Promise<T> {
  if (!policy) return fn(page);
  const checked = () => assertUrl(site, policy, page.url());
  let blocked: PolicyError | undefined;
  const route = async (r: Route) => {
    if (r.request().isNavigationRequest() && r.request().frame() === page.mainFrame()) {
      try {
        assertUrl(site, policy, r.request().url());
        // Do not let an allowed initial URL redirect around the guard. Fetch exactly once
        // with no redirects, then preserve the response at the original browser URL.
        const response = await r.fetch({ maxRedirects: 0, maxRetries: 0 });
        try {
          const location = response.headers().location;
          if (response.status() >= 300 && response.status() < 400 && location) {
            assertUrl(site, policy, new URL(location, r.request().url()).href);
            throw new PolicyError("HTTP redirects are not followed under site policy; navigate to a reviewed direct URL");
          }
          await r.fulfill({ response });
        } finally { await response.dispose().catch(() => {}); }
        return;
      } catch (e) {
        blocked = e instanceof PolicyError ? e : new PolicyError("scoped navigation failed before a response could be delivered");
        await r.abort("blockedbyclient").catch(() => {});
        return;
      }
    }
    await r.fallback();
  };
  await page.route("**/*", route);
  const proxies = new WeakMap<object, object>();
  const wrap = (target: any): any => {
    if (proxies.has(target)) return proxies.get(target);
    const proxy = new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function") return value && ["keyboard", "mouse", "touchscreen"].includes(String(key)) ? wrap(value) : value;
      return (...args: any[]) => {
        if (blocked) throw blocked;
        if (key === "goto") assertUrl(site, policy, new URL(args[0], page.url() === "about:blank" ? `https://${site.replace(/_(\d+)$/, ":$1")}` : page.url()).href);
        else if (!["url", "isClosed", "setDefaultTimeout", "on", "off", "once"].includes(String(key))) checked();
        const result = value.apply(object, args);
        const wrapped = (v: any) => {
          if (blocked) throw blocked;
          if (!["url", "isClosed", "setDefaultTimeout", "on", "off", "once"].includes(String(key))) checked();
          if (Array.isArray(v)) return v.map(item => item && typeof item.locator === "function" ? wrap(item) : item);
          if (v === page) return wrap(page);
          if (v && typeof v === "object" && typeof v.locator === "function" && (typeof v.count === "function" || typeof v.getByRole === "function")) return wrap(v as Locator);
          return v;
        };
        return result?.then ? result.then(wrapped) : wrapped(result);
      };
    }});
    proxies.set(target, proxy);
    return proxy;
  };
  try { const result = await fn(wrap(page)); if (blocked) throw blocked; checked(); return result; }
  catch (error) { throw blocked ?? error; }
  finally { await page.unroute("**/*", route).catch(() => {}); }
}
