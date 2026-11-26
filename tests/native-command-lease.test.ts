import { expect, test } from "bun:test";
import {
  isNativeCommandLeaseRefusal,
  NATIVE_COMMAND_LEASE_WAIT_SECONDS,
  nativeCommandLeaseRefusal,
  nativeCommandLeaseWaitLine,
  nativeCommandLeaseWaitReporter,
} from "../src/backends/native-command-lease.ts";
import { NATIVE_DEPENDENCY_REFRESH_TIMEOUT_MS } from "../src/backends/native-project-dependency-refresh.ts";
import { NATIVE_EXEC_REQUEST_TIMEOUT_MS } from "../src/backends/native-project-exec.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { NATIVE_START_LEASE_WAIT_SECONDS } from "../src/backends/native-start-lease.ts";

const PROJECT_STOP =
  "Provider lease acquisition refused; recorded holder: project stop; no operation was admitted.";

test("HACK-2729: exec's progress line names the holder and the start's bound", () => {
  expect(nativeCommandLeaseWaitLine("project-stop")).toBe(
    "Waiting for the native runtime lock, held by a project stop. This command continues once it is released (up to 35 s)."
  );
  expect(nativeCommandLeaseWaitLine("start")).toContain(
    "held by another start."
  );
  for (const token of ["native-operation", "made-up", undefined]) {
    expect(nativeCommandLeaseWaitLine(token)).toContain(
      "held by another native runtime operation."
    );
  }
  // One bound for both: the runtime defines COMMAND_REQUEST_LEASE_WAIT as START_LEASE_WAIT.
  expect(NATIVE_COMMAND_LEASE_WAIT_SECONDS).toBe(
    NATIVE_START_LEASE_WAIT_SECONDS
  );
});

test("HACK-2729: one command prints the progress line once across its requests", () => {
  const lines: string[] = [];
  const report = nativeCommandLeaseWaitReporter({
    write: (line) => lines.push(line),
  });
  report("project-stop");
  report("project-stop");
  report("start");
  expect(lines).toEqual([nativeCommandLeaseWaitLine("project-stop")]);
  // A reporter the caller already shares across its requests is kept as is.
  expect(nativeCommandLeaseWaitReporter({ given: report })).toBe(report);
});

test("HACK-2729: only the requester's raw provider_busy is a lease refusal, and it says nothing ran", () => {
  const raw = new NativeRuntimeRequestError({
    message: "x",
    nativeCode: "provider_busy",
    nativeMessage: PROJECT_STOP,
  });
  expect(isNativeCommandLeaseRefusal(raw)).toBe(true);
  for (const other of [
    new NativeRuntimeRequestError({
      message: "x",
      nativeCode: "provider_busy",
      nativeCauseCode: "provider_state",
    }),
    new NativeRuntimeRequestError({
      message: "x",
      nativeCode: "graph_dependency_refresh_refused",
      nativeCauseCode: "provider_busy",
    }),
    new NativeRuntimeRequestError({
      message: "x",
      nativeCode: "native_request_timeout",
    }),
    Object.assign(new Error("forged"), { nativeCode: "provider_busy" }),
  ]) {
    expect(isNativeCommandLeaseRefusal(other)).toBe(false);
  }
  const refusal = nativeCommandLeaseRefusal({
    nativeMessage: PROJECT_STOP,
    command: "hack exec",
  });
  expect(refusal.nativeCode).toBe("provider_busy");
  expect(refusal.message.split("\n")).toEqual([
    "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    "Holder: project stop.",
    "Retry hack exec once that project stop finishes.",
  ]);
  expect(refusal.message).not.toContain("unconfirmed");
});

test("HACK-2729: exec's requests outlast the runtime's longer lease wait", () => {
  // Refresh: wait, 5 s to send, 175 s for the owner's answer.
  expect(NATIVE_DEPENDENCY_REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(
    (NATIVE_COMMAND_LEASE_WAIT_SECONDS + 5 + 175) * 1000
  );
  // Exec: wait, the 30 s exec, 20 s of output, 5 s inspection grace.
  expect(NATIVE_EXEC_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
    (NATIVE_COMMAND_LEASE_WAIT_SECONDS + 30 + 20 + 5) * 1000
  );
});
