import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEffectiveBranchIdentityForCommand } from "../src/commands/project.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import {
  listNativeBranchRecords,
  listNativeCopyInstances,
} from "../src/lib/branch-instance-identity.ts";
import { readBranchUsage, recordBranchUsage } from "../src/lib/branch-usage.ts";
import { writeBranchesFile } from "../src/lib/branches.ts";
import { withProcessDeadline } from "../src/lib/process-deadline.ts";
import {
  buildProjectViews,
  serializeProjectView,
} from "../src/lib/project-views.ts";
import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
  RuntimeService,
} from "../src/lib/runtime-projects.ts";
import { restoreEnv } from "./helpers/env.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Contracts for explicit branch instance identity in `/v1/projects`
 * (HACK-2281, desktop requests R19 and R20): the original branch name, the
 * owning checkout, hosts per service and the URL `hack open --branch`
 * opens, for Compose and native instances. All fields are additive.
 */

let root: string | null = null;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-branch-ident-")));
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "global.config.json");
});

afterEach(async () => {
  if (originalGlobalConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

function requireRoot(): string {
  if (!root) {
    throw new Error("root not set");
  }
  return root;
}

async function writeCheckout(opts: {
  readonly checkoutRoot: string;
  readonly config: Record<string, unknown>;
}): Promise<string> {
  const projectDir = join(opts.checkoutRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_COMPOSE_FILENAME),
    [
      "services:",
      "  web:",
      "    labels:",
      '      caddy: "alpha.hack, alpha.hack.gy"',
      "  api:",
      "    labels:",
      '      caddy: "api.alpha.hack"',
      "",
    ].join("\n")
  );
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(opts.config)}\n`
  );
  return projectDir;
}

async function createProject(opts: {
  readonly config?: Record<string, unknown>;
  readonly worktrees?: readonly { path: string; branch: string | null }[];
}): Promise<RegisteredProject> {
  const repoRoot = join(requireRoot(), "alpha");
  const projectDir = await writeCheckout({
    checkoutRoot: repoRoot,
    config: opts.config ?? {
      name: "alpha",
      dev_host: "alpha.hack",
      oauth: { enabled: true },
    },
  });
  return {
    id: "alpha-id",
    name: "alpha",
    repoRoot,
    projectDirName: ".hack",
    projectDir,
    devHost: "alpha.hack",
    createdAt: "2026-01-01T00:00:00Z",
    ...(opts.worktrees
      ? {
          worktrees: opts.worktrees.map((entry) => ({
            path: entry.path,
            branch: entry.branch,
            lastSeenAt: "2026-01-01T00:00:00Z",
          })),
        }
      : {}),
  };
}

function container(opts: {
  readonly project: string;
  readonly service: string;
  readonly workingDir: string;
  readonly caddy?: string;
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.service}`,
    project: opts.project,
    service: opts.service,
    state: "running",
    status: "Up 5s",
    name: `${opts.project}-${opts.service}-1`,
    ports: "",
    workingDir: opts.workingDir,
    image: "busybox:1.37",
    labels: {
      "com.docker.compose.project": opts.project,
      "com.docker.compose.service": opts.service,
      ...(opts.caddy ? { caddy: opts.caddy } : {}),
      "caddy.reverse_proxy": "{{upstreams 3000}}",
    },
    mounts: [],
    networks: [],
  };
}

function branchRuntime(opts: {
  readonly slug: string;
  readonly workingDir: string;
}): RuntimeProject {
  const project = `alpha--${opts.slug}`;
  const services = new Map<string, RuntimeService>([
    [
      "web",
      {
        service: "web",
        containers: [
          container({
            project,
            service: "web",
            workingDir: opts.workingDir,
            caddy: `${opts.slug}.alpha.hack, ${opts.slug}.alpha.hack.gy`,
          }),
        ],
      },
    ],
    [
      "api",
      {
        service: "api",
        containers: [
          container({
            project,
            service: "api",
            workingDir: opts.workingDir,
            // Whitespace-separated sites, as Caddy accepts.
            caddy: `api.${opts.slug}.alpha.hack internal.${opts.slug}.alpha.hack`,
          }),
        ],
      },
    ],
  ]);
  return { project, workingDir: opts.workingDir, services, isGlobal: false };
}

async function serializedProject(opts: {
  readonly registration: RegisteredProject;
  readonly runtime: readonly RuntimeProject[];
}): Promise<Record<string, unknown>> {
  const [view] = await buildProjectViews({
    registryProjects: [opts.registration],
    runtime: opts.runtime,
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });
  if (!view) {
    throw new Error("no view");
  }
  return serializeProjectView(view);
}

