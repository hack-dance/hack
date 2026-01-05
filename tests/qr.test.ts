import { describe, expect, test } from "bun:test"

import { buildGatewayQrPayload, buildSshQrPayload } from "../src/ui/qr.ts"

describe("qr payloads", () => {
  test("buildGatewayQrPayload normalizes url and includes metadata", () => {
    const payload = buildGatewayQrPayload({
      baseUrl: "http://127.0.0.1:7788/",
      token: "token-value",
      projectId: "proj-123",
      projectName: "example"
    })

    const parsed = JSON.parse(payload)
    expect(parsed).toEqual({
      type: "hack.gateway",
      baseUrl: "http://127.0.0.1:7788",
      token: "token-value",
      projectId: "proj-123",
      projectName: "example"
    })
  })

  test("buildGatewayQrPayload omits optional fields", () => {
    const payload = buildGatewayQrPayload({
      baseUrl: "http://localhost:7788",
      token: "token-value"
    })

    const parsed = JSON.parse(payload)
    expect(parsed).toEqual({
      type: "hack.gateway",
      baseUrl: "http://localhost:7788",
      token: "token-value"
    })
  })

  test("buildSshQrPayload includes user and port", () => {
    const payload = buildSshQrPayload({
      host: "example.com",
      user: "dimitri",
      port: 2222
    })

    expect(payload).toBe("ssh://dimitri@example.com:2222")
  })

  test("buildSshQrPayload omits optional segments", () => {
    const payload = buildSshQrPayload({ host: "example.com" })
    expect(payload).toBe("ssh://example.com")
  })
})
