import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "bun:test"

import { PROJECT_CONFIG_FILENAME } from "../src/constants.ts"
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts"

let tempDir: string | null = null
let tempGlobalConfig: string | null = null
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH

beforeEach(() => {
  tempGlobalConfig = join(tmpdir(), `hack-global-config-${Date.now()}-${Math.random()}.json`)
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfig
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  if (tempGlobalConfig) {
    await rm(tempGlobalConfig, { force: true })
    tempGlobalConfig = null
  }
  if (originalGlobalConfigPath === undefined) {
    delete process.env.HACK_GLOBAL_CONFIG_PATH
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath
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
  expect(result.config.daemon.autoStart).toBe(true)
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

test("readControlPlaneConfig keeps gateway enable project-scoped and uses global-only settings", async () => {
  if (!tempGlobalConfig) throw new Error("Missing global config path")

  const globalPayload = {
    controlPlane: {
      gateway: {
        enabled: true,
        bind: "0.0.0.0",
        port: 8899,
        allowWrites: true
      },
      extensions: {
        "dance.hack.cloudflare": {
          enabled: true,
          config: { hostname: "gateway.example.com" }
        }
      }
    }
  }

  await writeFile(tempGlobalConfig, `${JSON.stringify(globalPayload, null, 2)}\n`)

  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"))
  const projectDir = join(tempDir, ".hack")
  await mkdir(projectDir, { recursive: true })

  const projectPayload = {
    controlPlane: {
      gateway: { enabled: false, allowWrites: false, port: 9999 },
      extensions: {
        "dance.hack.cloudflare": {
          enabled: false
        }
      }
    }
  }

  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(projectPayload, null, 2)}\n`
  )

  const result = await readControlPlaneConfig({ projectDir })
  expect(result.config.gateway.allowWrites).toBe(true)
  expect(result.config.gateway.bind).toBe("0.0.0.0")
  expect(result.config.gateway.port).toBe(8899)
  expect(result.config.gateway.enabled).toBe(false)
  expect(result.config.extensions["dance.hack.cloudflare"]?.enabled).toBe(true)
  expect(result.config.extensions["dance.hack.cloudflare"]?.config?.hostname).toBe(
    "gateway.example.com"
  )
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
