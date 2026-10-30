export const TRANSFER_INACTIVITY_MS = 30_000;
export const TRANSFER_TOTAL_MS = 30 * 60_000;
export const TRANSFER_CLEANUP_MS = 2000;
/** Cancellation was attempted, but producer settlement was not established. */
export class TransferCleanupUncertain extends Error {
  readonly cleanupCause: unknown;
  constructor(cleanupCause: unknown, primaryFailure?: unknown) {
    super(
      `Download cancellation settlement is uncertain; no successful download is established.${primaryFailure instanceof Error ? ` Primary failure: ${primaryFailure.message}` : ""}`,
      { cause: primaryFailure ?? cleanupCause }
    );
    this.name = "TransferCleanupUncertain";
    this.cleanupCause = cleanupCause;
  }
}
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
  private readonly cleanupMs: number;
  private cancelIdle: () => void = () => {
    /* progress() has not installed the first idle timer yet. */
  };
  private readonly cancelTotal: () => void;
  private readonly aborted: Promise<never>;
  constructor({
    inactivityMs = TRANSFER_INACTIVITY_MS,
    totalMs = TRANSFER_TOTAL_MS,
    cleanupMs = TRANSFER_CLEANUP_MS,
    schedule = scheduleTimer,
  }: {
    inactivityMs?: number;
    totalMs?: number;
    cleanupMs?: number;
    schedule?: Schedule;
  } = {}) {
    if (
      !(
        Number.isFinite(inactivityMs) &&
        inactivityMs > 0 &&
        Number.isFinite(totalMs) &&
        totalMs > 0 &&
        Number.isFinite(cleanupMs) &&
        cleanupMs > 0
      )
    ) {
      throw new Error("Invalid transfer budget.");
    }
    this.schedule = schedule;
    this.inactivityMs = inactivityMs;
    this.cleanupMs = cleanupMs;
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
  /** Cleanup has its own finite grace even when transfer cancellation already fired.
   * A timeout/rejection is an uncertainty error, never EOF or proof of producer settlement.
   * Promise.race observes late rejections; the grace timer is always removed.
   */
  async settleCancellation(
    cancel: () => Promise<unknown>,
    primaryFailure?: unknown
  ) {
    let cancelGrace: () => void = () => {
      /* Installed by the deadline promise below. */
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      cancelGrace = this.schedule(
        () => reject(new Error("Cancellation cleanup grace expired.")),
        this.cleanupMs
      );
    });
    try {
      await Promise.race([Promise.resolve().then(cancel), deadline]);
    } catch (error) {
      throw new TransferCleanupUncertain(error, primaryFailure);
    } finally {
      cancelGrace();
    }
  }
  close() {
    this.cancelIdle();
    this.cancelTotal();
    if (!this.signal.aborted) {
      this.controller.abort(new Error("Download scope closed."));
    }
  }
}
