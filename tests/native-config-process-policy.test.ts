import { expect, test } from "bun:test";
import {
  nativeProcessPolicyProject,
  verifyNativeProcessPolicyEvidence,
  verifyUnsupportedNativeProcessPolicy,
} from "./e2e/scenarios/native-config-process-policy.ts";

function evidence() {
  const owner = "synthetic-process-fixture";
  return {
    owner,
    records: {
      "graceful-signal": { owner, signal: "SIGUSR1" },
      "graceful-complete": { owner, signal: "SIGUSR1", elapsedMs: 1200 },
      "forced-signal": { owner, signal: "SIGUSR1" },
      "forced-heartbeat": { owner, signal: "SIGUSR1", elapsedMs: 1900 },
      "init-result": {
        owner,
        appPid: 2,
        adoptedPid: 17,
        parent: 1,
        initName: "docker-init",
        reaped: true,
      },
      "retry-result": { owner, attempts: 3 },
    },
    gracefulExit: "0",
    forcedExit: "137",
    initEnabled: true,
    restart: {
      name: "on-failure",
      maximumRetryCount: 2,
      restartCount: 2,
    },
    retryContainer: "a".repeat(64),
    retryEvents: [
      { id: "a".repeat(64), action: "start", exitCode: undefined },
      { id: "a".repeat(64), action: "die", exitCode: "17" },
      { id: "a".repeat(64), action: "start", exitCode: undefined },
      { id: "a".repeat(64), action: "die", exitCode: "17" },
      { id: "a".repeat(64), action: "start", exitCode: undefined },
    ],
  };
}

test("process evidence requires observed signal, grace, orphan reaping and exact retries", () => {
  expect(() => verifyNativeProcessPolicyEvidence(evidence())).not.toThrow();
});

function policyRefusals(field: "resources" | "logging") {
  return {
    field,
    compilerReport: {
      transport_version: 1,
      ok: false,
      diagnostics: [
        {
          code: "unknown_field",
          pointer: `/services/unsupported/${field}`,
          document: "project",
        },
      ],
    },
    executionReport: {
      ok: false,
      error: {
        code: "E_UNEXPECTED",
        message:
          "Native execution inputs are invalid or changed; prepare a fresh generation. Values omitted.",
      },
    },
  };
}

test("unsupported policy evidence separates precise compiler refusal from redacted execution output", () => {
  for (const field of ["resources", "logging"] as const) {
    expect(() =>
      verifyUnsupportedNativeProcessPolicy(policyRefusals(field))
    ).not.toThrow();
  }
});

test("unrelated, missing or ambiguous compiler errors cannot qualify unsupported policy refusal", () => {
  const good = policyRefusals("resources");
  const diagnostic = good.compilerReport.diagnostics[0];
  for (const compilerReport of [
    null,
    { ...good.compilerReport, ok: true },
    { ...good.compilerReport, diagnostics: [] },
    { ...good.compilerReport, diagnostics: [diagnostic, diagnostic] },
    {
      ...good.compilerReport,
      diagnostics: [{ ...diagnostic, code: "invalid_type" }],
    },
    {
      ...good.compilerReport,
      diagnostics: [{ ...diagnostic, pointer: "/services/unsupported/image" }],
    },
    {
      ...good.compilerReport,
      diagnostics: [{ ...diagnostic, document: "checkout_local" }],
    },
  ]) {
    expect(() =>
      verifyUnsupportedNativeProcessPolicy({ ...good, compilerReport })
    ).toThrow("Compiler must specifically refuse");
  }
});

test("compiler refusal cannot substitute for a failed redacted execution refusal", () => {
  const good = policyRefusals("logging");
  for (const executionReport of [
    null,
    { ok: true },
    {
      ok: false,
      error: { ...good.executionReport.error, code: "E_PROJECT_NOT_FOUND" },
    },
    {
      ok: false,
      error: { ...good.executionReport.error, message: "private-proof-canary" },
    },
  ]) {
    try {
      verifyUnsupportedNativeProcessPolicy({ ...good, executionReport });
      throw new Error("Expected redacted execution refusal");
    } catch (error: unknown) {
      expect(String(error)).toContain("fixed redacted input refusal");
      expect(String(error)).not.toContain("private-proof-canary");
      expect(String(error)).not.toContain(
        "Expected redacted execution refusal"
      );
    }
  }
});

