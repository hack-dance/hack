import { expect, test } from "bun:test";
import {
  isNativeRuntimeNotRunning,
  NativeRuntimeRequestError,
} from "../src/backends/native-runtime-client.ts";
import {
  nativeRuntimeStatusStopped,
  refuseStoppedNativeRuntime,
} from "../src/backends/native-runtime-preflight.ts";

const runtime = { binary: "/fixture/native", home: "/fixture/home" };

async function preflight(reply: () => Promise<unknown>) {
  const requests: (readonly string[])[] = [];
  const result = await refuseStoppedNativeRuntime({
    runtime,
    cwd: "/fixture/project",
    timeoutMs: 5000,
    invoke: (request) => {
      requests.push(request.args);
      return reply();
    },
  }).catch((error: unknown) => error);
  return { result, requests };
}

test.each([
  { phase: "stopped", process_alive: null },
  // Any non-running phase refuses on its own, without a dead-process signal.
  { phase: "initializing", process_alive: null },
  { phase: "uninitialized", process_alive: false },
  { phase: "process-exited", process_alive: false },
  { phase: "running", process_alive: false },
])("a status reply %j refuses as runtime_not_running", async (reply) => {
  expect(nativeRuntimeStatusStopped(reply)).toBe(true);
  const { result, requests } = await preflight(async () => reply);
  expect(isNativeRuntimeNotRunning(result)).toBe(true);
  expect(requests).toEqual([["runtime", "status", "--json"]]);
});

test("a running runtime passes", async () => {
  const { result } = await preflight(async () => ({
    phase: "running",
    process_alive: true,
  }));
  expect(result).toBeUndefined();
});

test("an inconclusive status does not refuse the start", async () => {
  for (const reply of [
    async () => ({}),
    async () => null,
    async () => {
      throw new NativeRuntimeRequestError({
        message: "Native runtime request failed (engine_protocol).",
        nativeCode: "engine_protocol",
      });
    },
    async () => {
      throw new Error("spawn failed");
    },
  ]) {
    expect((await preflight(reply)).result).toBeUndefined();
  }
});

test("a runtime_not_running refusal from the status request is kept", async () => {
  const refusal = new NativeRuntimeRequestError({
    message: "Native runtime request failed (runtime_not_running).",
    nativeCode: "runtime_not_running",
  });
  const { result } = await preflight(async () => {
    throw refusal;
  });
  expect(result).toBe(refusal);
});