type BranchEntry = Record<string, unknown> & { readonly branch: string };

function branchEntries(
  payload: Record<string, unknown>,
  field: "branch_runtime" | "native_branch_runtime"
): BranchEntry[] {
  return payload[field] as BranchEntry[];
}

test("compose: recorded name, owning checkout, label hosts and alias URL", async () => {
  const registration = await createProject({});
  await recordBranchUsage({
    projectDir: registration.projectDir,
    branch: "feature-x",
    name: "Feature/X",
  });
  const payload = await serializedProject({
    registration,
    runtime: [
      branchRuntime({ slug: "feature-x", workingDir: registration.projectDir }),
    ],
  });
  expect(payload.open_url).toBe("https://alpha.hack.gy");
  expect(payload.open_url_host).toBe("alias");
  const [entry] = branchEntries(payload, "branch_runtime");
  expect(entry?.branch).toBe("feature-x");
  // The existing runtime projection is unchanged.
  expect((entry?.runtime as Record<string, unknown>).project).toBe(
    "alpha--feature-x"
  );
  expect(entry).toMatchObject({
    backend: "compose",
    branch_name: "Feature/X",
    branch_name_source: "recorded",
    checkout: {
      root: registration.repoRoot,
      project_dir: registration.projectDir,
      kind: "primary",
    },
    hosts: {
      api: ["api.feature-x.alpha.hack", "internal.feature-x.alpha.hack"],
      web: ["feature-x.alpha.hack", "feature-x.alpha.hack.gy"],
    },
    hosts_source: "runtime_labels",
    url: "https://feature-x.alpha.hack.gy",
    url_host: "alias",
  });
  expect(branchEntries(payload, "native_branch_runtime")).toEqual([]);
});

test("lists configured and previously used copies even with no containers", async () => {
  const worktree = join(requireRoot(), "worktree");
  // It has never been registered by a lifecycle command.
  const registration = await createProject({});
  for (const args of [
    ["init", "-b", "feature-search"],
    ["commit", "--allow-empty", "-m", "fixture"],
    ["worktree", "add", "-b", "feature/search", worktree],
  ]) {
    const result = await runFixtureGit({ cwd: registration.repoRoot, args });
    expect(result.exitCode, result.stderr).toBe(0);
  }
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktree,
    config: {
      name: "alpha",
      dev_host: "checkout.hack",
      open: { prefer: "dev" },
    },
  });
  const automaticBranch = (
    await resolveEffectiveBranchIdentityForCommand({
      project: {
        projectRoot: worktree,
        projectDir: worktreeDir,
        projectDirName: ".hack",
        configFile: join(worktreeDir, PROJECT_CONFIG_FILENAME),
        composeFile: join(worktreeDir, PROJECT_COMPOSE_FILENAME),
        envFile: join(worktreeDir, ".env"),
      },
      branchOption: undefined,
      noticeToStderr: true,
    })
  ).branch;
  expect(automaticBranch).toMatch(/^feature-search-[a-f0-9]+$/);
  await writeBranchesFile({
    path: join(registration.projectDir, "hack.branches.json"),
    file: {
      version: 1,
      branches: [{ name: "Release 2", slug: "release-2" }],
    },
  });
  await recordBranchUsage({
    projectDir: worktreeDir,
    branch: "before-rename",
    name: "Before Rename",
  });
  const payload = await serializedProject({ registration, runtime: [] });
  expect(payload.branch_runtime).toEqual([]);
  expect(payload.branch_copies).toHaveLength(3);
  expect(payload.branch_copies).toEqual(
    expect.arrayContaining([
      {
        branch: "release-2",
        compose_project: "alpha--release-2",
        branch_name: "Release 2",
        checkout: {
          root: registration.repoRoot,
          project_dir: registration.projectDir,
          kind: "primary",
        },
        url: "https://release-2.alpha.hack.gy",
        defined_services: ["api", "web"],
        recorded: false,
      },
      {
        branch: automaticBranch,
        compose_project: `alpha--${automaticBranch}`,
        branch_name: "feature/search",
        checkout: {
          root: worktree,
          project_dir: worktreeDir,
          kind: "worktree",
        },
        url: `https://${automaticBranch}.checkout.hack`,
        defined_services: ["api", "web"],
        recorded: false,
      },
      {
        branch: "before-rename",
        compose_project: "alpha--before-rename",
        branch_name: "Before Rename",
        checkout: {
          root: worktree,
          project_dir: worktreeDir,
          kind: "worktree",
        },
        url: "https://before-rename.checkout.hack",
        defined_services: ["api", "web"],
        recorded: true,
      },
    ])
  );
  await writeFile(
    join(worktreeDir, PROJECT_CONFIG_FILENAME),
    JSON.stringify({
      name: "alpha",
      dev_host: "checkout.hack",
      worktree: { auto_branch: false },
    })
  );
  const optedOut = await serializedProject({
    registration,
    runtime: [
      {
        ...branchRuntime({ slug: "feature", workingDir: worktreeDir }),
        project: "hack",
      },
    ],
  });
  expect(optedOut.runtime).toBeNull();
  expect(optedOut.branch_copies).toMatchObject([
    { branch: "release-2" },
    { branch: "before-rename", recorded: true },
    {
      branch: null,
      branch_name: "feature/search",
      url: "https://checkout.hack",
      compose_project: "hack",
      runtime: { project: "hack" },
    },
  ]);
  await writeFile(join(worktreeDir, "hack.project.json"), "{}\n");
  const conflict = await serializedProject({ registration, runtime: [] });
  expect(conflict.branch_copies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        branch: "release-2",
        url: "https://release-2.alpha.hack.gy",
      }),
      expect.objectContaining({
        branch: null,
        url: null,
        checkout: expect.objectContaining({ root: worktree }),
      }),
    ])
  );
});

