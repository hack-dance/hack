import { resolve } from "node:path";
import { defineCommand, withHandler } from "../cli/command.ts";
import { optJson, optProject } from "../cli/options.ts";
import {
  type ObservedProcess,
  observeHostCommand,
  readHostCommandRecords,
  readObservedProcesses,
} from "../lib/host-command-observation.ts";
import {
  type LifecycleStateEntry,
  readLifecycleState,
} from "../lib/lifecycle-runtime.ts";
import { resolvePersistedLifecycleProcessGroupIds } from "../lib/project-lifecycle-processes.ts";
import { inspectLifecycleSession } from "../lib/project-lifecycle-sessions.ts";
import {
  type ProjectsRegistry,
  readProjectsRegistry,
} from "../lib/projects-registry.ts";
import { getMuxBackends } from "../mux/mux-resolver.ts";
import { display } from "../ui/display.ts";

const spec = defineCommand({
  name: "ps",
  summary:
    "Inspect host command lifetimes, CPU and lifecycle ownership (read-only)",
  group: "Integrations",
  options: [optProject, optJson],
  positionals: [],
  subcommands: [],
} as const);

export const hostPsCommand = withHandler(spec, async ({ args }) => {
  const [records, snapshot, registry] = await Promise.all([
    readHostCommandRecords(),
    readObservedProcesses(),
    readProjectsRegistry(),
  ]);
  const filter = args.options.project;
  const commands = records
    .filter((record) => !filter || record.project === filter)
    .map((record) => observeHostCommand(record, snapshot));
  const lifecycle = await readLifecycleObservations({
    registry,
    filter,
    snapshot,
  });
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ generatedAt: new Date().toISOString(), snapshotAvailable: snapshot !== null, commands, lifecycle }, null, 2)}\n`
    );
    return 0;
  }
  await display.table({
    columns: [
      "Project",
      "Executable",
      "PID",
      "Lifetime",
      "State",
      "Elapsed (s)",
      "CPU (s)",
      "PGID",
    ],
    rows: commands.map((row) => [
      row.project,
      row.executable,
      row.child.pid,
      row.lifetime,
      row.status,
      (row.elapsedMs / 1000).toFixed(1),
      formatCpuSeconds(row.liveCpuTimeMs ?? row.cpuTimeMs),
      row.processGroupId ?? "shared",
    ]),
  });
  if (lifecycle.length) {
    await display.table({
      columns: ["Project", "Session", "Lifetime", "Ownership"],
      rows: lifecycle.map((row) => [
        String(row.project),
        String(row.session),
        "persistent",
        String(row.ownership),
      ]),
    });
  }
  return 0;
});

async function readLifecycleObservations({
  registry,
  filter,
  snapshot,
}: {
  readonly registry: ProjectsRegistry;
  readonly filter: string | undefined;
  readonly snapshot: readonly ObservedProcess[] | null;
}): Promise<Record<string, unknown>[]> {
  const lifecycle: Record<string, unknown>[] = [];
  const directories = new Map<string, string>();
  for (const project of registry.projects.filter(
    (project) => !filter || project.name === filter
  )) {
    directories.set(project.projectDir, project.repoRoot);
    for (const worktree of project.worktrees ?? []) {
      directories.set(
        resolve(worktree.path, project.projectDirName),
        worktree.path
      );
    }
  }
  for (const [projectDir, projectRoot] of directories) {
    for (const entry of await readLifecycleState({ projectDir })) {
      lifecycle.push(
        await observeLifecycleEntry({ entry, projectRoot, snapshot })
      );
    }
  }
  return lifecycle;
}
async function observeLifecycleEntry({
  entry,
  projectRoot,
  snapshot,
}: {
  readonly entry: LifecycleStateEntry;
  readonly projectRoot: string;
  readonly snapshot: readonly ObservedProcess[] | null;
}): Promise<Record<string, unknown>> {
  const backends = getMuxBackends();
  const backend = backends.get(entry.backend);
  const inspection = backend
    ? await inspectLifecycleSession({
        backend,
        entry,
        expectedSessionName: entry.sessionName,
        expectedProjectRoot: projectRoot,
        expectedDefinitionHash: entry.definitionHash ?? "",
      }).catch(() => null)
    : null;
  const owned =
    inspection?.classification === "owned-healthy" ||
    inspection?.classification === "owned-stale" ||
    inspection?.classification === "legacy-owned";
  const groups =
    owned && snapshot
      ? resolvePersistedLifecycleProcessGroupIds({
          lifecycleEntry: entry,
          snapshot,
        })
      : [];
  const members =
    snapshot?.filter((row) => groups.includes(row.processGroupId)) ?? [];
  return {
    project: entry.projectName,
    projectRoot,
    branch: entry.branch,
    session: entry.sessionName,
    backend: entry.backend,
    lifetime: "persistent",
    ownership: inspection?.classification ?? "unknown",
    definitionSource: "persisted",
    processGroupIds: groups,
    observedPids: members.map((row) => row.pid),
    liveCpuTimeMs:
      owned && snapshot
        ? members.reduce((sum, row) => sum + row.cpuTimeMs, 0)
        : null,
    liveRssBytes:
      owned && snapshot
        ? members.reduce((sum, row) => sum + row.rssBytes, 0)
        : null,
    elapsedMs: members.length
      ? Math.max(...members.map((row) => row.elapsedMs))
      : null,
    attention: lifecycleAttention(inspection?.classification),
  };
}

function lifecycleAttention(classification: string | undefined): string | null {
  if (classification === "absent") {
    return "session_absent_review_state";
  }
  return classification === "foreign" ? "ownership_unverified" : null;
}

function formatCpuSeconds(value: number | null): string {
  return value === null ? "n/a" : (value / 1000).toFixed(2);
}
