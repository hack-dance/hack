import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"

import { authenticateGatewayRequest } from "../src/control-plane/extensions/gateway/auth.ts"
import {
  createGatewayToken,
  listGatewayTokens,
  revokeGatewayToken,
  verifyGatewayToken
} from "../src/control-plane/extensions/gateway/tokens.ts"

let rootDir: string | null = null

afterEach(async () => {
  if (!rootDir) return
  await rm(rootDir, { recursive: true, force: true })
  rootDir = null
})

test("gateway tokens can be created, verified, and revoked", async () => {
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"))

  const issued = await createGatewayToken({ rootDir, label: "phone" })
  const tokens = await listGatewayTokens({ rootDir })
  expect(tokens.length).toBe(1)
  expect(tokens[0]?.id).toBe(issued.record.id)
  expect(tokens[0]?.scope).toBe("read")

  const verified = await verifyGatewayToken({ rootDir, token: issued.token })
  expect(verified?.id).toBe(issued.record.id)
  expect(verified?.lastUsedAt).toBeTruthy()
  expect(verified?.scope).toBe("read")

  const revoked = await revokeGatewayToken({ rootDir, tokenId: issued.record.id })
  expect(revoked).toBe(true)
  const verifiedAfter = await verifyGatewayToken({ rootDir, token: issued.token })
  expect(verifiedAfter).toBeNull()
})

test("gateway auth accepts bearer and x-hack-token headers", async () => {
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"))

  const issued = await createGatewayToken({ rootDir, label: "agent", scope: "write" })
  const bearerHeaders = new Headers({
    authorization: `Bearer ${issued.token}`
  })
  const bearerAuth = await authenticateGatewayRequest({ rootDir, headers: bearerHeaders })
  expect(bearerAuth.ok).toBe(true)
  if (bearerAuth.ok) {
    expect(bearerAuth.scope).toBe("write")
  }

  const altHeaders = new Headers({
    "x-hack-token": issued.token
  })
  const altAuth = await authenticateGatewayRequest({ rootDir, headers: altHeaders })
  expect(altAuth.ok).toBe(true)

  const missingAuth = await authenticateGatewayRequest({ rootDir, headers: new Headers() })
  expect(missingAuth.ok).toBe(false)
  if (!missingAuth.ok) {
    expect(missingAuth.reason).toBe("missing")
  }
})