test("a branch-only runtime in the primary checkout is not the main copy", async () => {
  const registration = await createProject({});
  const payload = await serializedProject({
    registration,
    runtime: [
      branchRuntime({ slug: "release-2", workingDir: registration.projectDir }),
    ],
  });
  expect(payload.runtime).toBeNull();
  expect(payload.runtime_status).toBe("stopped");
  expect(branchEntries(payload, "branch_runtime")).toHaveLength(1);
});

test("a reused registered worktree path supplies no actionable copies", async () => {
  const worktree = join(requireRoot(), "reused");
  const registration = await createProject({
    worktrees: [{ path: worktree, branch: "previous" }],
  });
  for (const args of [
    ["init", "-b", "main"],
    ["commit", "--allow-empty", "-m", "fixture"],
    ["worktree", "add", "-b", "previous", worktree],
  ]) {
    const result = await runFixtureGit({ cwd: registration.repoRoot, args });
    expect(result.exitCode, result.stderr).toBe(0);
  }
  await rm(worktree, { force: true, recursive: true });
  const projectDir = await writeCheckout({
    checkoutRoot: worktree,
    config: { name: "foreign", dev_host: "other.hack" },
  });
  const foreign = await runFixtureGit({
    cwd: worktree,
    args: ["init", "-b", "other"],
  });
  expect(foreign.exitCode, foreign.stderr).toBe(0);
  await recordBranchUsage({ projectDir, branch: "other", name: "Other repo" });
  const listing = await serializedProject({
    registration,
    runtime: [branchRuntime({ slug: "previous", workingDir: projectDir })],
  });
  expect(listing.branch_copies).toMatchObject([
    { branch: null, branch_name: "previous", url: null, defined_services: [] },
  ]);
  const stale = branchEntries(listing, "branch_runtime")[0];
  expect(stale).toMatchObject({
    branch: "previous",
    checkout_verified: false,
    branch_name: null,
    url: null,
  });
});

test("custom Compose names identify branches in both checkouts", async () => {
  const worktree = join(requireRoot(), "worktree");
  const registration = await createProject({});
  for (const args of [
    ["init", "-b", "main"],
    ["commit", "--allow-empty", "-m", "fixture"],
    ["worktree", "add", "-b", "feature", worktree],
  ]) {
    const result = await runFixtureGit({ cwd: registration.repoRoot, args });
    expect(result.exitCode, result.stderr).toBe(0);
  }
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktree,
    config: { name: "alpha" },
  });
  await writeFile(
    join(registration.projectDir, PROJECT_COMPOSE_FILENAME),
    "name: primary_stack\nservices: {}\n"
  );
  await writeFile(
    join(worktreeDir, PROJECT_COMPOSE_FILENAME),
    "name: worktree_stack\nservices: {}\n"
  );
  const payload = await serializedProject({
    registration,
    runtime: [
      {
        ...branchRuntime({
          slug: "feature",
          workingDir: registration.projectDir,
        }),
        project: "primary_stack--feature",
      },
      {
        ...branchRuntime({ slug: "feature", workingDir: worktreeDir }),
        project: "worktree_stack--feature",
      },
    ],
  });
  expect(payload.runtime).toBeNull();
  expect(branchEntries(payload, "branch_runtime")).toMatchObject([
    { branch: "feature", checkout: { root: registration.repoRoot } },
    { branch: "feature", checkout: { root: worktree } },
  ]);
});

