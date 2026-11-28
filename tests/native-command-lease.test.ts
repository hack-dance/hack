import { expect, test } from "bun:test";
import { NATIVE_AUTHORED_EXEC_REQUEST_TIMEOUT_MS } from "../src/backends/native-authored-project-exec.ts";
import {
  isNativeCommandLeaseRefusal,
  isNativeCommandNotRun,
  isNativeOwnerAuthoredExecLeaseRefusal,
  isNativeOwnerRefreshLeaseRefusal,
  NATIVE_COMMAND_LEASE_WAIT_SECONDS,
  NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED,
  NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY,
  NATIVE_OWNER_AUTHORED_RUN_LEASE_BUSY,
  NATIVE_OWNER_REFRESH_LEASE_BUSY,
  nativeAuthoredCommandNotRunRefusal,
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
    stage: "refresh",
  });
  expect(isNativeCommandNotRun(refusal)).toBe(true);
  expect(isNativeCommandNotRun(raw)).toBe(false);
  expect(refusal.nativeCode).toBe("provider_busy");
  expect(refusal.message.split("\n")).toEqual([
    "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    "Holder: project stop.",
    "Retry hack exec once that project stop finishes.",
  ]);
  expect(refusal.message).not.toContain("unconfirmed");
  // At the exec step the refresh already ran: only the command did not.
  expect(
    nativeCommandLeaseRefusal({
      nativeMessage: PROJECT_STOP,
      command: "hack exec",
      stage: "exec",
    }).message.split("\n")[0]
  ).toBe(
    "hack exec could not acquire the native runtime lock (provider_busy); the command did not run."
  );
});

test("HACK-2729 review: only the owner's exact pre-effect refusal is classified as such", () => {
  expect(
    isNativeOwnerRefreshLeaseRefusal(
      new NativeRuntimeRequestError({
        message: "x",
        nativeCode: "graph_owner_recovery",
        nativeCauseCode: NATIVE_OWNER_REFRESH_LEASE_BUSY,
      })
    )
  ).toBe(true);
  for (const [nativeCode, nativeCauseCode] of [
    ["graph_owner_recovery", "provider_busy"],
    ["graph_owner_recovery", undefined],
    ["graph_one_off_failed", NATIVE_OWNER_REFRESH_LEASE_BUSY],
    [NATIVE_OWNER_REFRESH_LEASE_BUSY, undefined],
  ] as const) {
    expect(
      isNativeOwnerRefreshLeaseRefusal(
        new NativeRuntimeRequestError({
          message: "x",
          nativeCode,
          nativeCauseCode,
        })
      )
    ).toBe(false);
  }
});

test("HACK-2739: an authored exec's lease refusal says nothing ran, and only the owner's exact pair is pre-effect", () => {
  const refusal = nativeCommandLeaseRefusal({
    nativeMessage: PROJECT_STOP,
    command: "hack exec",
    stage: "authored",
  });
  expect(isNativeCommandNotRun(refusal)).toBe(true);
  expect(refusal.message.split("\n")).toEqual([
    "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    "Holder: project stop.",
    "Retry hack exec once that project stop finishes.",
  ]);
  expect(
    isNativeOwnerAuthoredExecLeaseRefusal(
      new NativeRuntimeRequestError({
        message: "x",
        nativeCode: "native_graph_foreground",
        nativeCauseCode: NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY,
      })
    )
  ).toBe(true);
  for (const [nativeCode, nativeCauseCode] of [
    ["native_graph_foreground", "provider_busy"],
    ["native_graph_foreground", undefined],
    ["native_graph_foreground", NATIVE_OWNER_REFRESH_LEASE_BUSY],
    ["graph_owner_recovery", NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY],
    [NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY, undefined],
  ] as const) {
    expect(
      isNativeOwnerAuthoredExecLeaseRefusal(
        new NativeRuntimeRequestError({
          message: "x",
          nativeCode,
          nativeCauseCode,
        })
      )
    ).toBe(false);
  }
  expect(
    isNativeOwnerAuthoredExecLeaseRefusal(
      Object.assign(new Error("forged"), {
        nativeCode: "native_graph_foreground",
        nativeCauseCode: NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY,
      })
    )
  ).toBe(false);
});

test("HACK-2742: only the authored owner's exact pre-effect causes are not-run refusals", () => {
  for (const [cause, command, first] of [
    [
      NATIVE_OWNER_AUTHORED_RUN_LEASE_BUSY,
      "hack run",
      "hack run could not acquire the native runtime lock (provider_busy); nothing ran.",
    ],
    [
      NATIVE_OWNER_AUTHORED_EXEC_LEASE_BUSY,
      "hack exec",
      "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    ],
    [
      NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED,
      "hack run",
      "hack run did not start: the project's owner stopped or changed before the command was sent or started (graph_authored_command_not_started); nothing ran.",
    ],
  ] as const) {
    const refusal = nativeAuthoredCommandNotRunRefusal(
      new NativeRuntimeRequestError({
        message: "x",
        nativeCode: "native_graph_foreground",
        nativeCauseCode: cause,
      }),
      command
    );
    expect(isNativeCommandNotRun(refusal)).toBe(true);
    expect(refusal?.message.split("\n")[0]).toBe(first);
    expect(refusal?.nativeCode).toBe("native_graph_foreground");
    expect(refusal?.nativeCauseCode).toBe(cause);
  }
  const raw = nativeAuthoredCommandNotRunRefusal(
    new NativeRuntimeRequestError({
      message: "busy",
      nativeCode: "provider_busy",
      nativeMessage: PROJECT_STOP,
    }),
    "hack run"
  );
  expect(raw?.message.split("\n")[1]).toBe("Holder: project stop.");
  for (const [nativeCode, nativeCauseCode] of [
    ["native_graph_foreground", "provider_busy"],
    ["native_graph_foreground", "native_graph_foreground"],
    ["native_graph_foreground", undefined],
    ["graph_owner_recovery", NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED],
    [NATIVE_OWNER_AUTHORED_COMMAND_NOT_STARTED, undefined],
    // HACK-2752: the run-only mounts code never classifies an exec.
    ["native_graph_foreground", "graph_authored_run_mounts_unsupported"],
  ] as const) {
    expect(
      nativeAuthoredCommandNotRunRefusal(
        new NativeRuntimeRequestError({
          message: "x",
          nativeCode,
          nativeCauseCode,
        }),
        "hack exec"
      )
    ).toBeUndefined();
  }
});

test("HACK-2739: the authored exec request outlasts the requester's wait and the owner's fixed read", () => {
  // Wait, 5 s to send, the fixed 40 s read of the owner's answer.
  expect(NATIVE_AUTHORED_EXEC_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
    (NATIVE_COMMAND_LEASE_WAIT_SECONDS + 5 + 40) * 1000
  );
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
