import { afterEach, beforeEach, expect, test } from "bun:test";
import { __testOnlyNodeWorkspace } from "../src/commands/node.ts";

let previousHome: string | undefined;
let previousGlobalConfigPath: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
});

afterEach(() => {
  process.env.HOME = previousHome;
  if (previousGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
    return;
  }
  process.env.HACK_GLOBAL_CONFIG_PATH = previousGlobalConfigPath;
});

test("parseWorkspaceMapSelector detects id-like selectors", () => {
  const parsed = __testOnlyNodeWorkspace.parseWorkspaceMapSelector({
    selector: "4132b9154775",
  });
  expect(parsed).toEqual({ projectId: "4132b9154775" });
});

test("workspaceMapSelectorCandidates includes name fallback for id-like selectors", () => {
  const selectors = __testOnlyNodeWorkspace.workspaceMapSelectorCandidates({
    selector: "4132b9154775",
  });
  expect(selectors).toEqual([
    { projectId: "4132b9154775" },
    { projectName: "4132b9154775" },
  ]);
});

test("resolveWorkspaceMapEntryBySelector falls back to project name", () => {
  const resolved = __testOnlyNodeWorkspace.resolveWorkspaceMapEntryBySelector({
    selector: "4132b9154775",
    mapEntries: [
      {
        projectName: "4132b9154775",
        workspaceRoot: "/tmp/workspace",
        workspaceProjectName: "workspace",
        source: "external",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  expect(resolved?.projectName).toBe("4132b9154775");
});

test("deriveWorkspaceSource detects managed root ancestry", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "/tmp/hack-global/hack.config.json";
  const managed = __testOnlyNodeWorkspace.deriveWorkspaceSource({
    workspaceRoot: "/tmp/hack-global/projects/event-agent",
  });
  const external = __testOnlyNodeWorkspace.deriveWorkspaceSource({
    workspaceRoot: "/tmp/custom/event-agent",
  });
  expect(managed).toBe("managed");
  expect(external).toBe("external");
});
