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
    // Go to a page of this site unless already exactly there. Use this when the function
    // needs to start on a specific page.
    open: async (path = "/") => {
      const target = new URL(path, origin).href;
      if (page.url() !== target) await page.goto(target);
    },
    // Only checks the origin: goes to the path when the tab is on another site (or blank) and
    // otherwise stays on whatever page of this site it is on. Use it for steps that work from
    // any page, such as clicking a link in a global nav.
    ensureOnSite: async (path = "/") => {
      if (!page.url().startsWith(origin + "/")) await page.goto(new URL(path, origin).href);
    },
  };
}

// Picks options in an ARIA listbox dropdown opened by `trigger`. Such listboxes are often rendered
// outside the dialog holding the trigger and may stay open after a pick, where Escape would close
// the dialog as well; so the dropdown is closed by toggling its trigger. The trigger's name usually
// changes to the selection, so it is held as an element rather than re-resolved by name.
export async function pick(trigger: Locator, options: string | RegExp | (string | RegExp)[]): Promise<void> {
  const page = trigger.page();
  const button = await trigger.elementHandle();
  if (!button) throw new Error(`pick: trigger not found: ${trigger}`);
  await button.click();
  const controls = await button.getAttribute("aria-controls");
  const listbox = controls ? page.locator(`[id="${controls}"]`) : page.getByRole("listbox").filter({ visible: true }).last();
  await listbox.waitFor();
  for (const option of [options].flat()) {
    await listbox.getByRole("option", { name: option, exact: typeof option === "string" }).first().click();
  }
  if (await listbox.isVisible()) {
    if ((await button.getAttribute("aria-expanded").catch(() => null)) === "true") await button.click();
    else await page.locator('[aria-haspopup][aria-expanded="true"]').first().click();
  }
  await listbox.waitFor({ state: "hidden" });
  await button.dispose();
}
