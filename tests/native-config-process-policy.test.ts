import { expect, test } from "bun:test";
import {
  nativeProcessPolicyProject,
  verifyNativeProcessPolicyEvidence,
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
      "retry-ready": { owner, attempts: 3 },
    },
    gracefulExit: "0",
    forcedExit: "137",
    initEnabled: true,
    restart: {
      name: "on-failure",
      maximumRetryCount: 2,
      restartCount: 2,
    },
  };
}

test("process evidence requires observed signal, grace, orphan reaping and exact retries", () => {
  expect(() => verifyNativeProcessPolicyEvidence(evidence())).not.toThrow();
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
  const noRetries = evidence();
  noRetries.restart.restartCount = 0;
  expect(() => verifyNativeProcessPolicyEvidence(noRetries)).toThrow();
  const wrongPolicy = evidence();
  wrongPolicy.restart.name = "always";
  expect(() => verifyNativeProcessPolicyEvidence(wrongPolicy)).toThrow();
  const staleCounter = evidence();
  staleCounter.records["retry-ready"].attempts = 6;
  expect(() => verifyNativeProcessPolicyEvidence(staleCounter)).toThrow();
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