test("configured init and eventual readiness cannot substitute for actual reaping or retries", () => {
  const unreaped = evidence();
  unreaped.records["init-result"].reaped = false;
  expect(() => verifyNativeProcessPolicyEvidence(unreaped)).toThrow();
  const unadopted = evidence();
  unadopted.records["init-result"].parent = 2;
  expect(() => verifyNativeProcessPolicyEvidence(unadopted)).toThrow();
  const noInit = evidence();
  noInit.records["init-result"].appPid = 1;
  expect(() => verifyNativeProcessPolicyEvidence(noInit)).toThrow();
  const malformedPid = evidence();
  malformedPid.records["init-result"].adoptedPid = 1.5;
  expect(() => verifyNativeProcessPolicyEvidence(malformedPid)).toThrow();
  const noRetries = evidence();
  noRetries.restart.restartCount = 0;
  expect(() => verifyNativeProcessPolicyEvidence(noRetries)).toThrow();
  const wrongPolicy = evidence();
  wrongPolicy.restart.name = "always";
  expect(() => verifyNativeProcessPolicyEvidence(wrongPolicy)).toThrow();
  const staleCounter = evidence();
  staleCounter.records["retry-result"].attempts = 6;
  expect(() => verifyNativeProcessPolicyEvidence(staleCounter)).toThrow();
  const wrongLimit = evidence();
  wrongLimit.restart.maximumRetryCount = 0;
  expect(() => verifyNativeProcessPolicyEvidence(wrongLimit)).toThrow();
});

test("readiness markers and unbound engine events cannot substitute for immutable retry evidence", () => {
  const good = evidence();
  const { "retry-result": omitted, ...withoutRetry } = good.records;
  expect(omitted.attempts).toBe(3);
  expect(() =>
    verifyNativeProcessPolicyEvidence({ ...good, records: withoutRetry })
  ).toThrow();
  expect(() =>
    verifyNativeProcessPolicyEvidence({
      ...good,
      records: {
        ...withoutRetry,
        "retry-result": { owner: good.owner, ready: true, pid: 2 },
      },
    })
  ).toThrow();
  const noEvents = evidence();
  noEvents.retryEvents = [];
  expect(() => verifyNativeProcessPolicyEvidence(noEvents)).toThrow();
  const wrongId = evidence();
  for (const event of wrongId.retryEvents) {
    event.id = "b".repeat(64);
    break;
  }
  expect(() => verifyNativeProcessPolicyEvidence(wrongId)).toThrow();
  const wrongExit = evidence();
  for (const event of wrongExit.retryEvents) {
    if (event.action === "die") {
      event.exitCode = "0";
      break;
    }
  }
  expect(() => verifyNativeProcessPolicyEvidence(wrongExit)).toThrow();
});

test("signal receipt alone, wrong exit or overridden grace cannot become acceptance", () => {
  const wrongSignal = evidence();
  wrongSignal.records["forced-signal"].signal = "SIGTERM";
  expect(() => verifyNativeProcessPolicyEvidence(wrongSignal)).toThrow();
  const earlyKill = evidence();
  earlyKill.records["forced-heartbeat"].elapsedMs = 200;
  expect(() => verifyNativeProcessPolicyEvidence(earlyKill)).toThrow();
  const defaultGrace = evidence();
  defaultGrace.records["forced-heartbeat"].elapsedMs = 10_000;
  expect(() => verifyNativeProcessPolicyEvidence(defaultGrace)).toThrow();
  const forcedGraceful = evidence();
  forcedGraceful.gracefulExit = "137";
  expect(() => verifyNativeProcessPolicyEvidence(forcedGraceful)).toThrow();
  const ignoredEscalation = evidence();
  ignoredEscalation.forcedExit = "0";
  expect(() => verifyNativeProcessPolicyEvidence(ignoredEscalation)).toThrow();
});

test("missing, malformed and foreign process evidence refuses without echoing values", () => {
  for (const records of [
    null,
    [],
    {},
    { "graceful-signal": { owner: "private-proof-canary" } },
  ]) {
    try {
      verifyNativeProcessPolicyEvidence({ ...evidence(), records });
      throw new Error("Expected evidence refusal");
    } catch (error: unknown) {
      expect(String(error)).not.toContain("private-proof-canary");
      expect(String(error)).not.toContain("Expected evidence refusal");
    }
  }
});

test("native fixture explicitly authors process policy and isolates retained readback", () => {
  const project = nativeProcessPolicyProject({
    name: "fixture",
    image: "sha256:cached-fixture",
  });
  expect(project).not.toHaveProperty("resources");
  expect(project).not.toHaveProperty("networks");
  expect(project.services?.forced?.shutdown).toEqual({
    signal: "SIGUSR1",
    grace: "2s",
  });
  expect(project.services?.retry?.restart).toEqual({
    kind: "on-failure",
    max_retries: 2,
  });
  expect(project.services?.observer?.profiles).toEqual(["readback"]);
  expect(project.services?.observer?.mounts).toEqual([
    { storage: "evidence", target: "/evidence", access: "read-only" },
  ]);
  for (const [name, workload] of Object.entries(project.services ?? {})) {
    expect(workload.pull_policy).toBe("never");
    expect(workload).not.toHaveProperty("ports");
    expect(workload).not.toHaveProperty("logging");
    if (name !== "observer") {
      expect(workload.init).toBe(true);
      expect(workload.profiles).toEqual(["exercise"]);
    }
  }
});
