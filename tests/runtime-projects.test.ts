import { expect, test } from "bun:test"

import {
  countRunningServices,
  filterRuntimeProjects,
  serializeRuntimeProject
} from "../src/lib/runtime-projects.ts"

import type { RuntimeContainer, RuntimeProject, RuntimeService } from "../src/lib/runtime-projects.ts"

function makeContainer(opts: {
  readonly project: string
  readonly service: string
  readonly name: string
  readonly state: string
  readonly status: string
  readonly ports?: string
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.service}-${opts.name}`,
    project: opts.project,
    service: opts.service,
    state: opts.state,
    status: opts.status,
    name: opts.name,
    ports: opts.ports ?? "",
    workingDir: `/tmp/${opts.project}/.hack`
  }
}

function makeRuntimeProject(opts: {
  readonly name: string
  readonly isGlobal: boolean
  readonly containersByService: Record<string, RuntimeContainer[]>
}): RuntimeProject {
  const services = new Map<string, RuntimeService>()
  for (const [service, containers] of Object.entries(opts.containersByService)) {
    services.set(service, { service, containers })
  }
  return {
    project: opts.name,
    workingDir: `/tmp/${opts.name}/.hack`,
    services,
    isGlobal: opts.isGlobal
  }
}

test("countRunningServices counts services with running containers", () => {
  const running = makeContainer({
    project: "alpha",
    service: "api",
    name: "alpha-api-1",
    state: "running",
    status: "Up 10s"
  })
  const stopped = makeContainer({
    project: "alpha",
    service: "worker",
    name: "alpha-worker-1",
    state: "exited",
    status: "Exited (0)"
  })
  const runtime = makeRuntimeProject({
    name: "alpha",
    isGlobal: false,
    containersByService: {
      api: [running],
      worker: [stopped]
    }
  })

  expect(countRunningServices(runtime)).toBe(1)
})

test("filterRuntimeProjects excludes global projects when disabled", () => {
  const local = makeRuntimeProject({
    name: "alpha",
    isGlobal: false,
    containersByService: {}
  })
  const global = makeRuntimeProject({
    name: "hack-logging",
    isGlobal: true,
    containersByService: {}
  })

  const filtered = filterRuntimeProjects({
    runtime: [local, global],
    includeGlobal: false
  })

  expect(filtered).toEqual([local])
})

test("serializeRuntimeProject includes container ports", () => {
  const runtime = makeRuntimeProject({
    name: "alpha",
    isGlobal: false,
    containersByService: {
      api: [
        makeContainer({
          project: "alpha",
          service: "api",
          name: "alpha-api-1",
          state: "running",
          status: "Up 10s",
          ports: "8080/tcp"
        })
      ]
    }
  })

  const serialized = serializeRuntimeProject(runtime)
  const services = serialized["services"] as Array<Record<string, unknown>>
  expect(services[0]?.["service"]).toBe("api")
  const containers = services[0]?.["containers"] as Array<Record<string, unknown>>
  expect(containers[0]?.["ports"]).toBe("8080/tcp")
})
