import { expect, test } from "bun:test";
import {
  isNativeAuthoredEndedBootRefusal,
  NATIVE_AUTHORED_STOPPED_POOL_NOTICE,
  NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED,
  nativeAuthoredEndedBootRefusal,
  startStoppedPoolForAuthoredRecovery,
} from "../src/backends/native-authored-stopped-pool.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "../src/backends/native-runtime-client.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };
const projectRoot = "/fixture/project";
const RUN = "a".repeat(32);
// The pool boots exactly as recorded: no project share is asked for, because
// the pool may already share another project's root (seen on a real VM at
// c1dfac73: `project_share_extension_required`, nothing started).
const UP = ["runtime", "up", "--json"];
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
  // HACK-2715 review round 2 (L4): with no selected run, no runtime call is made.
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
    expect(calls).toEqual([]);
    expect(
      await nativeAuthoredEndedBootRefusal({
        runtime,
        projectRoot,
        run,
        invoke,
      })
    ).toBeUndefined();
    expect(calls).toEqual([]);
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

// HACK-2715 review round 2 (Codex P2): a provider that died under the pool leaves
// its record `running` and `runtime status` reports `process-exited`. The
// HACK-2579 boundary (`runtime recover`) records it stopped first, so the run's
// receipt then reads as of an ended boot and is recovered as after a forced stop.
// A pool whose recovery is refused starts nothing.
test("HACK-2715 review round 2: a pool whose provider died is recovered before the receipt is checked", async () => {
  const run = (recovered: unknown) => {
    const calls: string[][] = [];
    const notices: string[] = [];
    const invoke = ((request: { readonly args: readonly string[] }) => {
      calls.push([...request.args]);
      if (request.args[1] === "status") {
        return Promise.resolve({
          phase: "process-exited",
          process_alive: false,
        });
      }
      if (request.args[1] === "recover") {
        return Promise.resolve(recovered);
      }
      if (request.args[2] === "boot") {
        return Promise.resolve(boot({}));
      }
      return Promise.resolve({ phase: "running" });
    }) as unknown as typeof invokeNativeRuntime;
    return {
      calls,
      notices,
      result: startStoppedPoolForAuthoredRecovery({
        runtime,
        projectRoot,
        run: () => Promise.resolve(RUN),
        invoke,
        notice: (line) => notices.push(line),
      }).catch((error: unknown) => error),
    };
  };
  const { NATIVE_EXITED_RUNTIME_NOTICE } = await import(
    "../src/backends/native-runtime-preflight.ts"
  );
  const recovered = run({ phase: "recovered-unclean", process_alive: false });
  expect(await recovered.result).toBe(true);
  expect(recovered.calls).toEqual([
    ["runtime", "status", "--json"],
    ["runtime", "status", "--json"],
    ["runtime", "recover", "--json"],
    BOOT,
    UP,
  ]);
  expect(recovered.notices).toEqual([
    NATIVE_EXITED_RUNTIME_NOTICE,
    NATIVE_AUTHORED_STOPPED_POOL_NOTICE,
  ]);
  // A recovery that leaves the provider exited is refused; nothing starts.
  const refused = run({ phase: "process-exited" });
  expect(await refused.result).toBeInstanceOf(NativeRuntimeRequestError);
  expect(refused.calls.map((args) => args[1])).toEqual([
    "status",
    "status",
    "recover",
  ]);
});

// HACK-2715 review round 2 (M1): after a failed stop on a pool `hack down` did
// not start, the read-only check names a boot-bound run of an ended boot
// whatever the pool's state, without a status call or a pool start. Any other
// check names nothing.
test("HACK-2715 review round 2: a failed stop names a boot-bound ended-boot run from the receipt alone", async () => {
  const running = () => ({ phase: "running", process_alive: true });
  const { calls, invoke } = invoker(running, () =>
    boot({ ended_boot_recoverable: false })
  );
  const refusal = await nativeAuthoredEndedBootRefusal({
    runtime,
    projectRoot,
    run: () => Promise.resolve(RUN),
    invoke,
  });
  expect(refusal).toBeInstanceOf(NativeRuntimeRequestError);
  expect(isNativeAuthoredEndedBootRefusal(refusal)).toBe(true);
  expect(calls).toEqual([BOOT]);
  for (const check of [
    () => boot({}),
    () => boot({ ended_boot: false, ended_boot_recoverable: false }),
    () => boot({ phase: "removed", ended_boot_recoverable: false }),
    () => boot({ run: "b".repeat(32), ended_boot_recoverable: false }),
    () => Promise.reject(new Error("no journal")),
  ]) {
    const other = invoker(running, check);
    expect(
      await nativeAuthoredEndedBootRefusal({
        runtime,
        projectRoot,
        run: () => Promise.resolve(RUN),
        invoke: other.invoke,
      })
    ).toBeUndefined();
    expect(other.calls).toEqual([BOOT]);
  }
  expect(isNativeAuthoredEndedBootRefusal(new Error("other"))).toBe(false);
});
