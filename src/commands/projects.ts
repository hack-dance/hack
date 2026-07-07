import { resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson, optProject } from "../cli/options.ts";
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts";
import { requestDaemonJson } from "../daemon/client.ts";
import {
  readInternalExtraHostsIp,
  resolveGlobalCaddyIp,
} from "../lib/caddy-hosts.ts";
import { findProjectContext } from "../lib/project.ts";
import { type ProjectMeta, resolveProjectMeta } from "../lib/project-meta.ts";
import {
  findMissingRegistryEntries,
  findOrphanRuntimeProjects,
} from "../lib/project-runtime-hygiene.ts";
import type { ProjectView } from "../lib/project-views.ts";
import {
  buildProjectViews,
  serializeProjectView,
} from "../lib/project-views.ts";
import {
  readProjectsRegistry,
  removeProjectsById,
  touchProjectRegistration,
} from "../lib/projects-registry.ts";
import type {
  RuntimeContainer,
  RuntimeService,
} from "../lib/runtime-projects.ts";
import {
  autoRegisterRuntimeHackProjects,
  countRunningServices,
  readRuntimeProjects,
} from "../lib/runtime-projects.ts";
import { run } from "../lib/shell.ts";
import { display } from "../ui/display.ts";

const optDetails = defineOption({
  name: "details",
  type: "boolean",
  long: "--details",
  description: "Show per-project service tables",
} as const);

const optIncludeGlobal = defineOption({
  name: "includeGlobal",
  type: "boolean",
  long: "--include-global",
  description:
    "Include global infra projects under ~/.hack (e.g. logging stack)",
} as const);

const optAll = defineOption({
  name: "all",
  type: "boolean",
  long: "--all",
  description: "Include unregistered docker compose projects (best-effort)",
} as const);

const optMeta = defineOption({
  name: "meta",
  type: "boolean",
  long: "--meta",
  description: "Include git/worktree/session/env metadata (implies --details)",
} as const);

const options = [
  optProject,
  optDetails,
  optMeta,
  optIncludeGlobal,
  optAll,
  optJson,
] as const;
const positionals = [] as const;

const statusOptions = [
  optProject,
  optIncludeGlobal,
  optAll,
  optMeta,
  optJson,
] as const;

const statusSpec = defineCommand({
  name: "status",
  summary: "Show project status (shortcut for `hack projects --details`)",
  group: "Global",
  options: statusOptions,
  positionals,
  subcommands: [],
  expandInRootHelp: true,
} as const);

const pruneOptions = [optIncludeGlobal] as const;
const pruneSpec = defineCommand({
  name: "prune",
  summary: "Remove missing registry entries and stop orphaned containers",
  group: "Global",
  options: pruneOptions,
  positionals,
  subcommands: [],
} as const);

const spec = defineCommand({
  name: "projects",
  summary: "Show all projects (registry + running docker compose)",
  group: "Global",
  options,
  positionals,
  subcommands: [pruneSpec],
  expandInRootHelp: true,
} as const);

const handleProjects: CommandHandlerFor<typeof spec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const filter =
    typeof args.options.project === "string"
      ? sanitizeName(args.options.project)
      : null;
  await touchCwdProjectRegistration({ cwd: ctx.cwd });
  return await runProjects({
    filter,
    includeGlobal: args.options.includeGlobal === true,
    includeUnregistered: args.options.all === true,
    details: args.options.details === true || args.options.meta === true,
    meta: args.options.meta === true,
    json: args.options.json === true,
  });
};

/**
 * Lightweight registry touch for the current checkout: keeps `lastSeenAt`
 * fresh and records linked-worktree checkouts on the family registration
 * even when no full registration command runs.
 */
async function touchCwdProjectRegistration(opts: {
  readonly cwd: string;
}): Promise<void> {
  const project = await findProjectContext(opts.cwd);
  if (!project) {
    return;
  }
  await touchProjectRegistration({ project });
}

