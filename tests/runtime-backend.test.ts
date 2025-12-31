import { beforeEach, expect, test, mock } from "bun:test"

const runCalls: string[][] = []
const execCalls: string[][] = []

mock.module("../src/lib/shell.ts", () => ({
  exec: async (cmd: readonly string[]) => {
    execCalls.push([...cmd])
    return { exitCode: 0, stdout: "", stderr: "" }
  },
  run: async (cmd: readonly string[]) => {
    runCalls.push([...cmd])
    return 0
  }
}))

import { composeRuntimeBackend } from "../src/backends/runtime-backend.ts"

beforeEach(() => {
  runCalls.length = 0
  execCalls.length = 0
})

test("composeRuntimeBackend.up builds compose args with profiles and detach", async () => {
  await composeRuntimeBackend.up({
    composeFiles: ["a.yml", "b.yml"],
    composeProject: "myproj",
    profiles: ["ops"],
    detach: true,
    cwd: "/tmp"
  })

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "myproj",
    "-f",
    "a.yml",
    "-f",
    "b.yml",
    "--profile",
    "ops",
    "up",
    "-d"
  ])
})

test("composeRuntimeBackend.down builds compose args", async () => {
  await composeRuntimeBackend.down({
    composeFiles: ["docker-compose.yml"],
    composeProject: null,
    profiles: [],
    cwd: "/tmp"
  })

  expect(runCalls[0]).toEqual(["docker", "compose", "-f", "docker-compose.yml", "down"])
})

test("composeRuntimeBackend.psJson uses exec with json format", async () => {
  await composeRuntimeBackend.psJson({
    composeFiles: ["docker-compose.yml"],
    composeProject: "proj",
    profiles: ["ops"],
    cwd: "/tmp"
  })

  expect(execCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "--profile",
    "ops",
    "ps",
    "--format",
    "json"
  ])
})

test("composeRuntimeBackend.run supports workdir and args", async () => {
  await composeRuntimeBackend.run({
    composeFiles: ["docker-compose.yml"],
    composeProject: "proj",
    profiles: [],
    service: "api",
    workdir: "/app",
    cmdArgs: ["bun", "dev"],
    cwd: "/tmp"
  })

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "run",
    "--rm",
    "-w",
    "/app",
    "api",
    "bun",
    "dev"
  ])
})
