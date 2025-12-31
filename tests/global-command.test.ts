import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test, mock } from "bun:test"

import {
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME
} from "../src/constants.ts"

let tempDir: string | null = null
let originalHome: string | undefined
let originalLogger: string | undefined
const execCalls: string[][] = []
const runCalls: string[][] = []

mock.module("../src/lib/shell.ts", () => ({
  exec: async (cmd: readonly string[]) => {
    execCalls.push([...cmd])
    return { exitCode: 0, stdout: "", stderr: "" }
  },
  execOrThrow: async (cmd: readonly string[]) => {
    execCalls.push([...cmd])
    return { exitCode: 0, stdout: "", stderr: "" }
  },
  run: async (cmd: readonly string[]) => {
    runCalls.push([...cmd])
    return 0
  },
  findExecutableInPath: async () => "/usr/bin/mkcert"
}))

mock.module("../src/lib/os.ts", () => ({
  isMac: () => false,
  openUrl: async () => 0
}))

beforeEach(async () => {
  originalHome = process.env.HOME
  originalLogger = process.env.HACK_LOGGER
  tempDir = await mkdtemp(join(tmpdir(), "hack-global-"))
  process.env.HOME = tempDir
  process.env.HACK_LOGGER = "console"
  execCalls.length = 0
  runCalls.length = 0
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  process.env.HOME = originalHome
  process.env.HACK_LOGGER = originalLogger
})

async function writeComposeFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "services: {}\n")
}

test("global up runs docker compose up for caddy and logging", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  )
  const loggingCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  )
  await writeComposeFile(caddyCompose)
  await writeComposeFile(loggingCompose)

  const { runCli } = await import("../src/cli/run.ts")
  const code = await runCli(["global", "up"])
  expect(code).toBe(0)
  expect(runCalls.some(call => call.includes(caddyCompose) && call.includes("up"))).toBe(true)
  expect(runCalls.some(call => call.includes(loggingCompose) && call.includes("up"))).toBe(true)
})

test("global down runs docker compose down when files exist", async () => {
  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  )
  const loggingCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  )
  await writeComposeFile(caddyCompose)
  await writeComposeFile(loggingCompose)

  const { runCli } = await import("../src/cli/run.ts")
  const code = await runCli(["global", "down"])
  expect(code).toBe(0)
  expect(runCalls.some(call => call.includes(caddyCompose) && call.includes("down"))).toBe(true)
  expect(runCalls.some(call => call.includes(loggingCompose) && call.includes("down"))).toBe(true)
})

test("global up fails when compose files are missing", async () => {
  const { runCli } = await import("../src/cli/run.ts")
  const code = await runCli(["global", "up"])
  expect(code).toBe(1)
})

test("global install writes compose files and starts stacks", async () => {
  const gumPath = join(tempDir!, GLOBAL_HACK_DIR_NAME, "bin", "gum")
  await writeComposeFile(gumPath)
  const { runCli } = await import("../src/cli/run.ts")
  const code = await runCli(["global", "install"])
  expect(code).toBe(0)

  const caddyCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  )
  const loggingCompose = join(
    tempDir!,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  )
  const hasCaddy = await Bun.file(caddyCompose).exists()
  const hasLogging = await Bun.file(loggingCompose).exists()

  expect(hasCaddy).toBe(true)
  expect(hasLogging).toBe(true)
  expect(runCalls.some(call => call.includes(caddyCompose) && call.includes("up"))).toBe(true)
  expect(runCalls.some(call => call.includes(loggingCompose) && call.includes("up"))).toBe(true)
})