test("a shared Compose name keeps a branch with its owning project", async () => {
  const registration = await createProject({});
  const worktree = join(requireRoot(), "worktree");
  for (const args of [
    ["init", "-b", "main"],
    ["commit", "--allow-empty", "-m", "fixture"],
    ["worktree", "add", "-b", "feature", worktree],
  ]) {
    const result = await runFixtureGit({ cwd: registration.repoRoot, args });
    expect(result.exitCode, result.stderr).toBe(0);
  }
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktree,
    config: { name: "alpha" },
  });
  const otherRoot = join(requireRoot(), "other");
  const other = {
    ...registration,
    id: "other-id",
    name: "other",
    repoRoot: otherRoot,
    projectDir: await writeCheckout({
      checkoutRoot: otherRoot,
      config: { name: "other" },
    }),
  };
  for (const projectDir of [
    registration.projectDir,
    other.projectDir,
    worktreeDir,
  ]) {
    await writeFile(
      join(projectDir, PROJECT_COMPOSE_FILENAME),
      "name: shared\nservices: {}\n"
    );
  }
  const views = await buildProjectViews({
    registryProjects: [registration, other],
    runtime: [
      {
        ...branchRuntime({
          slug: "preview",
          workingDir: registration.projectDir,
        }),
        project: "shared--preview",
      },
      {
        ...branchRuntime({ slug: "feature", workingDir: worktreeDir }),
        project: "shared--feature",
      },
      {
        ...branchRuntime({
          slug: "external",
          workingDir: join(requireRoot(), "elsewhere"),
        }),
        project: "shared--external",
      },
    ],
    runtimeOk: true,
    filter: null,
    includeUnregistered: true,
    muxSessions: [],
  });
  expect(
    views.map((view) => ({
      name: view.name,
      branches: view.branchRuntime.map((entry) => entry.branch),
    }))
  ).toEqual([
    { name: "alpha", branches: ["preview", "feature"] },
    { name: "other", branches: [] },
    { name: "shared--external", branches: [] },
  ]);
  await writeFile(
    join(other.projectDir, PROJECT_COMPOSE_FILENAME),
    'name: "${HACK_TEST_STACK_NAME:-shared}"\nservices: {}\n'
  );
  await recordBranchUsage({
    projectDir: other.projectDir,
    branch: "preview",
    name: "preview",
  });
  const expired = await withProcessDeadline(Date.now() - 1, () =>
    buildProjectViews({
      registryProjects: [registration, other],
      runtime: [
        {
          ...branchRuntime({
            slug: "irrelevant",
            workingDir: registration.projectDir,
          }),
          project: "shared",
        },
      ],
      runtimeOk: true,
      filter: null,
      includeUnregistered: true,
      muxSessions: [],
    })
  );
  const [owner, unresolved] = expired.map(serializeProjectView);
  expect(owner).toMatchObject({
    name: "alpha",
    runtime: { project: "shared" },
  });
  expect(unresolved).toMatchObject({
    name: "other",
    runtime: null,
    compose_project: null,
    compose_project_unresolved: true,
    branch_copies: [{ branch: "preview", compose_project_unresolved: true }],
  });
});

const composeTest =
  process.env.HACK_TEST_COMPOSE_CONFIG === "1" ? test : test.skip;

