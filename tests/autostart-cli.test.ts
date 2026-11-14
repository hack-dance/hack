import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { parsePositionalsForCommand } from "../src/cli/command.ts";
import { runCli } from "../src/cli/run.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { autostartCommand } from "../src/commands/autostart.ts";
import { __testOnlyProjectsCommand } from "../src/commands/projects.ts";
import { serializeAutostartGlobal } from "../src/lib/autostart-view.ts";
import { resetNoInteractiveFlagForTests } from "../src/lib/interactivity.ts";
import { serializeProjectAutostart } from "../src/lib/project-views.ts";
import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import { getDefaultAutostartGlobal } from "../src/lib/projects-registry.ts";
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
let globalState = getDefaultAutostartGlobal();
let explicitRuns = 0;
let explicitEngineWaitMs: number | undefined;
const startupMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/daemon/autostart.ts",
  overrides: {
    runAutostartAtLogin: async (options: {
      readonly engineWaitMs?: number;
    }) => {
      explicitEngineWaitMs = options.engineWaitMs;
      explicitRuns += 1;
      return { waitingForEngine: false };
    },
  },
});
const viewMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/autostart-view.ts",
  overrides: { readAutostartServiceReady: async () => false },
});
const projectMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/project.ts",
  overrides: { findProjectContext: async () => null },
});
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
      return Promise.resolve({
        version: 1,
        projects: [project],
        autostartGlobal: globalState,
      });
    },
    setProjectAutostart: (options: unknown) => {
      mutations.push(options);
      return Promise.resolve(project);
    },
    removeProjectAutostart: (options: unknown) => {
      mutations.push(options);
      const { autostart: _marker, ...withoutMarker } = project;
      return Promise.resolve(withoutMarker);
    },
    setAutostartGlobalPaused: ({ paused }: { readonly paused: boolean }) => {
      globalState = { ...globalState, paused };
      mutations.push({ global: true, paused });
      return Promise.resolve(globalState);
    },
    setProjectAutostartPaused: (options: unknown) => {
      mutations.push(options);
      return Promise.resolve([project]);
    },
  },
});
beforeAll(() => {
  projectMock.activate();
  startupMock.activate();
  viewMock.activate();
  registryMock.activate();
  gitMock.activate();
});
afterAll(() => {
  gitMock.deactivate();
  registryMock.deactivate();
  viewMock.deactivate();
  startupMock.deactivate();
  projectMock.deactivate();
});
beforeEach(() => {
  mutations.length = 0;
  reads = 0;
  explicitRuns = 0;
  explicitEngineWaitMs = undefined;
  linkedRoots.clear();
  globalState = getDefaultAutostartGlobal();
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
        options: { branch: "preview", project: undefined, json: false },
        positionals: parsePositionalsForCommand(
          autostartCommand.subcommands[0].positionals,
          []
        ),
        raw,
      },
    })
  );
  expect(result.code).toBe(0);
  expect(mutations).toEqual([
    {
      id: "example-id",
      branch: "preview",
      observedProject: undefined,
      onPermissionsRepaired: expect.any(Function),
    },
  ]);
  expect(result.output).toContain("hack daemon install");
});

test("pause and resume without a project change global intent independently of project markers", async () => {
  await capture(() =>
    autostartCommand.subcommands[3].handler({
      ctx,
      args: {
        options: { project: undefined, json: false },
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
        options: { project: undefined, json: false },
        positionals: parsePositionalsForCommand(
          autostartCommand.subcommands[0].positionals,
          []
        ),
        raw,
      },
    })
  );
  expect(mutations).toEqual([
    { global: true, paused: true },
    { global: true, paused: false },
  ]);
  expect(reads).toBe(2);
});

