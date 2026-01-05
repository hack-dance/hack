import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"

import { PROJECT_CONFIG_FILENAME } from "../src/constants.ts"
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts"

let tempDir: string | null = null

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

test("readControlPlaneConfig returns defaults when config is missing", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"))
  const projectDir = join(tempDir, ".hack")
  await mkdir(projectDir, { recursive: true })

  const result = await readControlPlaneConfig({ projectDir })
  expect(result.parseError).toBeUndefined()
  expect(result.config.tickets.git.branch).toBe("hack/tickets")
  expect(result.config.supervisor.enabled).toBe(true)
})

test("readControlPlaneConfig reads controlPlane overrides", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"))
  const projectDir = join(tempDir, ".hack")
  await mkdir(projectDir, { recursive: true })

  const payload = {
    controlPlane: {
      supervisor: { enabled: false },
      extensions: {
        "dance.hack.supervisor": { enabled: true, cliNamespace: "jobs" }
      }
    }
  }

  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(payload, null, 2)}\n`
  )

  const result = await readControlPlaneConfig({ projectDir })
  expect(result.parseError).toBeUndefined()
  expect(result.config.supervisor.enabled).toBe(false)
  expect(result.config.extensions["dance.hack.supervisor"]?.enabled).toBe(true)
  expect(result.config.extensions["dance.hack.supervisor"]?.cliNamespace).toBe("jobs")
})

test("readControlPlaneConfig reports parse errors and falls back to defaults", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"))
  const projectDir = join(tempDir, ".hack")
  await mkdir(projectDir, { recursive: true })

  await writeFile(join(projectDir, PROJECT_CONFIG_FILENAME), "{bad json}")

  const result = await readControlPlaneConfig({ projectDir })
  expect(result.parseError).toBeTruthy()
  expect(result.config.gateway.enabled).toBe(false)
})
