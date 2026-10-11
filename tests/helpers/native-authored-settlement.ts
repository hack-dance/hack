import { readFile } from "node:fs/promises";
import { connect } from "node:net";

/**
 * Explicit settlement latch for native authored fixtures.
 *
 * Cases in the start/exec suites spawn stand-in owners, keepers and stop
 * endpoints. The next case must not start while a prior owner, its detached
 * group or its stop socket is still present: the source-side process census
 * treats a disappearing row as a veto, and a lingering listener can be mistaken
 * for a live owner. Each fixture records what it may leave behind; `settle`
 * awaits exact absence instead of a fixed sleep and names the first target that
 * remains unconfirmed within the caller's budget.
 *
 * Only signal 0 is ever sent. The latch never kills, reaps or signals a saved
 * PID or group; an unknown lifetime is a refusal, never a cleanup.
 */
export type NativeAuthoredSettlementTarget =
  | {
      readonly kind: "process";
      readonly name: string;
      readonly pid: number;
      /** Also require the process group led by `pid` (a detached owner) to be absent. */
      readonly group: boolean;
    }
  | {
      readonly kind: "pid-file";
      readonly name: string;
      /** A file the fixture writes its own PID(s) into. A missing file means no child was captured. */
      readonly path: string;
      readonly group: boolean;
      readonly parse?: (text: string) => readonly number[];
    }
  | {
      readonly kind: "endpoint";
      readonly name: string;
      /** A loopback stop-owner listener that must refuse connections once retired. */
      readonly port: number;
    };

export type NativeAuthoredSettlement = {
  readonly record: (target: NativeAuthoredSettlementTarget) => void;
  /** Await absence of every recorded target, then forget them. Throws naming the first unsettled target. */
  readonly settle: (opts: {
    readonly budgetMs: number;
    readonly pollMs?: number;
  }) => Promise<void>;
  /** Forget recorded targets without awaiting them (retained evidence paths). */
  readonly reset: () => void;
};

const MIN_PID = 2;
const MAX_PID = 2_147_483_647;

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid >= MIN_PID && pid <= MAX_PID;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Signal 0 only. ESRCH is the only positive absence; EPERM is presence. */
function absent(target: number): boolean {
  try {
    process.kill(target, 0);
    return false;
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return true;
    }
    if (code === "EPERM") {
      return false;
    }
    throw error;
  }
}

function processSettled(pid: number, group: boolean): boolean {
  if (!validPid(pid)) {
    throw new Error("Settlement refused an invalid captured PID.");
  }
  return absent(pid) && (!group || absent(-pid));
}

/** Parse one PID per line; a partial write (no complete line) yields nothing yet. */
export function parsePidLines(text: string): readonly number[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number(line));
}

async function pidFileSettled(target: {
  readonly path: string;
  readonly group: boolean;
  readonly parse?: (text: string) => readonly number[];
}): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(target.path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
  const pids = (target.parse ?? parsePidLines)(text);
  if (pids.length === 0) {
    // The fixture has created the file but not finished writing its identity.
    return false;
  }
  return pids.every((pid) => processSettled(pid, target.group));
}

function endpointSettled(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Settlement refused an invalid captured endpoint port.");
  }
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error: unknown) =>
      finish(errorCode(error) === "ECONNREFUSED")
    );
  });
}

async function settled(
  target: NativeAuthoredSettlementTarget
): Promise<boolean> {
  switch (target.kind) {
    case "process":
      return processSettled(target.pid, target.group);
    case "pid-file":
      return await pidFileSettled(target);
    case "endpoint":
      return await endpointSettled(target.port);
    default:
      throw new Error("Settlement refused an unknown target kind.");
  }
}

/**
 * Wait until a fixture has written a positive PID to `path`.
 * Replaces fixed delays before cancelling a captured child.
 */
export async function awaitPidFile(
  path: string,
  opts: { readonly budgetMs: number; readonly pollMs?: number }
): Promise<number> {
  const deadline = performance.now() + opts.budgetMs;
  const pollMs = opts.pollMs ?? 10;
  while (true) {
    let text: string | undefined;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
    if (text !== undefined) {
      const [pid] = parsePidLines(text);
      if (pid !== undefined && validPid(pid)) {
        return pid;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `Captured child identity did not appear within ${opts.budgetMs} ms.`
      );
    }
    await Bun.sleep(pollMs);
  }
}

export function createNativeAuthoredSettlement(): NativeAuthoredSettlement {
  const targets: NativeAuthoredSettlementTarget[] = [];
  return {
    record: (target) => {
      targets.push(target);
    },
    reset: () => {
      targets.length = 0;
    },
    settle: async (opts) => {
      const started = performance.now();
      const deadline = started + opts.budgetMs;
      const pollMs = opts.pollMs ?? 10;
      while (true) {
        const pending: string[] = [];
        for (const target of targets) {
          if (!(await settled(target))) {
            pending.push(target.name);
          }
        }
        if (pending.length === 0) {
          targets.length = 0;
          return;
        }
        if (performance.now() >= deadline) {
          const elapsed = Math.round(performance.now() - started);
          throw new Error(
            `Native authored fixture settlement unconfirmed after ${elapsed} ms (budget ${opts.budgetMs} ms); first unsettled: ${pending[0]}; pending: ${pending.join(", ")}.`
          );
        }
        await Bun.sleep(pollMs);
      }
    },
  };
}
