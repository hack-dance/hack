import { test, expect } from "bun:test"

import {
  parseTunnelPrintArgs,
  parseTunnelStartArgs
} from "../src/control-plane/extensions/cloudflare/commands.ts"

test("parseTunnelPrintArgs parses hostname and out", () => {
  const result = parseTunnelPrintArgs({
    args: ["--hostname", "gateway.example.com", "--out", "./config.yml"]
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.hostname).toBe("gateway.example.com")
  expect(result.value.out).toBe("./config.yml")
})

test("parseTunnelPrintArgs rejects unknown flags", () => {
  const result = parseTunnelPrintArgs({ args: ["--wat"] })
  expect(result.ok).toBe(false)
})

test("parseTunnelPrintArgs rejects setup-only flags", () => {
  const result = parseTunnelPrintArgs({ args: ["--skip-login"] })
  expect(result.ok).toBe(false)
})

test("parseTunnelStartArgs parses config and tunnel", () => {
  const result = parseTunnelStartArgs({
    args: ["--config", "~/.cloudflared/config.yml", "--tunnel", "hack-gateway"]
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.config).toBe("~/.cloudflared/config.yml")
  expect(result.value.tunnel).toBe("hack-gateway")
})

test("parseTunnelStartArgs rejects unknown flags", () => {
  const result = parseTunnelStartArgs({ args: ["--wat"] })
  expect(result.ok).toBe(false)
})
