import { expect, test } from "bun:test";
import {
  NATIVE_AUTHORED_STOPPED_POOL_NOTICE,
  startStoppedPoolForAuthoredRecovery,
} from "../src/backends/native-authored-stopped-pool.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };
const projectRoot = "/fixture/project";

function invoker(status: () => unknown) {
  const calls: string[][] = [];
  const invoke = ((request: { readonly args: readonly string[] }) => {
    calls.push([...request.args]);
    if (request.args[1] === "status") {
      return Promise.resolve(status());
    }
    return Promise.resolve({ phase: "running" });
  }) as unknown as typeof invokeNativeRuntime;
  return { calls, invoke };
}

// HACK-2715: a native-authored recovery after `runtime down --force` (or a crash)
// needs a running pool; it starts a stopped one with every start's arguments and
// says so once, and leaves a running or unreadable one alone.
test("HACK-2715: authored recovery starts only a pool proven stopped, with the start arguments", async () => {
  for (const [status, started] of [
    [{ phase: "stopped", process_alive: false }, true],
    [{ phase: "recovered-unclean", process_alive: null }, true],
    [{ phase: "running", process_alive: true }, false],
    [{ phase: "stopped", process_alive: true }, false],
    ["not a status", false],
  ] as const) {
    const { calls, invoke } = invoker(() => status);
    const notices: string[] = [];
    expect(
      await startStoppedPoolForAuthoredRecovery({
        runtime,
        projectRoot,
        invoke,
        notice: (line) => notices.push(line),
      })
    ).toBe(started);
    expect(calls[0]).toEqual(["runtime", "status", "--json"]);
    if (started) {
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual([
        "runtime",
        "up",
        "--profile",
        "development",
        "--project-share",
        projectRoot,
        "--unfiltered-source",
        "--json",
      ]);
      expect(notices).toEqual([NATIVE_AUTHORED_STOPPED_POOL_NOTICE]);
    } else {
      expect(calls).toHaveLength(1);
      expect(notices).toEqual([]);
    }
  }
  // A status request that fails proves nothing: the pool is left as it is.
  const failing = (() =>
    Promise.reject(
      new Error("unavailable")
    )) as unknown as typeof invokeNativeRuntime;
  expect(
    await startStoppedPoolForAuthoredRecovery({
      runtime,
      projectRoot,
      invoke: failing,
      notice: () => {
        throw new Error("no notice");
      },
    })
  ).toBe(false);
});
