import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"

import { readProjectConfig, resolveProjectOauthTld } from "../src/lib/project.ts"
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME
} from "../src/constants.ts"

let tempDir: string | null = null

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

async function createProjectDir(): Promise<{
  projectRoot: string
  projectDirName: ".hack"
  projectDir: string
  composeFile: string
  envFile: string
  configFile: string
}> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-config-"))
  const projectRoot = join(tempDir, "repo")
  const projectDir = join(projectRoot, ".hack")
  await mkdir(projectDir, { recursive: true })

  const composeFile = join(projectDir, PROJECT_COMPOSE_FILENAME)
  const envFile = join(projectDir, PROJECT_ENV_FILENAME)
  const configFile = join(projectDir, PROJECT_CONFIG_FILENAME)

  await writeFile(composeFile, "services: {}\n")
  await writeFile(envFile, "")

  return {
    projectRoot,
    projectDirName: ".hack",
    projectDir,
    composeFile,
    envFile,
    configFile
  }
}

test("readProjectConfig parses json config fields", async () => {
  const ctx = await createProjectDir()
  await writeFile(
    ctx.configFile,
    JSON.stringify(
      {
        name: "my-app",
        dev_host: "myapp.hack",
        logs: { follow_backend: "compose", snapshot_backend: "loki", clear_on_down: true },
        oauth: { enabled: true, tld: "gy" },
        internal: {
          dns: true,
          tls: true,
          extra_hosts: {
            "api.example.com": "host-gateway",
            "db.example.com": "127.0.0.1"
          }
        }
      },
      null,
      2
    )
  )

  const cfg = await readProjectConfig(ctx)
  expect(cfg.name).toBe("my-app")
  expect(cfg.devHost).toBe("myapp.hack")
  expect(cfg.logs?.followBackend).toBe("compose")
  expect(cfg.logs?.snapshotBackend).toBe("loki")
  expect(cfg.logs?.clearOnDown).toBe(true)
  expect(cfg.oauth?.enabled).toBe(true)
  expect(cfg.oauth?.tld).toBe("gy")
  expect(cfg.internal?.dns).toBe(true)
  expect(cfg.internal?.tls).toBe(true)
  expect(cfg.internal?.extraHosts).toEqual({
    "api.example.com": "host-gateway",
    "db.example.com": "127.0.0.1"
  })
})

test("readProjectConfig captures parse errors", async () => {
  const ctx = await createProjectDir()
  await writeFile(ctx.configFile, "{ invalid json")
  const cfg = await readProjectConfig(ctx)
  expect(cfg.parseError).toBeTruthy()
})

test("resolveProjectOauthTld falls back to default when enabled", () => {
  expect(resolveProjectOauthTld({ enabled: true, tld: "" })).toBe("gy")
  expect(resolveProjectOauthTld({ enabled: false })).toBeNull()
})
