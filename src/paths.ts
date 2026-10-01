import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Paths = { config: string; data: string };

function xdg(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && isAbsolute(value) ? value : join(homedir(), fallback);
}

export function defaultPaths(): Paths {
  if (process.platform === "darwin") {
    const support = join(homedir(), "Library", "Application Support", "webnav");
    return { config: support, data: support };
  }
  return {
    config: join(xdg("XDG_CONFIG_HOME", ".config"), "webnav"),
    data: join(xdg("XDG_DATA_HOME", ".local/share"), "webnav"),
  };
}

// stdout belongs to MCP; everything human-readable goes to stderr.
export function log(...parts: unknown[]): void {
  process.stderr.write(`[webnav] ${parts.map(String).join(" ")}\n`);
}
