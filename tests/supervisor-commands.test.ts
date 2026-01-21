import { test, expect } from "bun:test"

import {
  parseJobCreateArgs,
  parseShellArgs,
  parseSupervisorArgs
} from "../src/control-plane/extensions/supervisor/commands.ts"

test("parseSupervisorArgs handles project + json", () => {
  const result = parseSupervisorArgs({
    args: ["--project", "my-app", "--json", "job-1"]
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.project).toBe("my-app")
  expect(result.value.json).toBe(true)
  expect(result.value.follow).toBe(true)
  expect(result.value.rest).toEqual(["job-1"])
})

test("parseSupervisorArgs handles log/event offsets", () => {
  const result = parseSupervisorArgs({
    args: ["--logs-from", "10", "--events-from=5", "--no-follow", "job-2"],
    allowLogsFrom: true,
    allowEventsFrom: true,
    allowFollow: true
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.logsFrom).toBe(10)
  expect(result.value.eventsFrom).toBe(5)
  expect(result.value.follow).toBe(false)
})

test("parseSupervisorArgs rejects unsupported options", () => {
  const result = parseSupervisorArgs({ args: ["--logs-from", "1"] })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error).toContain("--logs-from")
})

test("parseSupervisorArgs rejects unknown flags", () => {
  const result = parseSupervisorArgs({ args: ["--wat"] })
  expect(result.ok).toBe(false)
})

test("parseJobCreateArgs handles runner, env, and command", () => {
  const result = parseJobCreateArgs({
    args: ["--runner", "generic", "--env", "FOO=bar", "--", "echo", "hello"]
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.runner).toBe("generic")
  expect(result.value.command).toEqual(["echo", "hello"])
  expect(result.value.env).toEqual({ FOO: "bar" })
})

test("parseJobCreateArgs rejects missing command", () => {
  const result = parseJobCreateArgs({ args: ["--runner", "generic"] })
  expect(result.ok).toBe(false)
})

test("parseShellArgs handles gateway, dims, and env", () => {
  const result = parseShellArgs({
    args: [
      "--gateway",
      "http://127.0.0.1:7788",
      "--token",
      "token",
      "--project-id",
      "proj-123",
      "--cols",
      "120",
      "--rows=32",
      "--env",
      "FOO=bar"
    ]
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.gateway).toBe("http://127.0.0.1:7788")
  expect(result.value.projectId).toBe("proj-123")
  expect(result.value.cols).toBe(120)
  expect(result.value.rows).toBe(32)
  expect(result.value.env).toEqual({ FOO: "bar" })
})

test("parseShellArgs rejects project conflict", () => {
  const result = parseShellArgs({ args: ["--project", "alpha", "--project-id", "proj-1"] })
  expect(result.ok).toBe(false)
})
