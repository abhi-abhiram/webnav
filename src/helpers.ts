import type { Locator, Page } from "playwright-core";

export type Item = {
  role: string;
  name?: string;
  text?: string;
  url?: string;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean | "mixed";
  level?: number;
  [prop: string]: unknown;
};

const skip = new Set(["children", "ref", "cursor", "box"]);

// Accessible elements under a locator as plain objects: the short way to write "list X" functions.
export async function items(scope: Locator, role?: string | RegExp, opts: { depth?: number } = {}): Promise<Item[]> {
  const tree = await scope.ariaSnapshotJSON({ depth: opts.depth });
  const base = scope.page().url();
  const out: Item[] = [];
  const walk = (node: any) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const matches = role === undefined ? node.role !== "text" && node.role !== "generic"
      : typeof role === "string" ? node.role === role : role.test(node.role);
    if (matches) {
      const item: Item = { role: node.role };
      for (const [k, v] of Object.entries(node)) if (!skip.has(k) && v !== undefined) item[k] = v;
      if (typeof item.url === "string") item.url = new URL(item.url, base).href;
      out.push(item);
    }
    walk(node.children);
  };
  walk(tree);
  return out;
}

export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// discord.com → https://discord.com, localhost_3000 → http://localhost:3000
export function siteOrigin(site: string): string {
  const host = site.replace(/_(\d+)$/, ":$1");
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

export function navigation(page: Page, site: string) {
  const origin = siteOrigin(site);
  return {
    origin,
    // Go to a path on this site unless already exactly there.
    open: async (path = "/") => {
      const target = new URL(path, origin).href;
      if (page.url() !== target) await page.goto(target);
    },
    // Go to a path only when the tab is on another site (or blank); otherwise stay.
    ensureOnSite: async (path = "/") => {
      if (!page.url().startsWith(origin + "/")) await page.goto(new URL(path, origin).href);
    },
  };
}
