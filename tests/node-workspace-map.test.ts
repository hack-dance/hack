import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findNodeWorkspaceMapEntry,
  readNodeWorkspaceMap,
  removeNodeWorkspaceMapEntry,
  resolveManagedNodeProjectsRoot,
  resolveNodeWorkspaceMapPath,
  upsertNodeWorkspaceMapEntry,
} from "../src/lib/node-workspace-map.ts";
import { restoreEnv } from "./helpers/env.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  tempDir = await mkdtemp(join(tmpdir(), "hack-node-workspace-map-"));
  process.env.HOME = tempDir;
  Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  restoreEnv("HOME", originalHome);
  if (originalGlobalConfigPath !== undefined) {
    restoreEnv("HACK_GLOBAL_CONFIG_PATH", originalGlobalConfigPath);
  } else {
    Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  }
});

test("managed root and map path resolve under ~/.hack", () => {
  if (!tempDir) {
    throw new Error("Missing tempDir");
  }

  expect(resolveManagedNodeProjectsRoot()).toBe(
    resolve(tempDir, ".hack", "projects")
  );
  expect(resolveNodeWorkspaceMapPath()).toBe(
    resolve(tempDir, ".hack", "projects.config.json")
  );
});

test("upsert writes map entry and lookup resolves by project name", async () => {
  await upsertNodeWorkspaceMapEntry({
    projectName: "example-app",
    workspaceRoot: "/Users/remote-user/.hack/projects/example-app",
    workspaceProjectName: "example-app",
    workspaceProjectId: "remote-example-app",
    source: "managed",
    repoUrl: "git@github.com:example-org/example-app.git",
  });

  const map = await readNodeWorkspaceMap();
  expect(map.entries).toHaveLength(1);
  const mapped = findNodeWorkspaceMapEntry({
    map,
    projectName: "example-app",
  });
  expect(mapped).not.toBeNull();
  expect(mapped?.source).toBe("managed");
  expect(mapped?.workspaceProjectId).toBe("remote-example-app");
});

test("upsert can migrate name-only entry to id-based mapping", async () => {
  await upsertNodeWorkspaceMapEntry({
    projectName: "hack-cli",
    workspaceRoot: "/Users/remote-user/.hack/projects/hack-cli",
    workspaceProjectName: "hack-cli",
    source: "managed",
  });

  await upsertNodeWorkspaceMapEntry({
    projectId: "4132b9154775",
    projectName: "hack-cli",
    workspaceRoot: "/Users/remote-user/.hack/projects/hack-cli",
    workspaceProjectName: "hack-cli",
    source: "managed",
  });

  const map = await readNodeWorkspaceMap();
  expect(map.entries).toHaveLength(1);
  const mapped = findNodeWorkspaceMapEntry({
    map,
    projectId: "4132b9154775",
  });
  expect(mapped).not.toBeNull();
  expect(mapped?.projectId).toBe("4132b9154775");
});

test("remove deletes matching map entries", async () => {
  await upsertNodeWorkspaceMapEntry({
    projectName: "example-app",
    workspaceRoot: "/Users/remote-user/dev/example-app",
    workspaceProjectName: "example-app",
    source: "external",
  });

  const removed = await removeNodeWorkspaceMapEntry({
    projectName: "example-app",
  });
  expect(removed).toBeTrue();

  const map = await readNodeWorkspaceMap();
  expect(map.entries).toHaveLength(0);
});
