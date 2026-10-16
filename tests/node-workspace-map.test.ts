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

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  tempDir = await mkdtemp(join(tmpdir(), "hack-node-workspace-map-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  if (originalGlobalConfigPath !== undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
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
    projectName: "event-agent",
    workspaceRoot: "/Users/remote-user/.hack/projects/event-agent",
    workspaceProjectName: "event-agent",
    workspaceProjectId: "remote-event-agent",
    source: "managed",
    repoUrl: "git@github.com:hack-dance/event-agent.git",
  });

  const map = await readNodeWorkspaceMap();
  expect(map.entries).toHaveLength(1);
  const mapped = findNodeWorkspaceMapEntry({
    map,
    projectName: "event-agent",
  });
  expect(mapped).not.toBeNull();
  expect(mapped?.source).toBe("managed");
  expect(mapped?.workspaceProjectId).toBe("remote-event-agent");
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
    projectName: "event-agent",
    workspaceRoot: "/Users/remote-user/dev/event-agent",
    workspaceProjectName: "event-agent",
    source: "external",
  });

  const removed = await removeNodeWorkspaceMapEntry({
    projectName: "event-agent",
  });
  expect(removed).toBeTrue();

  const map = await readNodeWorkspaceMap();
  expect(map.entries).toHaveLength(0);
});
