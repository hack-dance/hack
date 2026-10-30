export const TRANSFER_INACTIVITY_MS = 30_000;
export const TRANSFER_TOTAL_MS = 30 * 60_000;
type Schedule = (callback: () => void, milliseconds: number) => () => void;
const scheduleTimer: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};
/** Progress resets inactivity only; it never extends the separate total budget.
 * Injectable scheduling is a fixture seam, not an environment-controlled runtime override.
 */
export class TransferBudget {
  private readonly controller = new AbortController();
  private readonly schedule: Schedule;
  private readonly inactivityMs: number;
  private cancelIdle: () => void = () => {
    /* progress() has not installed the first idle timer yet. */
  };
  private readonly cancelTotal: () => void;
  private readonly aborted: Promise<never>;
  constructor({
    inactivityMs = TRANSFER_INACTIVITY_MS,
    totalMs = TRANSFER_TOTAL_MS,
    schedule = scheduleTimer,
  }: { inactivityMs?: number; totalMs?: number; schedule?: Schedule } = {}) {
    if (
      !(
        Number.isFinite(inactivityMs) &&
        inactivityMs > 0 &&
        Number.isFinite(totalMs) &&
        totalMs > 0
      )
    ) {
      throw new Error("Invalid transfer budget.");
    }
    this.schedule = schedule;
    this.inactivityMs = inactivityMs;
    this.aborted = new Promise<never>((_resolve, reject) =>
      this.signal.addEventListener("abort", () => reject(this.signal.reason), {
        once: true,
      })
    );
    void this.aborted.catch(() => {
      /* wait() reports cancellation; avoid an unhandled rejection between waits. */
    });
    this.cancelTotal = schedule(
      () =>
        this.controller.abort(
          new Error("Release download exceeded its total transfer budget.")
        ),
      totalMs
    );
    this.progress();
  }
  get signal() {
    return this.controller.signal;
  }
  progress() {
    this.cancelIdle();
    if (!this.signal.aborted) {
      this.cancelIdle = this.schedule(
        () =>
          this.controller.abort(
            new Error("Release download stalled beyond its inactivity budget.")
          ),
        this.inactivityMs
      );
    }
  }
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return await Promise.race([operation(), this.aborted]);
  }
  close() {
    this.cancelIdle();
    this.cancelTotal();
    if (!this.signal.aborted) {
      this.controller.abort(new Error("Download scope closed."));
    }
  }
}
