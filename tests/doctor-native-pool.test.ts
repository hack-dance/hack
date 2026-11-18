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
    ...overrides,
  };
}

test("a running pool with no graph warns, with its memory and the exact stop command", () => {
  const check = nativePoolIdleCheck({ status: status({}), runtime });
  expect(check.status).toBe("warn");
  expect(check.nativePool).toEqual({
    state: "idle",
    graphRuns: 0,
    memoryBytes: 2_147_483_648,
    guestMemoryMib: 4096,
  });
  expect(check.message).toContain("holds 2.0 GiB");
  expect(check.message).toContain(
    "Stop it with: /opt/hack/hack-native --candidate-root '/Users/example/Library/Application Support/hack-native' runtime down --json"
  );
});

test("a pool serving graphs, a stopped pool and an unread inventory never warn", () => {
  expect(
    nativePoolIdleCheck({ status: status({ graph_runs: 2 }), runtime })
  ).toMatchObject({
    status: "ok",
    message: "The native VM pool serves 2 project graphs.",
    nativePool: { state: "in_use", graphRuns: 2 },
  });
  for (const stopped of [
    status({ phase: "stopped" }),
    status({ phase: "uninitialized", process_alive: false }),
    status({ phase: "running", process_alive: false }),
  ]) {
    expect(nativePoolIdleCheck({ status: stopped, runtime })).toMatchObject({
      status: "ok",
      nativePool: { state: "stopped", memoryBytes: null },
    });
  }
  // An older runtime without the field, or an inventory it could not read.
  for (const unknown of [
    status({ graph_runs: null }),
    status({ graph_runs: undefined }),
    status({ graph_runs: -1 }),
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
  expect(check.message).toContain("holds up to 4096 MiB of guest memory");
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
