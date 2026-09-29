import { expect, test } from "bun:test";
import { adaptNativeProject } from "../src/backends/native-project-adaptation.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";

function fixture(extra: unknown[] = []): NativeProjectInput {
  return {
    originalSha256: "a".repeat(64),
    normalizedComposeJson: JSON.stringify({
      volumes: { node_modules: {} },
      services: {
        deps: {
          volumes: [".:/app:ro", "node_modules:/app/node_modules", ...extra],
        },
        web: {
          volumes: [
            {
              type: "volume",
              source: "node_modules",
              target: "/app/node_modules",
              read_only: true,
            },
          ],
        },
        redis: { image: "redis" },
      },
    }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: ["deps", "web", "redis"],
  };
}
const workspaceCache = {
  volume: "node_modules",
  root: "/app",
  workspaces: ["apps/www", "packages/db"],
};
test("workspace installs share declared cache storage while consumers retain read-only access", () => {
  const input = fixture();
  const before = input.normalizedComposeJson;
  const result = adaptNativeProject({
    input,
    selection: { version: 1, workspaceCache },
  });
  const compose = JSON.parse(result.normalizedComposeJson);
  for (const [service, readOnly] of [
    ["deps", false],
    ["web", true],
  ] as const) {
    expect(compose.services[service].volumes.slice(-2)).toEqual(
      workspaceCache.workspaces.map((path) => ({
        type: "volume",
        source: "node_modules",
        target: `/app/${path}/node_modules`,
        read_only: readOnly,
        volume: { subpath: `.hack-workspace-node-modules/${path}` },
      }))
    );
  }
  expect(compose.services.redis).toEqual({ image: "redis" });
  expect(Object.keys(compose.volumes)).toEqual(["node_modules"]);
  expect(input.normalizedComposeJson).toBe(before);
  expect(result.originalSha256).toBe(input.originalSha256);
});
test("workspace cache rejects conflicting targets, traversal and undeclared storage without changing source", () => {
  const input = fixture(["other:/app/apps/www/node_modules"]);
  const before = input.normalizedComposeJson;
  expect(() =>
    adaptNativeProject({ input, selection: { version: 1, workspaceCache } })
  ).toThrow("conflicts");
  expect(input.normalizedComposeJson).toBe(before);
  for (const patch of [
    { volume: "missing" },
    { root: "/app/../other" },
    { workspaces: ["../outside"] },
    { workspaces: ["apps/node_modules"] },
    { workspaces: ["apps/www", "apps/www"] },
    { workspaces: [] },
  ]) {
    expect(() =>
      adaptNativeProject({
        input: fixture(),
        selection: {
          version: 1,
          workspaceCache: { ...workspaceCache, ...patch },
        },
      })
    ).toThrow("values omitted");
  }
});