const handlePrune: CommandHandlerFor<typeof pruneSpec> = async ({
  args,
}): Promise<number> => {
  const includeGlobal = args.options.includeGlobal === true;
  const registry = await readProjectsRegistry();
  const missing = await findMissingRegistryEntries({
    projects: registry.projects,
  });
  const runtimeResult = await readRuntimeProjects({ includeGlobal });
  if (!runtimeResult.ok) {
    await display.panel({
      title: "Runtime unavailable",
      tone: "error",
      lines: [runtimeResult.error ?? "Docker runtime is not responding."],
    });
    return 1;
  }
  const orphaned = await findOrphanRuntimeProjects({
    runtime: runtimeResult.runtime,
  });
  const orphanedContainerCount = orphaned.reduce(
    (sum, entry) => sum + entry.containerIds.length,
    0
  );

  if (missing.length === 0 && orphaned.length === 0) {
    await display.panel({
      title: "Prune",
      tone: "info",
      lines: ["No missing registry entries or orphaned containers found."],
    });
    return 0;
  }

  await display.section("Prune candidates");

  if (missing.length > 0) {
    await display.section("Registry entries");
    await display.table({
      columns: ["Project", "Project Dir", "Reason"],
      rows: missing.map((entry) => [
        entry.project.name,
        entry.project.projectDir,
        entry.reason,
      ]),
    });
  }

  if (orphaned.length > 0) {
    await display.section("Orphaned containers");
    await display.table({
      columns: ["Compose Project", "Working Dir", "Reason", "Containers"],
      rows: orphaned.map((entry) => [
        entry.project,
        entry.workingDir ?? "",
        entry.reason,
        entry.containerIds.length,
      ]),
    });
  }

  const ok = await confirm({
    message: `Remove ${missing.length} registry entr${missing.length === 1 ? "y" : "ies"} and stop ${orphanedContainerCount} container${orphanedContainerCount === 1 ? "" : "s"} from ${orphaned.length} orphaned project${orphaned.length === 1 ? "" : "s"}?`,
    initialValue: false,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return 0;
  }

  if (missing.length > 0) {
    await removeProjectsById({
      ids: missing.map((entry) => entry.project.id),
    });
  }

  if (orphaned.length > 0) {
    const ids = orphaned.flatMap((entry) => entry.containerIds);
    await removeContainerIds(ids);
  }

  await display.panel({
    title: "Prune complete",
    tone: "success",
    lines: [
      `Registry entries removed: ${missing.length}`,
      `Orphaned containers removed: ${orphanedContainerCount}`,
    ],
  });
  return 0;
};

export const projectsCommand = withHandler(
  {
    ...spec,
    subcommands: [withHandler(pruneSpec, handlePrune)],
  },
  handleProjects
);

const handleStatus: CommandHandlerFor<typeof statusSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const filter =
    typeof args.options.project === "string"
      ? sanitizeName(args.options.project)
      : null;
  await touchCwdProjectRegistration({ cwd: ctx.cwd });
  return await runProjects({
    filter,
    includeGlobal: args.options.includeGlobal === true,
    includeUnregistered: args.options.all === true,
    details: true,
    meta: args.options.meta === true,
    json: args.options.json === true,
  });
};

export const statusCommand = withHandler(statusSpec, handleStatus);

async function runProjects(opts: {
  readonly filter: string | null;
  readonly includeGlobal: boolean;
  readonly includeUnregistered: boolean;
  readonly details: boolean;
  readonly meta: boolean;
  readonly json: boolean;
}): Promise<number> {
  const daemonRuntimeMeta = opts.json
    ? null
    : await readDaemonRuntimeRecoveryMeta();

  if (opts.json) {
    const daemon = await requestDaemonJson({
      path: "/v1/projects",
      query: {
        filter: opts.filter ?? null,
        include_global: opts.includeGlobal,
        include_unregistered: opts.includeUnregistered,
        include_meta: opts.meta,
      },
    });
    if (daemon?.ok && daemon.json) {
      process.stdout.write(`${JSON.stringify(daemon.json, null, 2)}\n`);
      return 0;
    }
  }

  const runtime = await readRuntimeProjects({
    includeGlobal: opts.includeGlobal,
  });

  if (runtime.ok) {
    await autoRegisterRuntimeHackProjects({ runtime: runtime.runtime });
  }
  const registry = await readProjectsRegistry();

  const views = await buildProjectViews({
    registryProjects: registry.projects,
    runtime: runtime.runtime,
    runtimeOk: runtime.ok,
    filter: opts.filter,
    includeUnregistered: opts.includeUnregistered,
  });
  const metaByName = opts.meta
    ? await buildMetaByProjectName({ views })
    : new Map<string, ProjectMeta>();
  if (opts.json) {
    outputProjectsJson({
      filter: opts.filter,
      includeGlobal: opts.includeGlobal,
      includeUnregistered: opts.includeUnregistered,
      includeMeta: opts.meta,
      runtime,
      views,
      metaByName,
    });
    return 0;
  }

  await renderRuntimeNotices({
    runtime,
    daemonRuntimeMeta,
  });

  if (views.length === 0) {
    await display.panel({
      title: "Projects",
      tone: "warn",
      lines: [
        opts.filter
          ? `No projects matched: ${opts.filter}`
          : "No projects found.",
      ],
    });
    return 0;
  }

  await display.section("Projects");
  await display.table({
    columns: ["Name", "Status", "Services", "Dev Host", "Repo Root"],
    rows: views.map((p) => {
      const definedCount = p.definedServices ? p.definedServices.length : null;
      const runningCount = runtime.ok ? countRunningServices(p.runtime) : null;
      const servicesCell = formatServicesCell({
        definedCount,
        runningCount,
        runtimeOk: runtime.ok,
      });
      return [
        p.name,
        p.status,
        servicesCell,
        p.devHost ?? "",
        p.repoRoot ?? "",
      ];
    }),
  });

  if (opts.details) {
    const caddyIp = await resolveGlobalCaddyIp();
    for (const p of views) {
      await renderProjectDetails({
        project: p,
        caddyIp,
        runtimeOk: runtime.ok,
        meta: opts.meta ? (metaByName.get(p.name) ?? null) : null,
      });
    }
  }

  return 0;
}

