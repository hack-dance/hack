import { expect, test } from "bun:test";
import {
  NativeAuthoredHostDeadlineError,
  nativeAuthoredArtifactError,
  observeNativeAuthoredArtifactErrors,
} from "../src/backends/native-authored-artifact-error.ts";
import {
  NativeComposeGenerationError,
  NativeComposeInspectionError,
} from "../src/lib/native-compose-private-state.ts";
import { LifecycleSessionPresenceUnknownError } from "../src/lib/project-lifecycle-sessions.ts";
import { MuxCommandTimeoutError } from "../src/mux/mux-backend.ts";

const CANARY = "synthetic-private-artifact-error";
test("artifact observation cannot replace a failure when a callback throws or rejects", async () => {
  for (const onDiagnostic of [
    () => {
      throw new Error(CANARY);
    },
    () => Promise.reject(new Error(CANARY)),
  ]) {
    const failure = observeNativeAuthoredArtifactErrors({
      onDiagnostic,
      action: () =>
        nativeAuthoredArtifactError(
          new MuxCommandTimeoutError(["tmux", CANARY]),
          "action"
        ),
    });
    expect(failure.diagnostic.cause_code).toBe("mux_timeout");
    expect(JSON.stringify(failure)).not.toContain(CANARY);
  }
  await Bun.sleep(0);
});
test("artifact refusal diagnostics classify closed lock and mux failures without their messages", () => {
  for (const [error, cause] of [
    [new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY"), "lock_busy"],
    [new MuxCommandTimeoutError(["tmux", CANARY]), "mux_timeout"],
    [new LifecycleSessionPresenceUnknownError(CANARY), "mux_presence_unknown"],
    [new NativeAuthoredHostDeadlineError(), "host_deadline"],
    [
      Object.assign(new Error(CANARY), { code: "EAGAIN", path: CANARY }),
      "io_failed",
    ],
  ] as const) {
    const failure = nativeAuthoredArtifactError(error, "action");
    expect(failure.diagnostic.cause_code).toBe(cause);
    expect(failure.diagnostic.phase).toBe("action");
    expect(String(failure)).not.toContain(CANARY);
    expect(JSON.stringify(failure)).not.toContain(CANARY);
    expect(failure.cause).toBeUndefined();
  }
});

test("inspection diagnostics retain only the fixed observation, outcome and duration", () => {
  for (const outcome of ["timeout", "failed", "malformed"] as const) {
    const failure = nativeAuthoredArtifactError(
      new NativeComposeInspectionError({
        observation: "process-birth",
        outcome,
        elapsedMs: 3001,
      }),
      "action"
    );
    expect(failure.diagnostic).toEqual({
      phase: "action",
      cause_code: `lock_inspection_${outcome}`,
      inspection: "process-birth",
      elapsed_ms: 3001,
      system_code: null,
    });
  }
});

test("arbitrary codes, getters and proxy traps never become public diagnostics", () => {
  let invoked = false;
  const getter = Object.defineProperty({}, "code", {
    get() {
      invoked = true;
      throw new Error(CANARY);
    },
  });
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error(CANARY);
      },
    }
  );
  const prototypeTrap = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(CANARY);
      },
    }
  );
  for (const error of [
    new Error(CANARY),
    { code: CANARY, message: CANARY },
    getter,
    proxy,
    prototypeTrap,
  ]) {
    const failure = nativeAuthoredArtifactError(error, "action");
    expect(failure.diagnostic.cause_code).toBe("action_failed");
    expect(failure.diagnostic.system_code).toBeNull();
    expect(JSON.stringify(failure)).not.toContain(CANARY);
  }
  expect(invoked).toBe(false);
});
