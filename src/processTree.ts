import { spawn, type ChildProcess } from "child_process";

/** Args for Windows process-tree kill (pure helper for tests). */
export function windowsTaskkillArgs(pid: number): string[] {
  return ["/pid", String(pid), "/T", "/F"];
}

/**
 * Kill a child and, on Windows, its entire process tree via taskkill /T.
 * Safe to call multiple times; ignores missing processes.
 */
export function terminateProcessTree(
  child: ChildProcess | null | undefined,
): void {
  if (!child || child.killed) return;

  const pid = child.pid;
  try {
    child.kill();
  } catch {
    /* already gone */
  }

  if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
    try {
      spawn("taskkill", windowsTaskkillArgs(pid), {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      /* ignore */
    }
  }
}
