import { expect, test } from "bun:test";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import {
  NATIVE_POOL_IDLE_CHECK,
  nativePoolIdleCheck,
  nativePoolStopCommand,
  readNativePoolReport,
} from "../src/lib/doctor-native-pool.ts";

const runtime = {
  binary: "/opt/hack/hack-native",
  home: "/Users/example/Library/Application Support/hack-native",
};

function status(overrides: Record<string, unknown>) {
  return {
    phase: "running",
    process_alive: true,
    guest_memory_mib: 4096,
    provider_memory: {
      resident_bytes: 1_000_000_000,
      physical_footprint_bytes: 2_147_483_648,
    },
    graph_runs: 0,
    pool_idle: true,
    ...overrides,
  };
}

test("a pool the runtime reports idle warns, with its memory and the exact stop command", () => {
  const check = nativePoolIdleCheck({ status: status({}), runtime });
  expect(check.status).toBe("warn");
  expect(check.nativePool).toEqual({
    state: "idle",
    graphRuns: 0,
    memoryBytes: 2_147_483_648,
    guestMemoryMib: 4096,
  });
  expect(check.message).toContain("It holds 2.0 GiB");
  expect(check.message).toContain(
    "Stop it with: /opt/hack/hack-native --candidate-root '/Users/example/Library/Application Support/hack-native' runtime down --json"
  );
});

test("a pool in use, a stopped pool and an unproven answer never warn", () => {
  expect(
    nativePoolIdleCheck({
      status: status({ graph_runs: 2, pool_idle: false }),
      runtime,
    })
  ).toMatchObject({
    status: "ok",
    message:
      "The native VM pool records 2 project graphs, running or retained.",
    nativePool: { state: "in_use", graphRuns: 2 },
  });
  // In use by something other than a graph (an exec session or allocation).
  expect(
    nativePoolIdleCheck({ status: status({ pool_idle: false }), runtime })
  ).toMatchObject({
    status: "ok",
    message: "The native VM pool is in use.",
    nativePool: { state: "in_use" },
  });
  for (const stopped of [
    status({ phase: "stopped", pool_idle: false }),
    status({ phase: "uninitialized", process_alive: false }),
    status({ phase: "process-exited", process_alive: false }),
    status({ phase: "running", process_alive: false }),
  ]) {
    expect(nativePoolIdleCheck({ status: stopped, runtime })).toMatchObject({
      status: "ok",
      nativePool: { state: "stopped", memoryBytes: null },
    });
  }
  // The runtime alone decides: an older runtime without the field, an
  // unestablished answer, or liveness that is not proven is never idle.
  for (const unknown of [
    status({ pool_idle: null }),
    status({ pool_idle: undefined }),
    status({ pool_idle: "true" }),
    status({ process_alive: null }),
    status({ process_alive: undefined }),
  ]) {
    expect(nativePoolIdleCheck({ status: unknown, runtime })).toMatchObject({
      status: "ok",
      nativePool: { state: "unknown" },
    });
  }
  expect(nativePoolIdleCheck({ status: null, runtime })).toMatchObject({
    status: "ok",
    message: "Skipped (native runtime status unavailable)",
  });
});

test("without a provider memory reading the guest reservation is named", () => {
  const check = nativePoolIdleCheck({
    status: status({ provider_memory: null }),
    runtime,
  });
  expect(check.message).toContain("It holds up to 4096 MiB of guest memory");
  expect(
    readNativePoolReport(
      status({ provider_memory: null, guest_memory_mib: null })
    ).memoryBytes
  ).toBeNull();
});

test("the stop command quotes paths for the shell", () => {
  expect(
    nativePoolStopCommand({ binary: "/a b/hack-native", home: "/h" })
  ).toBe("'/a b/hack-native' --candidate-root /h runtime down --json");
});

test("doctor JSON reports it as a native machine check with the nativePool field", () => {
  const check = nativePoolIdleCheck({ status: status({}), runtime });
  const data = buildDoctorJsonData({
    results: [{ ...check, scope: "machine", durationMs: 1 }],
  });
  expect(data.checks[0]).toMatchObject({
    id: NATIVE_POOL_IDLE_CHECK,
    status: "warn",
    area: "native",
    scope: "machine",
    nativePool: { state: "idle", graphRuns: 0 },
  });
  // No path in the structured report.
  expect(JSON.stringify(data.checks[0]?.nativePool)).not.toContain("/");
});