composeTest(
  "the listing preserves interpolated Compose identities with or without containers",
  async () => {
    const registration = await createProject({});
    const compose = join(registration.projectDir, PROJECT_COMPOSE_FILENAME);
    await writeFile(
      compose,
      'name: "${HACK_TEST_STACK_NAME:-demo}"\nservices: {}\n'
    );
    const previousName = process.env.HACK_TEST_STACK_NAME;
    const previousComposeName = process.env.COMPOSE_PROJECT_NAME;
    const previousEnvFiles = process.env.COMPOSE_ENV_FILES;
    const previousDisableEnv = process.env.COMPOSE_DISABLE_ENV_FILE;
    try {
      Reflect.deleteProperty(process.env, "HACK_TEST_STACK_NAME");
      Reflect.deleteProperty(process.env, "COMPOSE_PROJECT_NAME");
      Reflect.deleteProperty(process.env, "COMPOSE_ENV_FILES");
      Reflect.deleteProperty(process.env, "COMPOSE_DISABLE_ENV_FILE");
      const stopped = await serializedProject({ registration, runtime: [] });
      expect(stopped).toMatchObject({ compose_project: "demo", runtime: null });
      await writeFile(
        join(registration.projectDir, ".env"),
        "HACK_TEST_STACK_NAME=dotenv_stack\n"
      );
      const dotenv = await serializedProject({ registration, runtime: [] });
      expect(dotenv.compose_project).toBe("dotenv_stack");
      process.env.HACK_TEST_STACK_NAME = "shell_stack";
      const running = await serializedProject({
        registration,
        runtime: [
          {
            ...branchRuntime({
              slug: "unused",
              workingDir: registration.projectDir,
            }),
            project: "shell_stack",
          },
        ],
      });
      expect(running).toMatchObject({
        compose_project: "shell_stack",
        runtime: { project: "shell_stack" },
      });

      await writeFile(compose, "name: demo\nservices: {}\n");
      await writeFile(
        join(registration.projectDir, ".env"),
        "COMPOSE_PROJECT_NAME=alternate\n"
      );
      await recordBranchUsage({
        projectDir: registration.projectDir,
        branch: "preview",
        name: "preview",
      });
      const overridden = await serializedProject({
        registration,
        runtime: ["alternate", "demo--preview"].map((name) => ({
          ...branchRuntime({
            slug: "preview",
            workingDir: registration.projectDir,
          }),
          project: name,
        })),
      });
      expect(overridden).toMatchObject({
        compose_project: "alternate",
        runtime: { project: "alternate" },
        branch_copies: [
          { branch: "preview", compose_project: "demo--preview" },
        ],
      });
      expect(branchEntries(overridden, "branch_runtime")).toMatchObject([
        { branch: "preview", compose_project: "demo--preview" },
      ]);

      await writeFile(
        compose,
        'name: "${HACK_TEST_STACK_NAME:-demo}"\nservices: {}\n'
      );
      Reflect.deleteProperty(process.env, "HACK_TEST_STACK_NAME");
      const interpolatedBranch = await serializedProject({
        registration,
        runtime: ["alternate", "demo--preview"].map((name) => ({
          ...branchRuntime({
            slug: "preview",
            workingDir: registration.projectDir,
          }),
          project: name,
        })),
      });
      expect(interpolatedBranch).toMatchObject({
        compose_project: "alternate",
        runtime: { project: "alternate" },
        branch_copies: [
          { branch: "preview", compose_project: "demo--preview" },
        ],
      });
      expect(branchEntries(interpolatedBranch, "branch_runtime")).toMatchObject(
        [{ branch: "preview", compose_project: "demo--preview" }]
      );
    } finally {
      restoreEnv("HACK_TEST_STACK_NAME", previousName);
      restoreEnv("COMPOSE_PROJECT_NAME", previousComposeName);
      restoreEnv("COMPOSE_ENV_FILES", previousEnvFiles);
      restoreEnv("COMPOSE_DISABLE_ENV_FILE", previousDisableEnv);
    }
  }
);

test("compose: open.prefer dev uses the dev host, as hack open does", async () => {
  const registration = await createProject({
    config: {
      name: "alpha",
      dev_host: "alpha.hack",
      oauth: { enabled: true },
      open: { prefer: "dev" },
    },
  });
  const payload = await serializedProject({
    registration,
    runtime: [
      branchRuntime({ slug: "qa", workingDir: registration.projectDir }),
    ],
  });
  expect(payload.open_url).toBe("https://alpha.hack");
  const [entry] = branchEntries(payload, "branch_runtime");
  expect(entry).toMatchObject({
    url: "https://qa.alpha.hack",
    url_host: "dev",
    branch_name: null,
    branch_name_source: null,
  });
});

