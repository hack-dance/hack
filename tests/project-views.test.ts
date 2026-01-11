import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "bun:test"

import { buildProjectViews, serializeProjectView } from "../src/lib/project-views.ts"
import { PROJECT_COMPOSE_FILENAME } from "../src/constants.ts"

import type { RegisteredProject } from "../src/lib/projects-registry.ts"
import type { RuntimeContainer, RuntimeProject, RuntimeService } from "../src/lib/runtime-projects.ts"

let tempDir: string | null = null

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-views-"))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

async function createProject(opts: {
  readonly name: string
  readonly services: readonly string[]
}): Promise<RegisteredProject> {
  if (!tempDir) throw new Error("tempDir not set")
  const projectRoot = join(tempDir, opts.name)
  const projectDir = join(projectRoot, ".hack")
  await mkdir(projectDir, { recursive: true })

  const composeLines = ["services:"]
  for (const svc of opts.services) {
    composeLines.push(`  ${svc}: {}`)
  }
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), `${composeLines.join("\n")}\n`)

  return {
    id: `${opts.name}-id`,
    name: opts.name,
    repoRoot: projectRoot,
    projectDirName: ".hack",
    projectDir,
    devHost: `${opts.name}.hack`,
    createdAt: "2025-01-01T00:00:00Z"
  }
}

function makeRuntimeProject(opts: {
  readonly name: string
  readonly containersByService: Record<string, RuntimeContainer[]>
  readonly isGlobal?: boolean
}): RuntimeProject {
  const services = new Map<string, RuntimeService>()
  for (const [service, containers] of Object.entries(opts.containersByService)) {
    services.set(service, { service, containers })
  }
  return {
    project: opts.name,
    workingDir: `/tmp/${opts.name}/.hack`,
    services,
    isGlobal: opts.isGlobal ?? false
  }
}

function makeContainer(opts: {
  readonly project: string
  readonly service: string
  readonly name: string
  readonly state: string
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.service}-${opts.name}`,
    project: opts.project,
    service: opts.service,
    state: opts.state,
    status: opts.state === "running" ? "Up 5s" : "Exited (0)",
    name: opts.name,
    ports: "",
    workingDir: `/tmp/${opts.project}/.hack`
  }
}

test("buildProjectViews includes defined services and runtime status", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api", "web"] })
  const runtime = [
    makeRuntimeProject({
      name: "alpha",
      containersByService: {
        api: [makeContainer({ project: "alpha", service: "api", name: "alpha-api-1", state: "running" })]
      }
    }),
    makeRuntimeProject({
      name: "beta",
      containersByService: {
        web: [makeContainer({ project: "beta", service: "web", name: "beta-web-1", state: "exited" })]
      }
    })
  ]

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime,
    runtimeOk: true,
    filter: null,
    includeUnregistered: true
  })

  const alphaView = views.find(view => view.name === "alpha")
  expect(alphaView?.definedServices).toEqual(["api", "web"])
  expect(alphaView?.status).toBe("running")
  expect(alphaView?.projectId).toBe("alpha-id")

  const betaView = views.find(view => view.name === "beta")
  expect(betaView?.status).toBe("unregistered")

  const serialized = alphaView ? serializeProjectView(alphaView) : null
  expect(serialized?.["defined_services"]).toEqual(["api", "web"])
  expect(serialized?.["project_id"]).toBe("alpha-id")
})

test("buildProjectViews marks runtime status unknown when runtime is unavailable", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] })
  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: false,
    filter: null,
    includeUnregistered: false
  })

  const alphaView = views.find(view => view.name === "alpha")
  expect(alphaView?.status).toBe("unknown")
})
