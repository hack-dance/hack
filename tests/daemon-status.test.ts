import { expect, test } from "bun:test";

import { buildDaemonStatusReport } from "../src/daemon/status.ts";

test("buildDaemonStatusReport marks running when API is reachable", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: true,
    socketExists: true,
    logExists: true,
    apiReachable: true,
    apiCompatible: true,
  });

  expect(report.status).toBe("running");
  expect(report.running).toBe(true);
  expect(report.stale).toBe(false);
});

test("buildDaemonStatusReport marks starting when process is running but API is not ready", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: true,
    socketExists: true,
    logExists: false,
    apiReachable: false,
    apiCompatible: false,
  });

  expect(report.status).toBe("starting");
  expect(report.running).toBe(true);
  expect(report.stale).toBe(false);
});

test("buildDaemonStatusReport marks stale when pid is present but not running", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: false,
    socketExists: true,
    logExists: false,
    apiReachable: false,
    apiCompatible: false,
  });

  expect(report.status).toBe("stale");
  expect(report.stale).toBe(true);
  expect(report.staleReason).toBe("pid_not_running");
  expect(report.nextStep).toBe("hack daemon start");
});

test("buildDaemonStatusReport marks stale when socket exists without pid", () => {
  const report = buildDaemonStatusReport({
    pid: null,
    processRunning: false,
    socketExists: true,
    logExists: false,
    apiReachable: false,
    apiCompatible: false,
  });

  expect(report.status).toBe("stale");
  expect(report.stale).toBe(true);
  expect(report.staleReason).toBe("socket_only");
  expect(report.nextStep).toBe("hack daemon start");
});

test("buildDaemonStatusReport marks stopped when no pid or socket", () => {
  const report = buildDaemonStatusReport({
    pid: null,
    processRunning: false,
    socketExists: false,
    logExists: false,
    apiReachable: false,
    apiCompatible: false,
  });

  expect(report.status).toBe("stopped");
  expect(report.stale).toBe(false);
  expect(report.nextStep).toBe("hack daemon start");
});

test("buildDaemonStatusReport marks incompatible daemon with guided restart", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: true,
    socketExists: true,
    logExists: true,
    apiReachable: true,
    apiCompatible: false,
  });

  expect(report.status).toBe("incompatible");
  expect(report.issue).toBe("incompatible");
  expect(report.nextStep).toBe("hack daemon restart");
  expect(report.stale).toBe(false);
});