test("compose: a branch started from a linked worktree is owned by that worktree", async () => {
  const worktreeRoot = join(requireRoot(), "alpha-wt");
  const registration = await createProject({
    worktrees: [{ path: worktreeRoot, branch: "fix/login" }],
  });
  for (const args of [
    ["init", "-b", "main"],
    ["commit", "--allow-empty", "-m", "fixture"],
    ["worktree", "add", "-b", "fix/login", worktreeRoot],
  ]) {
    const result = await runFixtureGit({ cwd: registration.repoRoot, args });
    expect(result.exitCode, result.stderr).toBe(0);
  }
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktreeRoot,
    // The worktree's own config decides what hack open opens there.
    config: { name: "alpha", dev_host: "alpha.hack", open: { prefer: "dev" } },
  });
  const payload = await serializedProject({
    registration,
    runtime: [branchRuntime({ slug: "fix-login", workingDir: worktreeDir })],
  });
  const [entry] = branchEntries(payload, "branch_runtime");
  expect(entry).toMatchObject({
    branch: "fix-login",
    branch_name: "fix/login",
    branch_name_source: "worktree_registration",
    checkout: {
      root: worktreeRoot,
      project_dir: worktreeDir,
      kind: "worktree",
    },
    url: "https://fix-login.alpha.hack",
    url_host: "dev",
  });

  // A name recorded by `hack up` in the worktree wins over the registration.
  await recordBranchUsage({
    projectDir: worktreeDir,
    branch: "fix-login",
    name: "Fix/Login",
  });
  const recorded = await serializedProject({
    registration,
    runtime: [branchRuntime({ slug: "fix-login", workingDir: worktreeDir })],
  });
  expect(branchEntries(recorded, "branch_runtime")[0]).toMatchObject({
    branch_name: "Fix/Login",
    branch_name_source: "recorded",
  });
});

test("compose: a worktree owner without its .hack dir reports no URL", async () => {
  const worktreeRoot = join(requireRoot(), "alpha-wt");
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktreeRoot,
    config: { name: "alpha", dev_host: "alpha.hack" },
  });
  const registration = await createProject({
    worktrees: [{ path: worktreeRoot, branch: "fix/login" }],
  });
  await rm(worktreeDir, { recursive: true, force: true });
  const payload = await serializedProject({
    registration,
    runtime: [branchRuntime({ slug: "fix-login", workingDir: worktreeDir })],
  });
  expect(branchEntries(payload, "branch_runtime")[0]).toMatchObject({
    checkout: { root: worktreeRoot, kind: "worktree" },
    url: null,
    url_host: null,
    // Routes still come from the running containers.
    hosts_source: "runtime_labels",
  });
});

test("compose: an instance outside every checkout has no owner or name", async () => {
  const registration = await createProject({});
  const foreign = join(requireRoot(), "elsewhere", ".hack");
  await mkdir(foreign, { recursive: true });
  await recordBranchUsage({
    projectDir: registration.projectDir,
    branch: "x",
    name: "X",
  });
  const payload = await serializedProject({
    registration,
    runtime: [branchRuntime({ slug: "x", workingDir: foreign })],
  });
  expect(branchEntries(payload, "branch_runtime")[0]).toMatchObject({
    checkout: null,
    branch_name: null,
    url: null,
    hosts_source: "runtime_labels",
  });
});

function nativeRunKey(branch: string | null): string {
  return createHash("sha256").update(JSON.stringify(branch)).digest("hex");
}

async function writeNativeRun(opts: {
  readonly projectDir: string;
  readonly dir: "native-runs" | "native-authored-runs";
  readonly branch: string | null;
  readonly suffix?: string;
}): Promise<void> {
  const store = join(opts.projectDir, ".internal", opts.dir);
  await mkdir(store, { recursive: true });
  await writeFile(
    join(store, `${nativeRunKey(opts.branch)}${opts.suffix ?? ""}.json`),
    JSON.stringify({
      version: 1,
      scope: { projectDir: opts.projectDir, branch: opts.branch },
      run: {},
    }),
    { mode: 0o600 }
  );
}

