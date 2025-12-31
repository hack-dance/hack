import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "bun:test"

import { discoverRepo } from "../src/init/discovery.ts"

let tempDir: string | null = null

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

test("discoverRepo uses package.json workspaces and orders dev candidates", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-discovery-workspaces-"))
  const repoRoot = join(tempDir, "repo")
  await mkdir(repoRoot, { recursive: true })

  await writeJson(join(repoRoot, "package.json"), {
    name: "root",
    workspaces: ["apps/*", "packages/*"],
    scripts: { start: "node server.js" }
  })

  await writeJson(join(repoRoot, "apps/web/package.json"), {
    name: "@repo/web",
    scripts: { dev: "next dev" }
  })

  await writeJson(join(repoRoot, "packages/api/package.json"), {
    name: "@repo/api",
    scripts: { "dev:api": "bun dev" }
  })

  const res = await discoverRepo(repoRoot)
  expect(res.isMonorepo).toBe(true)
  expect(res.workspacePatterns).toEqual(["apps/*", "packages/*"])
  expect(res.packages.length).toBe(3)
  expect(res.signals.includes("workspaces")).toBe(true)
  expect(res.candidates[0]?.scriptName).toBe("dev")
})

test("discoverRepo reads pnpm-workspace.yaml when no workspaces defined", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-discovery-pnpm-"))
  const repoRoot = join(tempDir, "repo")
  await mkdir(repoRoot, { recursive: true })

  await writeJson(join(repoRoot, "package.json"), {
    name: "root",
    scripts: { dev: "bun dev" }
  })

  await writeText(
    join(repoRoot, "pnpm-workspace.yaml"),
    `packages:\n  - "services/*"\n`
  )

  await writeJson(join(repoRoot, "services/api/package.json"), {
    name: "@repo/api",
    scripts: { dev: "bun dev" }
  })

  const res = await discoverRepo(repoRoot)
  expect(res.isMonorepo).toBe(true)
  expect(res.workspacePatterns).toEqual(["services/*"])
  expect(res.signals.includes("workspaces")).toBe(true)
  expect(res.packages.length).toBe(2)
})
