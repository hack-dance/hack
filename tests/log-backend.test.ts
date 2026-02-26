import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const dockerJsonCalls: Record<string, unknown>[] = [];
const dockerPlainCalls: Record<string, unknown>[] = [];
const dockerPrettyCalls: Record<string, unknown>[] = [];
const lokiCalls: Record<string, unknown>[] = [];

mock.module("../src/ui/docker-logs.ts", () => ({
  dockerComposeLogsJson: async (opts: Record<string, unknown>) => {
    dockerJsonCalls.push(opts);
    return 0;
  },
  dockerComposeLogsPlain: async (opts: Record<string, unknown>) => {
    dockerPlainCalls.push(opts);
    return 0;
  },
  dockerComposeLogsPretty: async (opts: Record<string, unknown>) => {
    dockerPrettyCalls.push(opts);
    return 0;
  },
}));

mock.module("../src/ui/loki-logs.ts", () => ({
  canReachLoki: async () => true,
  lokiLogs: async (opts: Record<string, unknown>) => {
    lokiCalls.push(opts);
    return 0;
  },
}));

import {
  composeLogBackend,
  lokiLogBackend,
} from "../src/backends/log-backend.ts";

beforeEach(() => {
  dockerJsonCalls.length = 0;
  dockerPlainCalls.length = 0;
  dockerPrettyCalls.length = 0;
  lokiCalls.length = 0;
});

afterAll(() => {
  mock.restore();
});

test("composeLogBackend routes json output to dockerComposeLogsJson", async () => {
  await composeLogBackend.run({
    composeFile: "docker-compose.yml",
    cwd: "/tmp",
    follow: true,
    tail: 50,
    format: "json",
  });

  expect(dockerJsonCalls.length).toBe(1);
  expect(dockerPrettyCalls.length).toBe(0);
});

test("composeLogBackend routes pretty output to dockerComposeLogsPretty", async () => {
  await composeLogBackend.run({
    composeFile: "docker-compose.yml",
    cwd: "/tmp",
    follow: false,
    tail: 10,
    format: "pretty",
  });

  expect(dockerPrettyCalls.length).toBe(1);
  expect(dockerJsonCalls.length).toBe(0);
});

test("composeLogBackend routes plain output to docker compose logs", async () => {
  await composeLogBackend.run({
    composeFile: "docker-compose.yml",
    cwd: "/tmp",
    follow: true,
    tail: 10,
    format: "plain",
    service: "api",
    composeProject: "proj",
    profiles: ["ops"],
  });

  expect(dockerPlainCalls.length).toBe(1);
  expect(dockerPlainCalls[0]).toMatchObject({
    composeFile: "docker-compose.yml",
    follow: true,
    tail: 10,
    service: "api",
    composeProject: "proj",
    profiles: ["ops"],
  });
});

test("lokiLogBackend.isAvailable proxies canReachLoki", async () => {
  const ok = await lokiLogBackend.isAvailable({
    baseUrl: "http://127.0.0.1:3100",
  });
  expect(ok).toBe(true);
});

test("lokiLogBackend.run maps format flags", async () => {
  await lokiLogBackend.run({
    baseUrl: "http://127.0.0.1:3100",
    query: '{project="my-project"}',
    follow: false,
    tail: 50,
    format: "pretty",
    showProjectPrefix: true,
  });

  expect(lokiCalls[0]?.pretty).toBe(true);
  expect(lokiCalls[0]?.json).toBeUndefined();
});
