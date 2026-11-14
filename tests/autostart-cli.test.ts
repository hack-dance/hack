import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { parsePositionalsForCommand } from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { autostartCommand } from "../src/commands/autostart.ts";
import { __testOnlyProjectsCommand } from "../src/commands/projects.ts";
import { serializeProjectAutostart } from "../src/lib/project-views.ts";
import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const marker = {
  branch: null,
  paused: false,
  lastResult: null,
  lastAttemptBootId: "private-admission-id",
} as const;
const project: RegisteredProject = {
  id: "example-id",
  name: "example",
  repoRoot: "/example/project",
  projectDir: "/example/project/.hack",
  projectDirName: ".hack",
  createdAt: "2026-01-01T00:00:00Z",
  autostart: marker,
};
const mutations: unknown[] = [];
let reads = 0;
const linkedRoots = new Set<string>();
const gitMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/git-worktree.ts",
  overrides: {
    isLinkedGitWorktree: ({ repoRoot }: { readonly repoRoot: string }) =>
      Promise.resolve(linkedRoots.has(repoRoot)),
  },
});
const registryMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/projects-registry.ts",
  overrides: {
    readProjectsRegistry: () => {
      reads += 1;
      return Promise.resolve({ version: 1, projects: [project] });
    },
    setProjectAutostart: (options: unknown) => {
      mutations.push(options);
      return Promise.resolve(project);
    },
    removeProjectAutostart: (options: unknown) => {
      mutations.push(options);
      return Promise.resolve(project);
    },
    setProjectAutostartPaused: (options: unknown) => {
      mutations.push(options);
      return Promise.resolve([project]);
    },
  },
});
beforeAll(() => {
  registryMock.activate();
  gitMock.activate();
});
afterAll(() => {
  gitMock.deactivate();
  registryMock.deactivate();
});
beforeEach(() => {
  mutations.length = 0;
  reads = 0;
  linkedRoots.clear();
});
const ctx = { cwd: "/example/project/subdirectory", cli: CLI_SPEC };
const raw = { argv: [], positionals: [] };

async function capture(action: () => Promise<number>) {
  let output = "";
  const write = spyOn(process.stdout, "write").mockImplementation((value) => {
    output += String(value);
    return true;
  });
  try {
    return { code: await action(), output };
  } finally {
    write.mockRestore();
  }
}

test("autostart add selects current registered project and passes branch without reading project configuration", async () => {
  const result = await capture(() =>
    autostartCommand.subcommands[0].handler({
      ctx,
      args: {
        options: { branch: "preview" },
        positionals: parsePositionalsForCommand(
          autostartCommand.subcommands[0].positionals,
          []
        ),
        raw,
      },
    })
  );
  expect(result.code).toBe(0);
  expect(mutations).toEqual([{ id: "example-id", branch: "preview" }]);
  expect(result.output).toContain("hack daemon install");
});

test("pause and resume without a project select every marker", async () => {
  await capture(() =>
    autostartCommand.subcommands[3].handler({
      ctx,
      args: {
        options: {},
        positionals: parsePositionalsForCommand(
          autostartCommand.subcommands[0].positionals,
          []
        ),
        raw,
      },
    })
  );
  await capture(() =>
    autostartCommand.subcommands[4].handler({
      ctx,
      args: {
        options: {},
        positionals: parsePositionalsForCommand(
          autostartCommand.subcommands[0].positionals,
          []
        ),
        raw,
      },
    })
  );
  expect(mutations).toEqual([
    { id: undefined, paused: true },
    { id: undefined, paused: false },
  ]);
  expect(reads).toBe(0);
});

test("malformed project selector refuses before registry access or mutation", async () => {
  await expect(
    autostartCommand.subcommands[1].handler({
      ctx,
      args: {
        options: {},
        positionals: parsePositionalsForCommand(
          autostartCommand.subcommands[1].positionals,
          ["KEY=value"]
        ),
        raw,
      },
    })
  ).rejects.toThrow("Invalid --project value");
  expect(reads).toBe(0);
  expect(mutations).toEqual([]);
});

test("autostart list JSON exposes stable policy and result fields without admission bookkeeping", async () => {
  const result = await capture(() =>
    autostartCommand.subcommands[2].handler({
      ctx,
      args: { options: { json: true }, positionals: {}, raw },
    })
  );
  expect(JSON.parse(result.output)).toEqual({
    projects: [
      {
        project_id: "example-id",
        name: "example",
        autostart: { branch: null, paused: false, last_result: null },
      },
    ],
  });
  expect(result.output).not.toContain("private-admission-id");
  expect(serializeProjectAutostart(undefined)).toBeNull();
  expect(
    serializeProjectAutostart({
      ...marker,
      paused: true,
      lastResult: {
        status: "skipped",
        reason: "interactive_required",
        at: "2026-01-01T00:00:00Z",
      },
    })
  ).toEqual({
    branch: null,
    paused: true,
    last_result: {
      status: "skipped",
      reason: "interactive_required",
      at: "2026-01-01T00:00:00Z",
    },
  });
});

test("fresh registry policy overrides cached daemon results and removed markers", () => {
  const cached = {
    projects: [
      {
        project_id: "example-id",
        name: "example",
        autostart: { paused: false },
      },
      { project_id: "removed-id", autostart: { paused: false } },
    ],
    runtime_ok: true,
  };
  expect(
    __testOnlyProjectsCommand.overlayAutostartPolicy({
      cached,
      projects: [{ ...project, autostart: { ...marker, paused: true } }],
    })
  ).toEqual({
    projects: [
      {
        project_id: "example-id",
        name: "example",
        autostart: { branch: null, paused: true, last_result: null },
      },
      { project_id: "removed-id", autostart: null },
    ],
    runtime_ok: true,
  });
  expect(cached.projects[0]?.autostart.paused).toBe(false);
});

for (const linkedRoot of [ctx.cwd, project.repoRoot]) {
  test(`autostart add refuses linked checkout admission at ${linkedRoot === ctx.cwd ? "cwd" : "registered root"}`, async () => {
    linkedRoots.add(linkedRoot);
    await expect(
      autostartCommand.subcommands[0].handler({
        ctx,
        args: {
          options: { branch: "preview" },
          positionals: parsePositionalsForCommand(
            autostartCommand.subcommands[0].positionals,
            ["example"]
          ),
          raw,
        },
      })
    ).rejects.toThrow("Autostart currently requires the primary checkout");
    expect(mutations).toEqual([]);
  });
}
