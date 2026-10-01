import { open, readFile, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Cross-process lock so agents sharing one Chrome take turns driving it.
export async function withFileLock<T>(path: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      const age = Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now());
      if ((pid && !alive(pid)) || (!pid && age > 60_000)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`browser is busy (lock held by pid ${pid || "unknown"})`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
