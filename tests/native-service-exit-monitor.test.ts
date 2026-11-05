import { expect, test } from "bun:test";
import {
  monitorNativeServiceExits,
  type NativeServiceExit,
} from "../src/backends/native-service-exit-monitor.ts";

const run = "a".repeat(32);
const runtime = { binary: "/not-invoked", home: "/not-invoked" };

function replies(sequence: unknown[]) {
  const calls: string[] = [];
  let index = 0;
  const invoke = async (request: { args: readonly string[] }) => {
    calls.push(request.args.join(" "));
    const reply = sequence[Math.min(index++, sequence.length - 1)];
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  return { calls, invoke };
}
function observed(services: Record<string, unknown>, phase = "ready-observed") {
  return { run, phase, services };
}

test("reports each stop once, like Compose, and ends when every service stopped", async () => {
  const { calls, invoke } = replies([
    observed({ init: { state: "exited", code: 0 }, web: { state: "running" } }),
    new Error("transient observation failure"),
    observed({ init: { state: "exited", code: 0 }, web: { state: "running" } }),
    observed({
      init: { state: "exited", code: 0 },
      web: { state: "exited", code: 3 },
    }),
  ]);
  const exits: NativeServiceExit[] = [];
  let stopped = 0;
  const controller = new AbortController();
  await monitorNativeServiceExits({
    runtime,
    projectRoot: "/fixture",
    run,
    signal: controller.signal,
    intervalMs: 1,
    invoke,
    onExit: (exit) => exits.push(exit),
    onAllStopped: () => stopped++,
  });
  expect(exits).toEqual([
    { service: "init", state: "exited", code: 0 },
    { service: "web", state: "exited", code: 3 },
  ]);
  expect(stopped).toBe(1);
  // Only the lock-free observation is read; nothing is stopped or repaired.
  expect(new Set(calls)).toEqual(
    new Set([`graph observe --run-id ${run} --json`])
  );
});

test("a restarted service that stops again is reported again; others keep up running", async () => {
  const { invoke } = replies([
    observed({ web: { state: "exited", code: 1 }, db: { state: "running" } }),
    observed({ web: { state: "running" }, db: { state: "running" } }),
    observed({ web: { state: "dead" }, db: { state: "running" } }),
    observed({ web: { state: "dead" }, db: { state: "running" } }),
  ]);
  const exits: NativeServiceExit[] = [];
  const controller = new AbortController();
  let polls = 0;
  await monitorNativeServiceExits({
    runtime,
    projectRoot: "/fixture",
    run,
    signal: controller.signal,
    intervalMs: 1,
    invoke: async (request) => {
      if (++polls >= 6) {
        controller.abort();
      }
      return await invoke(request);
    },
    onExit: (exit) => exits.push(exit),
    onAllStopped: () => {
      throw new Error("db is still running");
    },
  });
  expect(exits).toEqual([
    { service: "web", state: "exited", code: 1 },
    { service: "web", state: "dead" },
  ]);
});

test("foreign, non-ready or malformed observations are ignored and abort stops promptly", async () => {
  const { invoke } = replies([
    {
      run: "b".repeat(32),
      phase: "ready-observed",
      services: { web: { state: "exited", code: 1 } },
    },
    observed({ web: { state: "exited", code: 1 } }, "cleanup-intent"),
    observed({ "../web": { state: "exited", code: 1 } }),
    observed({ web: "exited" }),
  ]);
  const controller = new AbortController();
  const exits: NativeServiceExit[] = [];
  let polls = 0;
  await monitorNativeServiceExits({
    runtime,
    projectRoot: "/fixture",
    run,
    signal: controller.signal,
    intervalMs: 1,
    invoke: async (request) => {
      if (++polls === 4) {
        controller.abort();
      }
      return await invoke(request);
    },
    onExit: (exit) => exits.push(exit),
    onAllStopped: () => undefined,
  });
  expect(exits).toEqual([]);
  const idle = new AbortController();
  const started = performance.now();
  const pending = monitorNativeServiceExits({
    runtime,
    projectRoot: "/fixture",
    run,
    signal: idle.signal,
    intervalMs: 60_000,
    invoke,
    onExit: () => undefined,
    onAllStopped: () => undefined,
  });
  idle.abort();
  await pending;
  expect(performance.now() - started).toBeLessThan(5000);
});
