import { expect, test } from "bun:test";

import { __testOnlySessionCommand } from "../src/commands/session.ts";

test("resolveWorkspaceProjectName maps isolated workspace names to the base project", () => {
  expect(
    __testOnlySessionCommand.resolveWorkspaceProjectName({
      workspaceName: "alpha--agent-1",
      projects: [
        {
          id: "project-1",
          name: "alpha",
          repoRoot: "/tmp/alpha",
          projectDirName: ".hack",
          projectDir: "/tmp/alpha/.hack",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    })
  ).toBe("alpha");
});

test("resolveWorkspaceProjectName preserves direct workspace-to-project matches", () => {
  expect(
    __testOnlySessionCommand.resolveWorkspaceProjectName({
      workspaceName: "alpha",
      projects: [
        {
          id: "project-1",
          name: "alpha",
          repoRoot: "/tmp/alpha",
          projectDirName: ".hack",
          projectDir: "/tmp/alpha/.hack",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    })
  ).toBe("alpha");
});

test("resolveNextIsolatedWorkspaceName creates siblings from the project base", () => {
  expect(
    __testOnlySessionCommand.resolveNextIsolatedWorkspaceName({
      workspaceName: "alpha--agent-1",
      sessions: [{ name: "alpha" }, { name: "alpha--2" }, { name: "alpha--3" }],
    })
  ).toBe("alpha--4");
});

test("resolveRunUpCwd uses the repo root instead of the .hack directory", () => {
  expect(
    __testOnlySessionCommand.resolveRunUpCwd({
      project: {
        id: "project-1",
        name: "alpha",
        repoRoot: "/tmp/alpha",
        projectDirName: ".hack",
        projectDir: "/tmp/alpha/.hack",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    })
  ).toBe("/tmp/alpha");
});