test("native: branch instances come from saved run mappings, no subprocess", async () => {
  const worktreeRoot = join(requireRoot(), "alpha-wt");
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktreeRoot,
    config: { name: "alpha", dev_host: "alpha.hack", oauth: { enabled: true } },
  });
  const registration = await createProject({
    worktrees: [{ path: worktreeRoot, branch: "wt/feature" }],
  });
  await writeNativeRun({
    projectDir: registration.projectDir,
    dir: "native-runs",
    branch: null,
  });
  await writeNativeRun({
    projectDir: registration.projectDir,
    dir: "native-runs",
    branch: "feat-a",
  });
  // Restart intents and other siblings are not instances.
  await writeNativeRun({
    projectDir: registration.projectDir,
    dir: "native-runs",
    branch: "ghost",
    suffix: ".restart",
  });
  // Authored mappings belong to authored projects only (tested below).
  await writeNativeRun({
    projectDir: registration.projectDir,
    dir: "native-authored-runs",
    branch: "authored-b",
  });
  await writeNativeRun({
    projectDir: worktreeDir,
    dir: "native-runs",
    branch: "wt-feature",
  });
  await recordBranchUsage({
    projectDir: registration.projectDir,
    branch: "feat-a",
    name: "Feat/A",
  });

  const payload = await serializedProject({ registration, runtime: [] });
  expect(branchEntries(payload, "branch_runtime")).toEqual([]);
  const native = branchEntries(payload, "native_branch_runtime");
  expect(native.map((entry) => entry.branch).sort()).toEqual([
    "feat-a",
    "wt-feature",
  ]);
  const byBranch = Object.fromEntries(native.map((e) => [e.branch, e]));
  expect(byBranch["feat-a"]).toEqual({
    branch: "feat-a",
    backend: "native",
    state: "recorded",
    store: "runtime",
    branch_name: "Feat/A",
    branch_name_source: "recorded",
    checkout: {
      root: registration.repoRoot,
      project_dir: registration.projectDir,
      kind: "primary",
    },
    hosts: {
      api: ["api.feat-a.alpha.hack"],
      web: ["feat-a.alpha.hack", "feat-a.alpha.hack.gy"],
    },
    hosts_source: "config",
    url: "https://feat-a.alpha.hack.gy",
    url_host: "alias",
  });
  expect(byBranch["wt-feature"]).toMatchObject({
    branch_name: "wt/feature",
    branch_name_source: "worktree_registration",
    checkout: { root: worktreeRoot, kind: "worktree" },
  });
});

test("native: numbered site labels count, and a missing primary hides no worktree", async () => {
  const worktreeRoot = join(requireRoot(), "alpha-wt");
  const worktreeDir = await writeCheckout({
    checkoutRoot: worktreeRoot,
    config: { name: "alpha", dev_host: "alpha.hack" },
  });
  await writeFile(
    join(worktreeDir, PROJECT_COMPOSE_FILENAME),
    [
      "services:",
      "  web:",
      "    labels:",
      '      - "caddy_0=alpha.hack"',
      '      - "caddy_1=admin.alpha.hack api.alpha.hack,  docs.alpha.hack"',
      '      - "caddy_0.reverse_proxy={{upstreams 3000}}"',
      `      - 'caddy_2={{ index .Labels "domain" }}'`,
      "",
    ].join("\n")
  );
  const registration = await createProject({
    worktrees: [{ path: worktreeRoot, branch: "wt/feature" }],
  });
  await writeNativeRun({
    projectDir: worktreeDir,
    dir: "native-runs",
    branch: "wt-feature",
  });
  // The registered checkout's .hack is gone; the worktree keeps its own.
  await rm(registration.projectDir, { recursive: true, force: true });
  const payload = await serializedProject({ registration, runtime: [] });
  expect(payload.open_url).toBeNull();
  expect(branchEntries(payload, "native_branch_runtime")).toMatchObject([
    {
      branch: "wt-feature",
      checkout: { root: worktreeRoot, kind: "worktree" },
      hosts: {
        web: [
          "admin.wt-feature.alpha.hack",
          "api.wt-feature.alpha.hack",
          "docs.wt-feature.alpha.hack",
          "wt-feature.alpha.hack",
        ],
      },
      hosts_source: "config",
      url: "https://wt-feature.alpha.hack",
    },
  ]);
});

