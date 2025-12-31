import { test, expect } from "bun:test"

import { parseComposeLogLine, parseLokiLogLine } from "../src/ui/log-json.ts"

test("parseComposeLogLine extracts fields from JSON payload", () => {
  const line =
    "myapp-api-1 | 2025-01-01T12:00:00.123Z {\"level\":\"info\",\"msg\":\"ready\",\"port\":3000}"
  const parsed = parseComposeLogLine({
    line,
    stream: "stdout",
    projectName: "myapp"
  })

  expect(parsed.source).toBe("compose")
  expect(parsed.project).toBe("myapp")
  expect(parsed.service).toBe("api")
  expect(parsed.instance).toBe("1")
  expect(parsed.timestamp).toBe("2025-01-01T12:00:00.123Z")
  expect(parsed.level).toBe("info")
  expect(parsed.message).toBe("ready")
  expect(parsed.fields).toEqual({ port: "3000" })
})

test("parseLokiLogLine includes labels and timestamp", () => {
  const tsNs = "1700000000000000000"
  const labels = { project: "myapp", service: "api", container: "api-1" }
  const line = "{\"level\":\"error\",\"message\":\"boom\",\"code\":500}"

  const parsed = parseLokiLogLine({ labels, tsNs, line })
  const ms = Number(BigInt(tsNs) / 1_000_000n)
  const expectedIso = new Date(ms).toISOString()

  expect(parsed.source).toBe("loki")
  expect(parsed.project).toBe("myapp")
  expect(parsed.service).toBe("api")
  expect(parsed.timestamp_ns).toBe(tsNs)
  expect(parsed.timestamp).toBe(expectedIso)
  expect(parsed.level).toBe("error")
  expect(parsed.message).toBe("boom")
  expect(parsed.fields).toEqual({ code: "500" })
})