test("malformed project selector refuses before registry access or mutation", async () => {
  await expect(
    autostartCommand.subcommands[1].handler({
      ctx,
      args: {
        options: { project: undefined, json: false },
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
    autostart_global: serializeAutostartGlobal(
      getDefaultAutostartGlobal(),
      false
    ),
    projects: [
      {
        project_id: "example-id",
        name: "example",
        autostart: {
          enabled: true,
          state: "on",
          paused_reason: null,
          failures: {
            count: 0,
            last_at: null,
            failed_services: [],
            last_error_code: null,
          },
          max_failures: 3,
          branch: null,
          paused: false,
          last_result: null,
        },
      },
    ],
  });
  expect(result.output).not.toContain("private-admission-id");
  expect(serializeProjectAutostart(undefined)).toEqual({
    enabled: false,
    state: "off",
    paused_reason: null,
    failures: {
      count: 0,
      last_at: null,
      failed_services: [],
      last_error_code: null,
    },
    max_failures: 3,
    branch: null,
    paused: false,
    last_result: null,
  });
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
    enabled: true,
    state: "paused",
    paused_reason: "manual_stop",
    failures: {
      count: 0,
      last_at: null,
      failed_services: [],
      last_error_code: null,
    },
    max_failures: 3,
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
    autostart_global: serializeAutostartGlobal(
      getDefaultAutostartGlobal(),
      false
    ),
    projects: [
      {
        project_id: "example-id",
        name: "example",
        autostart: serializeProjectAutostart({ ...marker, paused: true }),
      },
      {
        project_id: "removed-id",
        autostart: serializeProjectAutostart(undefined),
      },
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
          options: { branch: "preview", project: undefined, json: false },
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

for (const action of ["add", "remove", "pause", "resume"]) {
  test(`autostart ${action} accepts --project with a single JSON success envelope`, async () => {
    try {
      const result = await capture(() =>
        runCli([
          "autostart",
          action,
          "--project",
          "example",
          "--json",
          "--no-interactive",
        ])
      );
      expect(result.code).toBe(0);
      expect(result.output.trim().startsWith("{")).toBe(true);
      expect(result.output.trim().endsWith("}")).toBe(true);
      expect(JSON.parse(result.output)).toMatchObject({
        ok: true,
        data: {
          action,
          projects: [
            {
              project_id: "example-id",
              autostart: { enabled: action !== "remove" },
            },
          ],
          autostart_global: { paused: false, service_ready: false },
        },
      });
    } finally {
      resetNoInteractiveFlagForTests();
    }
  });
}

test("explicit --project and positional name refuse before any registry read", async () => {
  const result = await capture(() =>
    runCli([
      "autostart",
      "add",
      "example",
      "--project",
      "example",
      "--json",
      "--no-interactive",
    ])
  );
  resetNoInteractiveFlagForTests();
  expect(result.code).toBe(1);
  expect(reads).toBe(0);
  expect(mutations).toEqual([]);
});

test("explicit autostart run intentionally invokes the scheduler and emits JSON", async () => {
  try {
    const result = await capture(() =>
      runCli(["autostart", "run", "--json", "--no-interactive"])
    );
    expect(result.code).toBe(0);
    expect(explicitRuns).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        action: "run",
        waiting_for_engine: false,
        autostart_global: { paused: false },
      },
    });
  } finally {
    resetNoInteractiveFlagForTests();
  }
});

test("explicit autostart run validates and forwards a user-supplied engine wait bound", async () => {
  try {
    const valid = await capture(() =>
      runCli([
        "autostart",
        "run",
        "--engine-wait-ms",
        "5000",
        "--json",
        "--no-interactive",
      ])
    );
    expect(valid.code).toBe(0);
    expect(explicitEngineWaitMs).toBe(5000);
    expect(explicitRuns).toBe(1);
    const invalid = await capture(() =>
      runCli([
        "autostart",
        "run",
        "--engine-wait-ms=0",
        "--json",
        "--no-interactive",
      ])
    );
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.output)).toMatchObject({
      ok: false,
      error: { code: "E_USAGE" },
    });
    expect(explicitRuns).toBe(1);
  } finally {
    resetNoInteractiveFlagForTests();
  }
});
