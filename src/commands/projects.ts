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
import { pathExists } from "../lib/fs.ts";
import type { ProjectView } from "../lib/project-views.ts";
import {
  buildProjectViews,
  serializeProjectView,
} from "../lib/project-views.ts";
import type { RegisteredProject } from "../lib/projects-registry.ts";
import {
  readProjectsRegistry,
  removeProjectsById,
} from "../lib/projects-registry.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
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

const options = [
  optProject,
  optDetails,
  optIncludeGlobal,
  optAll,
  optJson,
] as const;
const positionals = [] as const;

const statusOptions = [optProject, optIncludeGlobal, optAll, optJson] as const;

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
  args,
}): Promise<number> => {
  const filter =
    typeof args.options.project === "string"
      ? sanitizeName(args.options.project)
      : null;
  return await runProjects({
    filter,
    includeGlobal: args.options.includeGlobal === true,
    includeUnregistered: args.options.all === true,
    details: args.options.details === true,
    json: args.options.json === true,
  });
};

const handlePrune: CommandHandlerFor<typeof pruneSpec> = async ({
  args,
}): Promise<number> => {
  const includeGlobal = args.options.includeGlobal === true;
  const registry = await readProjectsRegistry();
  const missing = await findMissingRegistryEntries(registry.projects);
  const runtimeResult = await readRuntimeProjects({ includeGlobal });
  if (!runtimeResult.ok) {
    await display.panel({
      title: "Runtime unavailable",
      tone: "error",
      lines: [runtimeResult.error ?? "Docker runtime is not responding."],
    });
    return 1;
  }
  const orphaned = await findOrphanRuntimeProjects(runtimeResult.runtime);
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
  args,
}): Promise<number> => {
  const filter =
    typeof args.options.project === "string"
      ? sanitizeName(args.options.project)
      : null;
  return await runProjects({
    filter,
    includeGlobal: args.options.includeGlobal === true,
    includeUnregistered: args.options.all === true,
    details: true,
    json: args.options.json === true,
  });
};

export const statusCommand = withHandler(statusSpec, handleStatus);

async function runProjects(opts: {
  readonly filter: string | null;
  readonly includeGlobal: boolean;
  readonly includeUnregistered: boolean;
  readonly details: boolean;
  readonly json: boolean;
}): Promise<number> {
  if (opts.json) {
    const daemon = await requestDaemonJson({
      path: "/v1/projects",
      query: {
        filter: opts.filter ?? null,
        include_global: opts.includeGlobal,
        include_unregistered: opts.includeUnregistered,
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
  if (opts.json) {
    const runtimeMeta = formatRuntimeMeta({ runtime });
    const payload = {
      generated_at: new Date().toISOString(),
      filter: opts.filter,
      include_global: opts.includeGlobal,
      include_unregistered: opts.includeUnregistered,
      runtime_ok: runtimeMeta.ok,
      runtime_error: runtimeMeta.error,
      runtime_checked_at: runtimeMeta.checkedAt,
      runtime_last_ok_at: runtimeMeta.lastOkAt,
      runtime_reset_at: runtimeMeta.lastResetAt,
      runtime_reset_count: runtimeMeta.resetCount,
      projects: views.map(serializeProjectView),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (!runtime.ok) {
    await display.panel({
      title: "Runtime unavailable",
      tone: "warn",
      lines: [runtime.error ?? "Docker runtime is not responding."],
    });
  }

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
      });
    }
  }

  return 0;
}

async function renderProjectDetails(opts: {
  readonly project: ProjectView;
  readonly caddyIp: string | null;
  readonly runtimeOk: boolean;
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
  const mappedIp = await readInternalExtraHostsIp({ projectDir: p.projectDir });
  const caddySummary = formatCaddySummary({ caddyIp: opts.caddyIp, mappedIp });
  if (caddySummary) {
    meta.push(["Caddy IP", caddySummary]);
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

function formatRuntimeMeta(opts: {
  readonly runtime: Awaited<ReturnType<typeof readRuntimeProjects>>;
}): {
  readonly ok: boolean;
  readonly error: string | null;
  readonly checkedAt: string | null;
  readonly lastOkAt: string | null;
  readonly lastResetAt: string | null;
  readonly resetCount: number;
} {
  const checkedAt = new Date(opts.runtime.checkedAtMs).toISOString();
  return {
    ok: opts.runtime.ok,
    error: opts.runtime.error,
    checkedAt,
    lastOkAt: opts.runtime.ok ? checkedAt : null,
    lastResetAt: null,
    resetCount: 0,
  };
}

function sanitizeName(value: string): string {
  return value.trim().toLowerCase();
}

type MissingRegistryEntry = {
  readonly project: RegisteredProject;
  readonly reason: string;
};

type OrphanedRuntimeProject = {
  readonly project: string;
  readonly workingDir: string | null;
  readonly reason: string;
  readonly containerIds: readonly string[];
};

async function findMissingRegistryEntries(
  projects: readonly RegisteredProject[]
): Promise<MissingRegistryEntry[]> {
  const out: MissingRegistryEntry[] = [];
  for (const project of projects) {
    if (!(await pathExists(project.projectDir))) {
      out.push({ project, reason: "missing project dir" });
      continue;
    }
    const composeFile = resolve(project.projectDir, PROJECT_COMPOSE_FILENAME);
    if (!(await pathExists(composeFile))) {
      out.push({ project, reason: "missing compose file" });
    }
  }
  return out;
}

async function findOrphanRuntimeProjects(
  runtime: readonly RuntimeProject[]
): Promise<OrphanedRuntimeProject[]> {
  const out: OrphanedRuntimeProject[] = [];
  for (const project of runtime) {
    const workingDir = project.workingDir;
    if (!workingDir) {
      continue;
    }
    if (!(await pathExists(workingDir))) {
      out.push({
        project: project.project,
        workingDir,
        reason: "missing working dir",
        containerIds: collectContainerIds(project),
      });
      continue;
    }
    const composeFile = resolve(workingDir, PROJECT_COMPOSE_FILENAME);
    if (!(await pathExists(composeFile))) {
      out.push({
        project: project.project,
        workingDir,
        reason: "missing compose file",
        containerIds: collectContainerIds(project),
      });
    }
  }
  return out;
}

function collectContainerIds(project: RuntimeProject): readonly string[] {
  const out: string[] = [];
  for (const service of project.services.values()) {
    for (const container of service.containers) {
      if (container.id.length > 0) {
        out.push(container.id);
      }
    }
  }
  return out;
}

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
