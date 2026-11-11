/**
 * Advisory stall tracking on a monotonic clock.
 *
 * A command is stalled when it is alive and has produced no output and no
 * state change for `stallAfterMs`. One `command.stalled` is reported per quiet
 * period, and `command.resumed` when activity returns. Nothing acts on a
 * stall: it never feeds a decision to stop a command. Quiet builds and lock
 * waits look exactly like stalls.
 */
export type StallTransition =
  | {
      readonly type: "command.stalled";
      readonly idleMs: number;
      readonly lastOutputAt: string | null;
    }
  | {
      readonly type: "command.resumed";
      readonly idleMs: number;
    };

export class StallTracker {
  private readonly stallAfterMs: number;
  private lastActivityMono: number;
  private lastOutputWall: string | null = null;
  private stalled = false;

  /** `stallAfterMs` 0 disables detection. */
  constructor(stallAfterMs: number, nowMono: number) {
    this.stallAfterMs = stallAfterMs;
    this.lastActivityMono = nowMono;
  }

  get isStalled(): boolean {
    return this.stalled;
  }

  /** Record output or a state change. Returns `resumed` when a stall ends. */
  activity(opts: {
    readonly nowMono: number;
    readonly wall: string;
    readonly output: boolean;
  }): StallTransition | null {
    const idleMs = Math.max(0, opts.nowMono - this.lastActivityMono);
    this.lastActivityMono = opts.nowMono;
    if (opts.output) {
      this.lastOutputWall = opts.wall;
    }
    if (!this.stalled) {
      return null;
    }
    this.stalled = false;
    return { type: "command.resumed", idleMs };
  }

  /** Check for a new stall; returns `stalled` once per quiet period. */
  check(nowMono: number): StallTransition | null {
    if (this.stallAfterMs <= 0 || this.stalled) {
      return null;
    }
    const idleMs = nowMono - this.lastActivityMono;
    if (idleMs < this.stallAfterMs) {
      return null;
    }
    this.stalled = true;
    return {
      type: "command.stalled",
      idleMs: Math.floor(idleMs),
      lastOutputAt: this.lastOutputWall,
    };
  }
}
