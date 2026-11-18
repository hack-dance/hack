import { expect, test } from "bun:test";
import { buildDoctorRecoveryGuidance } from "../src/commands/recovery-guidance.ts";
import {
  isCandidateRun,
  resolveDaemonAutostartAccess,
} from "../src/daemon/client.ts";
import { buildDaemonStatusReport } from "../src/daemon/status.ts";
import { buildDoctorDaemonCheck } from "../src/lib/doctor-daemon.ts";

test("candidate marker is independent of a stable hack on PATH and daemon opt-out priority", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HACK_CANDIDATE_ENTRYPOINT: " hack-next ",
    HACK_DAEMON_AUTOSTART_DISABLE: "1",
  };
  expect(isCandidateRun(env)).toBe(true);
  expect(resolveDaemonAutostartAccess({ env })).toMatchObject({
    allowed: false,
    reason: "disabled",
  });
  expect(isCandidateRun({ HACK_CANDIDATE_ENTRYPOINT: " " })).toBe(false);
  const access = resolveDaemonAutostartAccess({
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-v5" },
  });
  expect(access.allowed).toBe(false);
  if (!access.allowed) {
    expect(access.message).not.toContain("hack daemon start");
  }
});

for (const state of [
  "stopped",
  "stale",
  "starting",
  "incompatible",
  "running",
] as const) {
  test(`candidate ${state} diagnosis preserves status without stable daemon repair advice`, () => {
    const report = buildDaemonStatusReport({
      pid: state === "stopped" ? null : 123,
      processRunning: ["running", "starting", "incompatible"].includes(state),
      socketExists: state !== "stopped",
      logExists: false,
      apiReachable: ["running", "incompatible"].includes(state),
      apiCompatible: state === "running",
    });
    expect(report.status).toBe(state);
    const check = buildDoctorDaemonCheck({ report, candidate: true });
    expect(check.status).toBe(
      ["stopped", "running"].includes(state) ? "ok" : "warn"
    );
    expect(check.message).not.toContain("hack daemon");
    expect(
      buildDoctorRecoveryGuidance({ results: [check] }).temporaryBreakage
    ).toEqual([]);
    const stable = buildDoctorDaemonCheck({ report, candidate: false });
    if (state === "stopped" || state === "stale") {
      expect(stable.status).toBe("warn");
      expect(stable.message).toContain("hack daemon start");
    }
    if (state === "incompatible") {
      expect(stable.message).toContain("hack daemon restart");
    }
  });
}

test("doctor names why hackd would refuse to start, also for a candidate run (HACK-2329)", () => {
  const report = buildDaemonStatusReport({
    pid: null,
    processRunning: false,
    socketExists: false,
    logExists: false,
    apiReachable: false,
    apiCompatible: false,
  });
  const refusal =
    "hackd state directory /h/.hack/daemon is not safe from other users: /h is writable by other users (mode 775); run: chmod go-w /h";
  for (const candidate of [false, true]) {
    expect(
      buildDoctorDaemonCheck({ report, candidate, startRefusal: refusal })
    ).toEqual({
      name: "daemon",
      status: "warn",
      message: `hackd cannot start: ${refusal}`,
    });
  }
  expect(buildDoctorDaemonCheck({ report, candidate: false }).message).toBe(
    "hackd not running (run: hack daemon start)"
  );
});