type RuntimeRecoveryMeta = {
  readonly resetCount: number;
  readonly lastResetSummary: string | null;
  readonly lastRepairAction: string | null;
  readonly lastRepairOutcome: "stabilized" | "manual_action_required" | null;
  readonly nextStep: string | null;
};

type RuntimeRecoveryNotice = {
  readonly title: string;
  readonly tone: "info" | "warn";
  readonly lines: readonly string[];
};

function outputProjectsJson(opts: {
  readonly filter: string | null;
  readonly includeGlobal: boolean;
  readonly includeUnregistered: boolean;
  readonly includeMeta: boolean;
  readonly runtime: Awaited<ReturnType<typeof readRuntimeProjects>>;
  readonly views: readonly ProjectView[];
  readonly metaByName: ReadonlyMap<string, ProjectMeta>;
}): void {
  const runtimeMeta = formatRuntimeMeta({ runtime: opts.runtime });
  const payload = {
    generated_at: new Date().toISOString(),
    filter: opts.filter,
    include_global: opts.includeGlobal,
    include_unregistered: opts.includeUnregistered,
    include_meta: opts.includeMeta,
    runtime_ok: runtimeMeta.ok,
    runtime_error: runtimeMeta.error,
    runtime_checked_at: runtimeMeta.checkedAt,
    runtime_last_ok_at: runtimeMeta.lastOkAt,
    runtime_reset_at: runtimeMeta.lastResetAt,
    runtime_reset_count: runtimeMeta.resetCount,
    runtime_reset_summary: runtimeMeta.lastResetSummary,
    runtime_reset_changes: runtimeMeta.lastResetChanges,
    runtime_last_repair_at: runtimeMeta.lastRepairAt,
    runtime_repair_action: runtimeMeta.lastRepairAction,
    runtime_repair_outcome: runtimeMeta.lastRepairOutcome,
    runtime_next_step: runtimeMeta.nextStep,
    projects: opts.views.map((view) => ({
      ...serializeProjectView(view),
      ...(opts.includeMeta
        ? { meta: opts.metaByName.get(view.name) ?? null }
        : {}),
    })),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function renderRuntimeNotices(opts: {
  readonly runtime: Awaited<ReturnType<typeof readRuntimeProjects>>;
  readonly daemonRuntimeMeta: RuntimeRecoveryMeta | null;
}): Promise<void> {
  if (!opts.runtime.ok) {
    await display.panel({
      title: "Runtime unavailable",
      tone: "warn",
      lines: [opts.runtime.error ?? "Docker runtime is not responding."],
    });
  }

  const runtimeRecoveryNotice = buildRuntimeRecoveryNotice({
    runtimeMeta: opts.daemonRuntimeMeta,
  });
  if (!runtimeRecoveryNotice) {
    return;
  }

  await display.panel(runtimeRecoveryNotice);
}

async function renderProjectDetails(opts: {
  readonly project: ProjectView;
  readonly caddyIp: string | null;
  readonly runtimeOk: boolean;
  readonly meta: ProjectMeta | null;
}): Promise<void> {
  const p = opts.project;
  await display.section(p.name);

  const meta: Array<readonly [string, string]> = [];
  meta.push(["Status", p.status]);
  if (p.projectId) {
    meta.push(["Project id", p.projectId]);
  }
  if (p.devHost) {
    meta.push(["Dev host", p.devHost]);
  }
  if (p.repoRoot) {
    meta.push(["Repo root", p.repoRoot]);
  }
  if (p.projectDir) {
    meta.push(["Project dir", p.projectDir]);
  }
  if (p.ownership) {
    meta.push([
      "Ownership",
      `${p.ownership.mode}:${p.ownership.ownerType}${
        p.ownership.ownerId ? `:${p.ownership.ownerId}` : ""
      }`,
    ]);
    meta.push(["Managed by", p.ownership.managedBy]);
  }
  const mappedIp = await readInternalExtraHostsIp({ projectDir: p.projectDir });
  const caddySummary = formatCaddySummary({ caddyIp: opts.caddyIp, mappedIp });
  if (caddySummary) {
    meta.push(["Caddy IP", caddySummary]);
  }
  if (p.worktrees && p.worktrees.length > 0) {
    meta.push([
      "Worktrees",
      p.worktrees
        .map((w) => `${w.path}${w.branch ? ` (${w.branch})` : ""}`)
        .join(", "),
    ]);
  }
  await display.kv({ entries: meta });

  const defined = new Set(p.definedServices ?? []);
  const runtimeServices = opts.runtimeOk
    ? (p.runtime?.services ?? new Map<string, RuntimeService>())
    : new Map();
  const all = new Set<string>([...defined, ...runtimeServices.keys()]);
  const names = [...all].sort((a, b) => a.localeCompare(b));

  const rows = names.map((svc) => {
    const runtime = runtimeServices.get(svc) ?? null;
    const containers = runtime?.containers ?? [];
    const running = containers.filter(
      (c: RuntimeContainer) => c.state === "running"
    ).length;
    const total = containers.length;
    const state = opts.runtimeOk
      ? summarizeServiceState({ running, total })
      : "unknown";
    const definedCell = defined.has(svc) ? "yes" : "";
    const statusCell = opts.runtimeOk
      ? (containers[0]?.status ?? state)
      : "runtime unavailable";
    const runningCell = opts.runtimeOk ? `${running}/${total}` : "—";
    return [svc, definedCell, runningCell, state, statusCell] as const;
  });

  await display.table({
    columns: ["Service", "Defined", "Running", "State", "Status"],
    rows,
  });

  if (p.lifecycle) {
    await renderProjectLifecycle({ lifecycle: p.lifecycle });
  }

  if (opts.meta && p.kind === "registered") {
    await renderProjectMeta({ meta: opts.meta });
  }

  if (opts.runtimeOk && p.branchRuntime.length > 0) {
    const branchRows = p.branchRuntime
      .slice()
      .sort((a, b) => a.branch.localeCompare(b.branch))
      .map((entry) => {
        const running = countRunningServices(entry.runtime);
        const total = entry.runtime.services.size;
        const state = summarizeServiceState({ running, total });
        return [
          entry.branch,
          state,
          `${running}/${total}`,
          entry.runtime.workingDir ?? "",
        ] as const;
      });

    await display.section("Branch instances");
    await display.table({
      columns: ["Branch", "State", "Services", "Working Dir"],
      rows: branchRows,
    });
  }
}

async function renderProjectLifecycle(opts: {
  readonly lifecycle: NonNullable<ProjectView["lifecycle"]>;
}): Promise<void> {
  const hooks = [
    ...opts.lifecycle.upBefore,
    ...opts.lifecycle.upAfter,
    ...opts.lifecycle.downBefore,
    ...opts.lifecycle.downAfter,
  ];
  const persistentHookCount = hooks.filter(
    (entry) => entry.persistent === true
  ).length;
  const summary: Array<readonly [string, string]> = [
    [
      "Startup hooks",
      String(opts.lifecycle.upBefore.length + opts.lifecycle.upAfter.length),
    ],
    [
      "Shutdown hooks",
      String(
        opts.lifecycle.downBefore.length + opts.lifecycle.downAfter.length
      ),
    ],
    ["Persistent hooks", String(persistentHookCount)],
    ["Persistent processes", String(opts.lifecycle.processes.length)],
  ];

  await display.section("Startup & lifecycle");
  await display.kv({ entries: summary });

  if (hooks.length > 0) {
    const hookRows = [
      ...opts.lifecycle.upBefore.map((entry) => ({
        phase: "up.before",
        ...entry,
      })),
      ...opts.lifecycle.upAfter.map((entry) => ({
        phase: "up.after",
        ...entry,
      })),
      ...opts.lifecycle.downBefore.map((entry) => ({
        phase: "down.before",
        ...entry,
      })),
      ...opts.lifecycle.downAfter.map((entry) => ({
        phase: "down.after",
        ...entry,
      })),
    ];

    await display.table({
      columns: ["Phase", "Persistent", "Service", "Name", "Cwd", "Command"],
      rows: hookRows.map((entry) => [
        entry.phase,
        entry.persistent === true ? "yes" : "",
        entry.service,
        entry.name ?? "",
        entry.cwd ?? "",
        entry.command,
      ]),
    });
  }

  if (opts.lifecycle.processes.length > 0) {
    await display.table({
      columns: ["Process", "Service", "Cwd", "Command"],
      rows: opts.lifecycle.processes.map((entry) => [
        entry.name,
        entry.service,
        entry.cwd ?? "",
        entry.command,
      ]),
    });
  }
}

async function buildMetaByProjectName(opts: {
  readonly views: readonly ProjectView[];
}): Promise<Map<string, ProjectMeta>> {
  const out = new Map<string, ProjectMeta>();
  const tasks = opts.views
    .filter((p) => p.kind === "registered" && p.repoRoot && p.projectDir)
    .map(async (p) => {
      if (!(p.repoRoot && p.projectDir)) {
        return;
      }
      const meta = await resolveProjectMeta({
        projectName: p.name,
        repoRoot: p.repoRoot,
        projectDir: p.projectDir,
        composeFile: resolve(p.projectDir, PROJECT_COMPOSE_FILENAME),
      });
      out.set(p.name, meta);
    });

  await Promise.all(tasks);
  return out;
}

async function renderProjectMeta(opts: {
  readonly meta: ProjectMeta;
}): Promise<void> {
  await display.section("Meta");

  const ownershipEntries: Array<readonly [string, string]> = opts.meta.ownership
    ? [
        ["Ownership mode", opts.meta.ownership.mode],
        ["Owner type", opts.meta.ownership.ownerType],
        ["Owner id", opts.meta.ownership.ownerId ?? ""],
        ["Managed by", opts.meta.ownership.managedBy],
      ]
    : [["Ownership", "unavailable"]];
  if (opts.meta.configError) {
    ownershipEntries.push(["Config error", opts.meta.configError]);
  }

  await display.kv({
    entries: ownershipEntries,
  });
  await renderGitMeta({ git: opts.meta.git });
  await renderGitWorktrees({ worktrees: opts.meta.git.worktrees });
  await renderSessionsMeta({ sessions: opts.meta.sessions.sessions });
  await renderEnvMeta({ env: opts.meta.env });
  await renderHackBranchesMeta({ branches: opts.meta.hackBranches.branches });
  await renderComposeBuildMeta({ services: opts.meta.composeBuild.services });
}

function formatYesNoUnknown(value: boolean | null): string {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "";
}

async function renderGitMeta(opts: {
  readonly git: ProjectMeta["git"];
}): Promise<void> {
  const git = opts.git;
  const entries: Array<readonly [string, string]> = [
    ["Git repo", git.isRepo ? "yes" : "no"],
  ];

  if (!git.isRepo) {
    if (git.error) {
      entries.push(["Git error", git.error]);
    }
    await display.kv({ entries });
    return;
  }

  if (git.branch) {
    entries.push(["Branch", git.branch]);
  }
  if (git.head) {
    entries.push(["HEAD", git.head.slice(0, 12)]);
  }
  if (git.dirty !== null) {
    entries.push(["Dirty", formatYesNoUnknown(git.dirty)]);
  }
  if (git.localBranchCount !== null) {
    entries.push(["Local branches", String(git.localBranchCount)]);
  }
  if (git.worktrees) {
    entries.push(["Worktrees", String(git.worktrees.length)]);
  }
  if (git.error) {
    entries.push(["Git error", git.error]);
  }

  await display.kv({ entries });
}

async function renderGitWorktrees(opts: {
  readonly worktrees: ProjectMeta["git"]["worktrees"];
}): Promise<void> {
  const worktrees = opts.worktrees ?? [];
  if (worktrees.length === 0) {
    return;
  }

  await display.section("Git worktrees");
  await display.table({
    columns: ["Path", "Branch", "Detached"],
    rows: worktrees.map((w) => [
      w.path,
      w.branch ?? "",
      w.detached ? "yes" : "",
    ]),
  });
}

async function renderSessionsMeta(opts: {
  readonly sessions: ProjectMeta["sessions"]["sessions"];
}): Promise<void> {
  const sessions = opts.sessions ?? [];
  if (sessions.length === 0) {
    return;
  }

  await display.section("Sessions");
  await display.table({
    columns: ["Name", "Backend", "Attached"],
    rows: sessions.map((s) => [
      s.name,
      s.backend,
      formatYesNoUnknown(s.attached),
    ]),
  });
}

async function renderEnvMeta(opts: {
  readonly env: ProjectMeta["env"];
}): Promise<void> {
  if (opts.env.vars.length === 0) {
    return;
  }

  await display.section("Env");
  const missing = opts.env.missingRequired;
  await display.kv({
    entries: [
      ["Contract", opts.env.contractExists ? "yes" : "no"],
      ["Missing required", missing.length > 0 ? missing.join(", ") : ""],
    ],
  });
}

async function renderHackBranchesMeta(opts: {
  readonly branches: ProjectMeta["hackBranches"]["branches"];
}): Promise<void> {
  if (opts.branches.length === 0) {
    return;
  }

  await display.section("Hack branches");
  await display.table({
    columns: ["Slug", "Name", "Note", "Last used"],
    rows: opts.branches.map((b) => [
      b.slug,
      b.name,
      b.note ?? "",
      b.last_used_at ?? "",
    ]),
  });
}

async function renderComposeBuildMeta(opts: {
  readonly services: ProjectMeta["composeBuild"]["services"];
}): Promise<void> {
  if (opts.services.length === 0) {
    return;
  }

  await display.section("Service build");
  await display.table({
    columns: ["Service", "Build", "Context", "Dockerfile", "Exists"],
    rows: opts.services.map((s) => [
      s.service,
      s.build ? "yes" : "no",
      s.context ?? "",
      s.dockerfile ?? "",
      formatYesNoUnknown(s.dockerfileExists),
    ]),
  });
}

function formatCaddySummary(opts: {
  readonly caddyIp: string | null;
  readonly mappedIp: string | null;
}): string | null {
  if (!opts.caddyIp) {
    return null;
  }
  if (!opts.mappedIp) {
    return `${opts.caddyIp} (hosts missing)`;
  }
  if (opts.caddyIp !== opts.mappedIp) {
    return `${opts.caddyIp} (hosts ${opts.mappedIp}, restart)`;
  }
  return `${opts.caddyIp} (hosts ok)`;
}

function summarizeServiceState(opts: {
  readonly running: number;
  readonly total: number;
}): string {
  if (opts.total === 0) {
    return "not running";
  }
  if (opts.running === opts.total) {
    return "running";
  }
  if (opts.running === 0) {
    return "stopped";
  }
  return "mixed";
}

async function readDaemonRuntimeRecoveryMeta(): Promise<RuntimeRecoveryMeta | null> {
  const metrics = await requestDaemonJson({
    path: "/v1/metrics",
    autoStart: false,
  });
  if (!(metrics?.ok && metrics.json)) {
    return null;
  }
  return parseDaemonRuntimeRecoveryMeta({ json: metrics.json });
}

function parseDaemonRuntimeRecoveryMeta(opts: {
  readonly json: Record<string, unknown>;
}): RuntimeRecoveryMeta | null {
  const resetCount = readNumberField({
    json: opts.json,
    key: "runtime_reset_count",
  });
  const lastResetSummary = readStringField({
    json: opts.json,
    key: "runtime_reset_summary",
  });
  const lastRepairAction = readStringField({
    json: opts.json,
    key: "runtime_repair_action",
  });
  const lastRepairOutcome = readRepairOutcomeField({
    json: opts.json,
    key: "runtime_repair_outcome",
  });
  const nextStep = readStringField({
    json: opts.json,
    key: "runtime_next_step",
  });

  if (
    resetCount === 0 &&
    lastResetSummary === null &&
    lastRepairAction === null &&
    lastRepairOutcome === null &&
    nextStep === null
  ) {
    return null;
  }

  return {
    resetCount,
    lastResetSummary,
    lastRepairAction,
    lastRepairOutcome,
    nextStep,
  };
}

function buildRuntimeRecoveryNotice(opts: {
  readonly runtimeMeta: RuntimeRecoveryMeta | null;
}): RuntimeRecoveryNotice | null {
  if (!opts.runtimeMeta) {
    return null;
  }

  const lines: string[] = [];
  if (opts.runtimeMeta.lastResetSummary) {
    const count =
      opts.runtimeMeta.resetCount > 0
        ? `#${opts.runtimeMeta.resetCount}`
        : "detected";
    lines.push(`Detected reset ${count}: ${opts.runtimeMeta.lastResetSummary}`);
  }
  if (opts.runtimeMeta.lastRepairAction && opts.runtimeMeta.lastRepairOutcome) {
    lines.push(
      `hackd repair: ${opts.runtimeMeta.lastRepairAction} -> ${opts.runtimeMeta.lastRepairOutcome}`
    );
  }
  if (opts.runtimeMeta.nextStep) {
    lines.push(`Next step: ${opts.runtimeMeta.nextStep}`);
  }
  if (lines.length === 0) {
    return null;
  }

  return {
    title: "Runtime reset detected",
    tone:
      opts.runtimeMeta.lastRepairOutcome === "manual_action_required"
        ? "warn"
        : "info",
    lines,
  };
}

function formatRuntimeMeta(opts: {
  readonly runtime: Awaited<ReturnType<typeof readRuntimeProjects>>;
}): {
  readonly ok: boolean;
  readonly error: string | null;
  readonly checkedAt: string | null;
  readonly lastOkAt: string | null;
  readonly lastResetAt: string | null;
  readonly resetCount: number;
  readonly lastResetSummary: string | null;
  readonly lastResetChanges: readonly string[];
  readonly lastRepairAt: string | null;
  readonly lastRepairAction: string | null;
  readonly lastRepairOutcome: "stabilized" | "manual_action_required" | null;
  readonly nextStep: string | null;
} {
  const checkedAt = new Date(opts.runtime.checkedAtMs).toISOString();
  return {
    ok: opts.runtime.ok,
    error: opts.runtime.error,
    checkedAt,
    lastOkAt: opts.runtime.ok ? checkedAt : null,
    lastResetAt: null,
    resetCount: 0,
    lastResetSummary: null,
    lastResetChanges: [],
    lastRepairAt: null,
    lastRepairAction: null,
    lastRepairOutcome: null,
    nextStep: null,
  };
}

function sanitizeName(value: string): string {
  return value.trim().toLowerCase();
}

function readNumberField(opts: {
  readonly json: Record<string, unknown>;
  readonly key: string;
}): number {
  const value = opts.json[opts.key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringField(opts: {
  readonly json: Record<string, unknown>;
  readonly key: string;
}): string | null {
  const value = opts.json[opts.key];
  if (typeof value !== "string") {
    return null;
  }
  return value.length > 0 ? value : null;
}

function readRepairOutcomeField(opts: {
  readonly json: Record<string, unknown>;
  readonly key: string;
}): "stabilized" | "manual_action_required" | null {
  const value = opts.json[opts.key];
  return value === "stabilized" || value === "manual_action_required"
    ? value
    : null;
}

export const __testOnlyProjectsCommand = {
  buildRuntimeRecoveryNotice,
  parseDaemonRuntimeRecoveryMeta,
};

async function removeContainerIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const unique = [...new Set(ids)];
  const chunks = chunkArray(unique, 50);
  for (const chunk of chunks) {
    const code = await run(["docker", "rm", "-f", ...chunk], {
      stdin: "ignore",
    });
    if (code !== 0) {
      break;
    }
  }
}

function formatServicesCell(opts: {
  readonly definedCount: number | null;
  readonly runningCount: number | null;
  readonly runtimeOk: boolean;
}): string {
  if (opts.definedCount === null) {
    if (opts.runtimeOk && opts.runningCount !== null) {
      return `${opts.runningCount}/—`;
    }
    return "—/—";
  }
  if (opts.runtimeOk && opts.runningCount !== null) {
    return `${opts.runningCount}/${opts.definedCount}`;
  }
  return `—/${opts.definedCount}`;
}

function chunkArray<T>(input: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return [Array.from(input)];
  }
  const out: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size));
  }
  return out;
}
