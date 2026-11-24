import { expect, test } from "bun:test";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import {
  NATIVE_EXITED_RUNTIME_NOTICE,
  recoverExitedNativeRuntime,
} from "../src/backends/native-runtime-preflight.ts";

const runtime = { binary: "/candidate/hack-native", home: "/candidate/home" };

test("a pool whose provider exited under a running record is recovered once, with one line", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const recovered = await recoverExitedNativeRuntime({
    runtime,
    cwd: "/project",
    notice: (line) => lines.push(line),
    invoke: async (request) => {
      calls.push(request.args.slice(0, 2).join(" "));
      return request.args[1] === "status"
        ? { phase: "process-exited", process_alive: false }
        : { phase: "recovered-unclean", process_alive: false };
    },
  });
  expect(recovered).toBe(true);
  expect(calls).toEqual(["runtime status", "runtime recover"]);
  expect(lines).toEqual([NATIVE_EXITED_RUNTIME_NOTICE]);
  // The line names no terminal and no command to run.
  expect(NATIVE_EXITED_RUNTIME_NOTICE).not.toContain("terminal");
});

test("any other state, or an unreadable status, recovers nothing", async () => {
  for (const status of [
    { phase: "running", process_alive: true },
    { phase: "stopped", process_alive: false },
    { phase: "recovered-unclean" },
    null,
    new NativeRuntimeRequestError({ message: "status refused" }),
  ]) {
    const calls: string[] = [];
    const lines: string[] = [];
    const recovered = await recoverExitedNativeRuntime({
      runtime,
      cwd: "/project",
      notice: (line) => lines.push(line),
      invoke: async (request) => {
        calls.push(request.args[1]!);
        if (status instanceof Error) {
          throw status;
        }
        return status;
      },
    });
    expect(recovered).toBe(false);
    expect(calls).toEqual(["status"]);
    expect(lines).toEqual([]);
  }
});

test("a recovery that leaves the pool running or exited refuses instead of continuing", async () => {
  for (const receipt of [
    { phase: "running" },
    { phase: "process-exited" },
    {},
    null,
  ]) {
    await expect(
      recoverExitedNativeRuntime({
        runtime,
        cwd: "/project",
        notice: () => undefined,
        invoke: async (request) =>
          request.args[1] === "status" ? { phase: "process-exited" } : receipt,
      })
    ).rejects.toBeInstanceOf(NativeRuntimeRequestError);
  }
});
