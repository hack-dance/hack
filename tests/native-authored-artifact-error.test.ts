import { expect, test } from "bun:test";
import { dirname } from "node:path";
import {
  NativeAuthoredHostDeadlineError,
  nativeAuthoredArtifactError,
  observeNativeAuthoredArtifactErrors,
} from "../src/backends/native-authored-artifact-error.ts";
import { serveLifecycleProcessDelivery } from "../src/lib/lifecycle-process-delivery.ts";
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
    expect(failure.diagnostic).toMatchObject({
      phase: "action",
      cause_code: `lock_inspection_${outcome}`,
      inspection: "process-birth",
      elapsed_ms: 3001,
      system_code: null,
      error_class: "Error",
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

test("a generic action failure names its source sites and built-in class, never its message or checkout path", async () => {
  const refusal = await serveLifecycleProcessDelivery({
    root: CANARY,
    launch: { command: [], cwd: CANARY, env: {} },
    signal: new AbortController().signal,
    remaining: () => 1000,
    assertFresh: () => Promise.resolve(),
  }).catch((error: unknown) => error);
  const failure = nativeAuthoredArtifactError(refusal, "action");
  expect(failure.diagnostic.cause_code).toBe("action_failed");
  expect(failure.diagnostic.error_class).toBe("Error");
  expect(failure.diagnostic.sites[0]).toMatch(
    /^lib\/lifecycle-process-delivery\.ts:\d+$/
  );
  expect(failure.diagnostic.sites.length).toBeGreaterThan(1);
  expect(failure.diagnostic.sites.length).toBeLessThanOrEqual(4);
  expect(Object.isFrozen(failure.diagnostic.sites)).toBe(true);
  const serialized = JSON.stringify(failure);
  expect(serialized).not.toContain(CANARY);
  expect(serialized).not.toContain(import.meta.dir);
  expect(serialized).not.toContain("refused");
});

test("frames outside Hack source, other classes and non-errors keep closed values", () => {
  const local = nativeAuthoredArtifactError(new TypeError(CANARY), "action");
  expect(local.diagnostic.error_class).toBe("TypeError");
  expect(local.diagnostic.sites).toEqual([]);
  const plain = nativeAuthoredArtifactError({ message: CANARY }, "action");
  expect(plain.diagnostic.error_class).toBe("non_error");
  const forged = nativeAuthoredArtifactError(
    Object.assign(new Error(CANARY), {
      stack: [
        "Error",
        `    at x (${dirname(import.meta.dir)}/src/../${CANARY}/a.ts:1:1)`,
        `    at y (/elsewhere/src/lib/${CANARY}.ts:2:1)`,
        `    at z (${dirname(import.meta.dir)}/src/lib/a.ts:1234567:1)`,
      ].join("\n"),
    }),
    "action"
  );
  expect(forged.diagnostic.sites).toEqual([]);
  expect(JSON.stringify(forged)).not.toContain(CANARY);
  let invoked = false;
  const stackGetter = Object.defineProperty(new Error(CANARY), "stack", {
    get() {
      invoked = true;
      return CANARY;
    },
  });
  expect(
    nativeAuthoredArtifactError(stackGetter, "action").diagnostic.sites
  ).toEqual([]);
  expect(invoked).toBe(false);
});

test("errno names outside the original set are reported, unknown codes are not", () => {
  for (const code of ["EADDRINUSE", "ENAMETOOLONG", "ETIMEDOUT", "ENOTSOCK"]) {
    const failure = nativeAuthoredArtifactError(
      Object.assign(new Error(CANARY), { code }),
      "action"
    );
    expect(failure.diagnostic.cause_code).toBe("io_failed");
    expect(failure.diagnostic.system_code).toBe(code);
  }
  const unknown = nativeAuthoredArtifactError(
    Object.assign(new Error(CANARY), { code: "ECANARY" }),
    "action"
  );
  expect(unknown.diagnostic.cause_code).toBe("action_failed");
  expect(unknown.diagnostic.system_code).toBeNull();
});
