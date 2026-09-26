/** Bound active command work across sessions. Busy callers receive an error;
 * no hidden queue retains their arguments or environment. Slots release after
 * command output and audit work finish, including cancellation cleanup.
 */
export class McpCommandAdmission {
  private active = 0;
  private stopped = false;
  private readonly waiters = new Set<() => void>();
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("MCP command limit must be a positive integer");
    }
    this.limit = limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      throw new Error("MCP backend is shutting down");
    }
    if (this.active >= this.limit) {
      throw new Error(
        "MCP backend is busy; retry after an active command finishes"
      );
    }
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      if (this.active === 0) {
        for (const resolve of this.waiters) {
          resolve();
        }
        this.waiters.clear();
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async drain(): Promise<void> {
    if (this.active === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.waiters.add(resolve));
  }
}
