import { expect, test } from "bun:test"

import { buildDaemonStatusReport } from "../src/daemon/status.ts"

test("buildDaemonStatusReport marks running when API is reachable", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: true,
    socketExists: true,
    logExists: true,
    apiOk: true
  })

  expect(report.status).toBe("running")
  expect(report.running).toBe(true)
  expect(report.stale).toBe(false)
})

test("buildDaemonStatusReport marks starting when process is running but API is not ready", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: true,
    socketExists: true,
    logExists: false,
    apiOk: false
  })

  expect(report.status).toBe("starting")
  expect(report.running).toBe(true)
  expect(report.stale).toBe(false)
})

test("buildDaemonStatusReport marks stale when pid is present but not running", () => {
  const report = buildDaemonStatusReport({
    pid: 123,
    processRunning: false,
    socketExists: true,
    logExists: false,
    apiOk: false
  })

  expect(report.status).toBe("stale")
  expect(report.stale).toBe(true)
  expect(report.staleReason).toBe("pid_not_running")
})

test("buildDaemonStatusReport marks stale when socket exists without pid", () => {
  const report = buildDaemonStatusReport({
    pid: null,
    processRunning: false,
    socketExists: true,
    logExists: false,
    apiOk: false
  })

  expect(report.status).toBe("stale")
  expect(report.stale).toBe(true)
  expect(report.staleReason).toBe("socket_only")
})

test("buildDaemonStatusReport marks stopped when no pid or socket", () => {
  const report = buildDaemonStatusReport({
    pid: null,
    processRunning: false,
    socketExists: false,
    logExists: false,
    apiOk: false
  })

  expect(report.status).toBe("stopped")
  expect(report.stale).toBe(false)
})