test("native authored project: instances by their given name, no guessed URL", async () => {
  const registration = await createProject({});
  // An authored project: the native input marker makes legacy inputs unusable.
  await rm(join(registration.projectDir, PROJECT_COMPOSE_FILENAME));
  await rm(join(registration.projectDir, PROJECT_CONFIG_FILENAME));
  await writeFile(join(registration.projectDir, "hack.project.json"), "{}\n");
  await writeNativeRun({
    projectDir: registration.projectDir,
    dir: "native-authored-runs",
    branch: "Feature/Auth",
  });
  await writeNativeRun({
    projectDir: registration.projectDir,
    dir: "native-authored-runs",
    branch: null,
  });
  const payload = await serializedProject({ registration, runtime: [] });
  expect((payload.input_diagnostic as { code: string }).code).toBe(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  expect(payload.open_url).toBeNull();
  expect(branchEntries(payload, "native_branch_runtime")).toEqual([
    {
      branch: "Feature/Auth",
      backend: "native",
      state: "recorded",
      store: "authored",
      branch_name: "Feature/Auth",
      branch_name_source: "recorded",
      checkout: {
        root: registration.repoRoot,
        project_dir: registration.projectDir,
        kind: "primary",
      },
      hosts: {},
      hosts_source: "unavailable",
      url: null,
      url_host: null,
    },
  ]);
});

test("a registered project without its .hack dir reports no URLs", async () => {
  const registration = await createProject({});
  await rm(registration.projectDir, { recursive: true, force: true });
  const payload = await serializedProject({ registration, runtime: [] });
  expect(payload.status).toBe("missing");
  expect(payload.open_url).toBeNull();
  expect(payload.open_url_host).toBeNull();
});

test("branch usage keeps a recorded name unless a new name is given", async () => {
  const registration = await createProject({});
  const projectDir = registration.projectDir;
  await recordBranchUsage({ projectDir, branch: "feat-a", name: "Feat/A" });
  // down/run/exec (and the detached native child) record usage without a name.
  await recordBranchUsage({ projectDir, branch: "feat-a" });
  await recordBranchUsage({ projectDir, branch: "feat-a", name: null });
  expect((await readBranchUsage({ projectDir })).get("feat-a")?.name).toBe(
    "Feat/A"
  );
  // Any name given explicitly replaces it, the bare slug included.
  await recordBranchUsage({ projectDir, branch: "feat-a", name: "feat-a" });
  expect((await readBranchUsage({ projectDir })).get("feat-a")?.name).toBe(
    "feat-a"
  );
});

test(
  "the reported URL matches hack open --branch --json",
  async () => {
    const registration = await createProject({});
    const payload = await serializedProject({
      registration,
      runtime: [
        branchRuntime({
          slug: "feature-x",
          workingDir: registration.projectDir,
        }),
      ],
    });
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "index.ts"),
        "open",
        "--branch",
        "Feature/X",
        "--json",
        "--path",
        registration.repoRoot,
      ],
      {
        cwd: registration.repoRoot,
        env: privateCliEnv({
          root: requireRoot(),
          env: {
            HACK_GLOBAL_CONFIG_PATH: join(requireRoot(), "global.config.json"),
            HACK_HOME: join(requireRoot(), "hack-home"),
            HACK_NO_INTERACTIVE: "1",
            NO_COLOR: "1",
          },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const opened = JSON.parse(stdout) as { readonly url: string };
    expect(branchEntries(payload, "branch_runtime")[0]?.url).toBe(opened.url);
    expect(opened.url).toBe("https://feature-x.alpha.hack.gy");
  },
  { timeout: 60_000 }
);

test("an explicit --branch is its name, except when login autostart replays the slug", async () => {
  const registration = await createProject({});
  const project = {
    projectRoot: registration.repoRoot,
    projectDirName: ".hack",
    projectDir: registration.projectDir,
    composeFile: join(registration.projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: join(registration.projectDir, ".env"),
    configFile: join(registration.projectDir, PROJECT_CONFIG_FILENAME),
  } as Parameters<
    typeof resolveEffectiveBranchIdentityForCommand
  >[0]["project"];
  const previous = process.env.HACK_AUTOSTART_LOGIN;
  try {
    Reflect.deleteProperty(process.env, "HACK_AUTOSTART_LOGIN");
    expect(
      await resolveEffectiveBranchIdentityForCommand({
        project,
        branchOption: " Feature/X ",
      })
    ).toEqual({ branch: "feature-x", name: "Feature/X" });
    process.env.HACK_AUTOSTART_LOGIN = "1";
    expect(
      await resolveEffectiveBranchIdentityForCommand({
        project,
        branchOption: "feature-x",
      })
    ).toEqual({ branch: "feature-x", name: null });
  } finally {
    restoreEnv("HACK_AUTOSTART_LOGIN", previous);
  }
});

test("copies discovers authored start scopes before a ready mapping exists", async () => {
  const { repoRoot, projectDir } = await createProject({});
  await writeNativeRun({
    projectDir,
    dir: "native-authored-runs",
    branch: "first-start",
    suffix: ".start",
  });
  const checkout = { root: repoRoot, projectDir, kind: "primary" as const };
  const opts = { checkout, store: "authored" as const };
  expect(
    await listNativeCopyInstances({ ...opts, includePending: true })
  ).toEqual(["first-start"]);
  expect(await listNativeBranchRecords(opts)).toEqual([]);
});
