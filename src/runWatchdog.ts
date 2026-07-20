/**
 * Dual timeout for long-running Grok processes:
 * - total: absolute wall clock from start
 * - idle: no "activity" (progress/output) for idleMs
 *
 * Call `touch()` whenever meaningful progress arrives.
 */
export class RunWatchdog {
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly totalMs: number,
    private readonly idleMs: number,
    private readonly onTimeout: (reason: "total" | "idle", message: string) => void,
  ) {
    const total = Math.max(1_000, totalMs);
    const idle = Math.max(50, Math.min(idleMs, total));

    this.totalTimer = setTimeout(() => {
      if (this.disposed) return;
      this.fire(
        "total",
        `Grok 请求超时（${Math.ceil(total / 1000)} 秒），进程已停止。`,
      );
    }, total);

    this.armIdle(idle);
  }

  /** Mark progress so the idle timer resets. */
  touch(): void {
    if (this.disposed) return;
    const idle = Math.max(50, Math.min(this.idleMs, Math.max(1_000, this.totalMs)));
    this.armIdle(idle);
  }

  dispose(): void {
    this.disposed = true;
    if (this.totalTimer !== null) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdle(idleMs: number): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.disposed) return;
      this.fire(
        "idle",
        `Grok 长时间无进度（${Math.ceil(idleMs / 1000)} 秒无输出），进程已停止。`,
      );
    }, idleMs);
  }

  private fire(reason: "total" | "idle", message: string): void {
    if (this.disposed) return;
    this.dispose();
    this.onTimeout(reason, message);
  }
}

/** Default idle: 2 minutes, never longer than the total timeout. */
export function resolveIdleTimeoutMs(totalMs: number, idleMs?: number): number {
  const total = Math.max(10_000, totalMs);
  const idle = typeof idleMs === "number" && Number.isFinite(idleMs) ? idleMs : 120_000;
  return Math.max(5_000, Math.min(idle, total));
}
