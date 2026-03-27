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

test("inferWorkspaceScopeSelection parses scoped workspace names", () => {
  expect(
    __testOnlySessionCommand.inferWorkspaceScopeSelection({
      workspaceName: "alpha.env-qa.svc-api_worker.v2--2",
    })
  ).toEqual({
    hasScopedSelection: true,
    envName: "qa",
    serviceName: "api_worker.v2",
  });
});

test("inferWorkspaceScopeSelection treats env-base as the base overlay", () => {
  expect(
    __testOnlySessionCommand.inferWorkspaceScopeSelection({
      workspaceName: "alpha.env-base--2",
    })
  ).toEqual({
    hasScopedSelection: true,
    envName: null,
    serviceName: null,
  });
});

test("resolveEffectiveWorkspaceScopeSelection preserves inferred scoped env", () => {
  expect(
    __testOnlySessionCommand.resolveEffectiveWorkspaceScopeSelection({
      workspaceName: "alpha.env-qa.svc-api_worker.v2--2",
      envOptionSpecified: false,
      envName: undefined,
      serviceOptionSpecified: false,
      serviceName: null,
    })
  ).toEqual({
    shouldInject: true,
    envName: "qa",
    serviceName: "api_worker.v2",
  });
});

test("resolveEffectiveWorkspaceScopeSelection keeps base workspaces unscoped", () => {
  expect(
    __testOnlySessionCommand.resolveEffectiveWorkspaceScopeSelection({
      workspaceName: "alpha--2",
      envOptionSpecified: false,
      envName: undefined,
      serviceOptionSpecified: false,
      serviceName: null,
    })
  ).toEqual({
    shouldInject: false,
    envName: undefined,
    serviceName: null,
  });
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

test("resolveWorkspaceBackendName detects zellij-backed workspaces", () => {
  expect(
    __testOnlySessionCommand.resolveWorkspaceBackendName({
      workspaceName: "alpha--agent-1",
      sessions: [
        {
          backend: "zellij",
          name: "alpha--agent-1",
          attached: null,
          path: null,
          windows: null,
          createdAt: null,
        },
      ],
    })
  ).toBe("zellij");
});

test("resolveTmuxOnlyWorkspaceError explains tmux-only pane tooling on zellij", () => {
  expect(
    __testOnlySessionCommand.resolveTmuxOnlyWorkspaceError({
      workspaceName: "alpha--agent-1",
      sessions: [
        {
          backend: "zellij",
          name: "alpha--agent-1",
          attached: null,
          path: null,
          windows: null,
          createdAt: null,
        },
      ],
    })
  ).toContain("tmux-only");
});

test("resolveWorkspaceBackendNameForCreate prefers the existing workspace backend over the default", () => {
  expect(
    __testOnlySessionCommand.resolveWorkspaceBackendNameForCreate({
      preferredBackendName: "zellij",
      defaultBackendName: "tmux",
    })
  ).toBe("zellij");
});
