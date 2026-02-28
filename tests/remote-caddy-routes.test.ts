import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NodeRecord } from "../src/lib/nodes-registry.ts";
import {
  extractCaddyHostsFromCompose,
  readRemoteCaddyRoutesState,
  reconcileRemoteCaddyRoutesForProject,
  resolveProjectHostsForBridge,
  resolveRemoteCaddyUpstream,
} from "../src/lib/remote-caddy-routes.ts";

let tempHome: string | null = null;
let previousHome: string | undefined;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
  process.env.HOME = previousHome;
});

test("extractCaddyHostsFromCompose returns normalized hostnames from caddy labels", () => {
  const compose = [
    "services:",
    "  api:",
    "    labels:",
    '      caddy: "api.example.hack, https://www.example.hack"',
    "  web:",
    "    labels:",
    '      - "caddy=web.example.hack"',
    "",
  ].join("\n");

  const hosts = extractCaddyHostsFromCompose({ composeText: compose });
  expect(hosts).toEqual([
    "api.example.hack",
    "web.example.hack",
    "www.example.hack",
  ]);
});

test("resolveRemoteCaddyUpstream prefers ssh source host over endpoint host", () => {
  const upstream = resolveRemoteCaddyUpstream({
    source: "devuser@100.70.10.5:2201",
    endpoint: "http://127.0.0.1:7788",
  });
  expect(upstream).toBe("http://100.70.10.5:80");
});

test("resolveProjectHostsForBridge falls back to <project>.hack when compose has no caddy labels", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "hack-remote-routes-hosts-"));
  const projectDir = resolve(tempHome, "workspace", "example", ".hack");
  await mkdir(projectDir, { recursive: true });
  await Bun.write(resolve(projectDir, "docker-compose.yml"), "services: {}\n");

  const hosts = await resolveProjectHostsForBridge({
    projectDir,
    fallbackProjectHost: "example",
  });
  expect(hosts).toEqual(["example.hack"]);
});

test("reconcileRemoteCaddyRoutesForProject writes registry and compose when global caddy is not installed", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "hack-remote-routes-reconcile-"));
  previousHome = process.env.HOME;
  process.env.HOME = tempHome;

  const projectDir = resolve(tempHome, "workspace", "bridge-project", ".hack");
  await mkdir(projectDir, { recursive: true });
  await Bun.write(
    resolve(projectDir, "docker-compose.yml"),
    [
      "services:",
      "  web:",
      "    labels:",
      '      caddy: "bridge-project.hack"',
      "",
    ].join("\n")
  );

  const node = buildNodeRecord({
    id: "node-1",
    endpoint: "http://198.51.100.40:7788",
    source: "remote@198.51.100.40",
  });

  const result = await reconcileRemoteCaddyRoutesForProject({
    projectKey: "bridge-project-id",
    projectDir,
    fallbackProjectHost: "bridge-project",
    node,
  });

  expect(result.status).toBe("saved");
  expect(result.reason).toBe("saved_pending_global_caddy");

  const registry = await readFile(result.registryPath, "utf8");
  const compose = await readFile(result.composePath, "utf8");
  expect(registry).toContain('"projectKey": "bridge-project-id"');
  expect(registry).toContain('"host": "bridge-project.hack"');
  expect(compose).toContain("name: hack-remote-routes");
  expect(compose).toContain("caddy: bridge-project.hack");
  expect(compose).toContain("caddy.reverse_proxy: http://198.51.100.40:80");
});

test("readRemoteCaddyRoutesState reports persisted registry/compose metadata", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "hack-remote-routes-state-"));
  previousHome = process.env.HOME;
  process.env.HOME = tempHome;

  const projectDir = resolve(tempHome, "workspace", "state-project", ".hack");
  await mkdir(projectDir, { recursive: true });
  await Bun.write(
    resolve(projectDir, "docker-compose.yml"),
    [
      "services:",
      "  web:",
      "    labels:",
      '      caddy: "state-project.hack"',
      "",
    ].join("\n")
  );

  await reconcileRemoteCaddyRoutesForProject({
    projectKey: "state-project-id",
    projectDir,
    fallbackProjectHost: "state-project",
    node: buildNodeRecord({
      id: "node-state",
      endpoint: "http://203.0.113.24:7788",
      source: "remote@203.0.113.24",
    }),
  });

  const state = await readRemoteCaddyRoutesState();
  expect(state.routesRegistryExists).toBe(true);
  expect(state.routesComposeExists).toBe(true);
  expect(
    state.routes.some((route) => route.projectKey === "state-project-id")
  ).toBe(true);
});

function buildNodeRecord(input: {
  readonly id: string;
  readonly endpoint: string;
  readonly source: string;
}): NodeRecord {
  return {
    id: input.id,
    name: input.id,
    source: input.source,
    labels: [],
    capabilities: [],
    endpoint: input.endpoint,
    authRef: "env:HACK_NODE_TOKEN",
    status: "healthy",
    version: "test",
    platform: "darwin",
    arch: "arm64",
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
