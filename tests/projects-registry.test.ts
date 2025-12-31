import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  readProjectsRegistry,
  resolveRegisteredProjectByName,
  upsertProjectRegistration
} from "../src/lib/projects-registry.ts"
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME
} from "../src/constants.ts"

let tempDir: string | null = null
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  tempDir = await mkdtemp(join(tmpdir(), "hack-registry-"))
  process.env.HOME = tempDir
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  process.env.HOME = originalHome
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function createProject(opts: {
  readonly rootName: string
  readonly name?: string
  readonly devHost?: string
}) {
  if (!tempDir) throw new Error("tempDir not set")
  const projectRoot = join(tempDir, opts.rootName)
  const projectDir = join(projectRoot, ".hack")
  await mkdir(projectDir, { recursive: true })

  await writeJson(join(projectDir, PROJECT_CONFIG_FILENAME), {
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.devHost ? { dev_host: opts.devHost } : {})
  })
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n")
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "")

  return {
    projectRoot,
    projectDirName: ".hack" as const,
    projectDir,
    composeFile: join(projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: join(projectDir, PROJECT_ENV_FILENAME),
    configFile: join(projectDir, PROJECT_CONFIG_FILENAME)
  }
}

test("upsertProjectRegistration creates a new entry", async () => {
  const project = await createProject({ rootName: "repo-a", name: "alpha" })
  const res = await upsertProjectRegistration({ project, nowIso: "2025-01-01T00:00:00Z" })
  expect(res.status).toBe("created")

  const registry = await readProjectsRegistry()
  expect(registry.projects.length).toBe(1)
  expect(registry.projects[0]?.name).toBe("alpha")
})

test("upsertProjectRegistration returns conflict when name is taken", async () => {
  const existingRoot = await createProject({ rootName: "repo-a", name: "alpha" })
  const registryPath = join(tempDir!, ".hack", "projects.json")
  await writeJson(registryPath, {
    version: 1,
    projects: [
      {
        id: "abc123",
        name: "alpha",
        repoRoot: existingRoot.projectRoot,
        projectDirName: ".hack",
        projectDir: existingRoot.projectDir,
        createdAt: "2025-01-01T00:00:00Z"
      }
    ]
  })

  const incoming = await createProject({ rootName: "repo-b", name: "alpha" })
  const res = await upsertProjectRegistration({ project: incoming, nowIso: "2025-01-02T00:00:00Z" })
  expect(res.status).toBe("conflict")
})

test("upsertProjectRegistration moves entry when old path missing", async () => {
  const registryPath = join(tempDir!, ".hack", "projects.json")
  await writeJson(registryPath, {
    version: 1,
    projects: [
      {
        id: "abc123",
        name: "alpha",
        repoRoot: join(tempDir!, "missing-root"),
        projectDirName: ".hack",
        projectDir: join(tempDir!, "missing-root/.hack"),
        createdAt: "2025-01-01T00:00:00Z"
      }
    ]
  })

  const incoming = await createProject({ rootName: "repo-b", name: "alpha" })
  const res = await upsertProjectRegistration({ project: incoming, nowIso: "2025-01-02T00:00:00Z" })
  expect(res.status).toBe("updated")

  const registry = await readProjectsRegistry()
  expect(registry.projects[0]?.projectDir).toBe(await realpath(incoming.projectDir))
})

test("upsertProjectRegistration clears stale registry lock", async () => {
  const project = await createProject({ rootName: "repo-a", name: "alpha" })
  const lockPath = join(tempDir!, ".hack", "projects.json.lock")
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, "123\n")
  const staleTime = new Date(Date.now() - 60_000)
  await utimes(lockPath, staleTime, staleTime)

  const res = await upsertProjectRegistration({ project, nowIso: "2025-01-03T00:00:00Z" })
  expect(res.status).toBe("created")

  const resolved = await resolveRegisteredProjectByName({ name: "alpha" })
  expect(resolved?.projectDir).toBe(await realpath(project.projectDir))
})
