import { Buffer } from "node:buffer";
import { isRecord } from "./guards.ts";

const MAX_CENSUS_BYTES = 1024 * 1024;
const PROCESS_GROUP_STATE = /^\s*(\d+)\s+(\S+)\s*$/;

/**
 * Observe an invocation-owned group after cancellation, without signalling a
 * saved or reacquired PID. Zombies cannot execute further startup effects.
 * A missing/failed census is unknown, never proof that the group is settled.
 */
export async function waitForOwnedProcessGroupSettlement(opts: {
  readonly processGroupId: number;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const deadline = performance.now() + (opts.timeoutMs ?? 2000);
  while (performance.now() < deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    const state = await observeOwnedGroup(opts.processGroupId, remaining);
    if (state === "settled") {
      return true;
    }
    await Bun.sleep(Math.min(20, Math.max(1, deadline - performance.now())));
  }
  return false;
}

async function observeOwnedGroup(
  group: number,
  remaining: number
): Promise<"settled" | "running" | "unknown"> {
  try {
    process.kill(-group, 0);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ESRCH") {
      return "settled";
    }
  }
  try {
    const child = Bun.spawn(["/bin/ps", "-A", "-o", "pgid=,stat="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: remaining,
    });
    const [output, code] = await Promise.all([
      readBoundedCensus(child.stdout, () => child.kill("SIGKILL")),
      child.exited,
    ]);
    if (code !== 0 || output === null || !output.trim()) {
      return "unknown";
    }
    for (const line of output.trim().split("\n")) {
      const match = PROCESS_GROUP_STATE.exec(line);
      if (!match) {
        return "unknown";
      }
      if (Number(match[1]) === group && !match[2]?.startsWith("Z")) {
        return "running";
      }
    }
    return "settled";
  } catch {
    return "unknown";
  }
}

/** The census exposes only group/state columns, under one fixed byte bound. */
async function readBoundedCensus(
  stream: ReadableStream<Uint8Array>,
  onOverflow: () => void
): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_CENSUS_BYTES) {
        onOverflow();
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
