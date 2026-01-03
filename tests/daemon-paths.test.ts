import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, expect, test } from "bun:test"

import { resolveDaemonPaths } from "../src/daemon/paths.ts"

let tempDir: string | null = null
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  tempDir = await mkdtemp(join(tmpdir(), "hack-daemon-"))
  process.env.HOME = tempDir
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  process.env.HOME = originalHome
})

test("resolveDaemonPaths uses ~/.hack/daemon defaults", () => {
  const paths = resolveDaemonPaths({})
  const root = resolve(tempDir!, ".hack", "daemon")

  expect(paths.root).toBe(root)
  expect(paths.socketPath).toBe(join(root, "hackd.sock"))
  expect(paths.pidPath).toBe(join(root, "hackd.pid"))
  expect(paths.logPath).toBe(join(root, "hackd.log"))
})
