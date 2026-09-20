import { closeSync, fstatSync, read, write } from "node:fs";

export interface McpStartupChannel {
  readonly check: () => void;
  readonly request: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Observe supervisor loss while filesystem preparation is still in flight.
 * Cancellation does not interrupt or race filesystem effects: callers await each
 * effect, retain its ownership evidence, then check before advancing startup.
 */
export function createMcpStartupChannel(): McpStartupChannel {
  const descriptor = process.env.HACK_MCP_STARTUP_FD;
  if (descriptor === undefined) {
    return {
      check: () => undefined,
      request: async () => undefined,
      close: async () => undefined,
    };
  }
  const fd = Number(descriptor);
  if (!Number.isSafeInteger(fd) || fd <= 2 || !fstatSync(fd).isSocket()) {
    throw new Error("Invalid MCP startup channel");
  }
  let phase: "preparing" | "requesting" | "granted" | "closed" = "preparing";
  let failure: Error | undefined;
  let resolveGrant: (() => void) | undefined;
  let rejectGrant: ((error: Error) => void) | undefined;
  const timer = setTimeout(() => refuse(), 8000);
  function refuse(): void {
    if (phase === "granted" || phase === "closed") {
      return;
    }
    failure = new Error("MCP startup channel closed or timed out");
    phase = "closed";
    clearTimeout(timer);
    rejectGrant?.(failure);
  }
  const readDone = new Promise<void>((done) => {
    const grant = Buffer.alloc(2);
    read(fd, grant, 0, grant.length, null, (error, bytesRead) => {
      if (
        error ||
        phase !== "requesting" ||
        bytesRead !== 1 ||
        grant[0] !== 71
      ) {
        refuse();
      } else {
        phase = "granted";
        clearTimeout(timer);
        resolveGrant?.();
      }
      done();
    });
  }).catch(refuse);
  let writeDone = Promise.resolve();
  let closed = false;
  function check(): void {
    if (failure) {
      throw failure;
    }
  }
  return {
    check,
    request: () => {
      check();
      if (phase !== "preparing") {
        throw new Error("MCP startup grant already requested");
      }
      phase = "requesting";
      return new Promise<void>((resolve, reject) => {
        resolveGrant = resolve;
        rejectGrant = reject;
        writeDone = new Promise<void>((done) => {
          write(fd, Buffer.from("R"), 0, 1, null, (error, bytesWritten) => {
            if (error || bytesWritten !== 1) {
              refuse();
            }
            done();
          });
        }).catch(refuse);
      });
    },
    close: async () => {
      refuse();
      clearTimeout(timer);
      // Closing while queued I/O still names this fd could let that work touch a
      // reused descriptor. The native owner bounds the blocking read with its
      // inherited receive timeout. Observe both callbacks before releasing it.
      await Promise.all([readDone, writeDone]);
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
