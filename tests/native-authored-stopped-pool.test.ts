import { expect, test } from "bun:test";
import {
  NATIVE_AUTHORED_STOPPED_POOL_NOTICE,
  NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED,
  startStoppedPoolForAuthoredRecovery,
} from "../src/backends/native-authored-stopped-pool.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "../src/backends/native-runtime-client.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };
const projectRoot = "/fixture/project";
const RUN = "a".repeat(32);
const UP = [
  "runtime",
  "up",
  "--profile",
  "development",
  "--project-share",
  projectRoot,
  "--unfiltered-source",
  "--json",
];
const BOOT = ["graph", "native", "boot", "--run-id", RUN, "--json"];

function boot(fields: Record<string, unknown>) {
  return {
    version: 1,
    kind: "native-graph-boot",
    run: RUN,
    phase: "ready-observed",
    ended_boot: true,
    ended_boot_recoverable: true,
    ...fields,
  };
}

function invoker(status: () => unknown, check: () => unknown = () => boot({})) {
  const calls: string[][] = [];
  const invoke = ((request: { readonly args: readonly string[] }) => {
    calls.push([...request.args]);
    if (request.args[1] === "status") {
      return Promise.resolve(status());
    }
    if (request.args[2] === "boot") {
      return Promise.resolve(check());
    }
    return Promise.resolve({ phase: "running" });
  }) as unknown as typeof invokeNativeRuntime;
  return { calls, invoke };
}

// HACK-2715: a native-authored run after `runtime down --force` (or a crash)
// needs a running pool for its owner's stop or its recovery. A stopped pool is
// started with every start's arguments, and the command says so once, only when
// the run's receipt shows the cleanup can proceed (review M3).
test("HACK-2715: hack down starts only a pool proven stopped, with the start arguments", async () => {
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
        run: () => Promise.resolve(RUN),
        invoke,
        notice: (line) => notices.push(line),
      })
    ).toBe(started);
    expect(calls[0]).toEqual(["runtime", "status", "--json"]);
    if (started) {
      expect(calls).toEqual([["runtime", "status", "--json"], BOOT, UP]);
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
      run: () => Promise.resolve(RUN),
      invoke: failing,
      notice: () => {
        throw new Error("no notice");
      },
    })
  ).toBe(false);
});

// HACK-2715 review M3: the receipt is checked before the pool starts. A run of
// the current boot, a removed run, an unreadable or foreign check, or no run
// at all starts nothing; a run that cleanup from an ended boot refuses is
// refused by name, also without starting the pool.
test("HACK-2715 review: the receipt is checked before any pool is started", async () => {
  const stopped = () => ({ phase: "stopped", process_alive: false });
  for (const check of [
    () => boot({ ended_boot: false, ended_boot_recoverable: false }),
    () => boot({ phase: "removed" }),
    () => boot({ run: "b".repeat(32) }),
    () => boot({ kind: "native-graph-recovery-selection" }),
    () => ({ ...boot({}), ended_boot: "yes" }),
    () => Promise.reject(new Error("no journal")),
  ]) {
    const { calls, invoke } = invoker(stopped, check);
    expect(
      await startStoppedPoolForAuthoredRecovery({
        runtime,
        projectRoot,
        run: () => Promise.resolve(RUN),
        invoke,
        notice: () => {
          throw new Error("no notice");
        },
      })
    ).toBe(false);
    expect(calls).toEqual([["runtime", "status", "--json"], BOOT]);
  }
  for (const run of [
    () => Promise.resolve(null),
    () => Promise.resolve("not-a-run"),
    () => Promise.reject(new Error("unreadable")),
  ]) {
    const { calls, invoke } = invoker(stopped);
    expect(
      await startStoppedPoolForAuthoredRecovery({
        runtime,
        projectRoot,
        run,
        invoke,
      })
    ).toBe(false);
    expect(calls).toEqual([["runtime", "status", "--json"]]);
  }
  const { calls, invoke } = invoker(stopped, () =>
    boot({ ended_boot_recoverable: false })
  );
  const refused = await startStoppedPoolForAuthoredRecovery({
    runtime,
    projectRoot,
    run: () => Promise.resolve(RUN),
    invoke,
    notice: () => {
      throw new Error("no notice");
    },
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(NativeRuntimeRequestError);
  expect((refused as NativeRuntimeRequestError).nativeCode).toBe(
    NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED
  );
  expect(calls).toEqual([["runtime", "status", "--json"], BOOT]);
});
