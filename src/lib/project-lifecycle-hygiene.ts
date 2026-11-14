import { realpath } from "node:fs/promises";

import { runMuxCommand } from "../mux/mux-backend.ts";
import { getMuxBackends } from "../mux/mux-resolver.ts";
import type {
  LifecycleBackend,
  LifecycleStateEntry,
} from "./lifecycle-runtime.ts";
import {
  readLifecycleState,
  removeLifecycleStateEntryIfMatching,
} from "./lifecycle-runtime.ts";
import { readProcessIdentities } from "./process-tree.ts";
import {
  createLifecycleSessionRetirement,
  type ProcessSnapshotRow,
  readProcessSnapshot,
  resolveLeaderlessPersistedLifecycleProcessGroupIds,
  resolvePersistedLifecycleProcessGroupIds,
} from "./project-lifecycle-processes.ts";
import {
  inspectLifecycleSession,
  killInspectedLifecycleSession,
  type LifecycleSessionClassification,
  type LifecycleSessionInspection,
} from "./project-lifecycle-sessions.ts";
import {
  type RuntimeProject,
  readRuntimeProjects,
} from "./runtime-projects.ts";

const LIFECYCLE_SESSION_ORPHAN_GRACE_MS = 5 * 60 * 1000;

export type StaleLifecycleStateEntry = {
  readonly entry: LifecycleStateEntry;
  readonly liveProcessGroups: readonly number[];
};

export type OrphanedLifecycleSession = {
  readonly entry: LifecycleStateEntry;
  readonly classification: Exclude<
    LifecycleSessionClassification,
    "absent" | "foreign"
  >;
};

export type UnverifiedLifecycleSession = {
  readonly entry: LifecycleStateEntry;
  readonly reason: string;
};

export type LifecycleHygieneInspection = {
  readonly staleEntries: readonly StaleLifecycleStateEntry[];
  readonly orphanedProcessGroups: readonly number[];
  readonly orphanedSessions: readonly OrphanedLifecycleSession[];
  readonly unverifiedSessions: readonly UnverifiedLifecycleSession[];
  readonly runtimeAvailable: boolean;
};

export type LifecycleHygieneRepairResult = {
  readonly repairedSessions: readonly string[];
  readonly failures: readonly string[];
};

/** Inspect persisted lifecycle state, mux ownership, processes, and Compose liveness. */
export async function inspectProjectLifecycleHygiene(opts: {
  readonly projectDir: string;
  readonly projectRoot: string;
}): Promise<LifecycleHygieneInspection> {
  const entries = await readLifecycleState({ projectDir: opts.projectDir });
  if (entries.length === 0) {
    return {
      staleEntries: [],
      orphanedProcessGroups: [],
      orphanedSessions: [],
      unverifiedSessions: [],
      runtimeAvailable: true,
    };
  }

  const [sessionsByBackend, snapshot, activeComposeProjects] =
    await Promise.all([
      listSessionsByBackend(),
      readProcessSnapshot(),
      readActiveComposeProjects({ projectDir: opts.projectDir }),
    ]);
  const stateInspection = inspectLifecycleStateEntries({
    entries,
    sessionsByBackend,
    snapshot,
  });
  const sessionInspections = await inspectOwnedLifecycleSessions({
    entries,
    projectRoot: opts.projectRoot,
  });
  const sessionHygiene = classifyLifecycleSessionHygiene({
    entries,
    sessionInspections,
    activeComposeProjects,
  });

  return {
    ...stateInspection,
    ...sessionHygiene,
    runtimeAvailable: activeComposeProjects !== null,
  };
}

/** Classify lifecycle entries that no longer have a matching mux session. */
export function inspectLifecycleStateEntries(opts: {
  readonly entries: readonly LifecycleStateEntry[];
  readonly sessionsByBackend: ReadonlyMap<
    LifecycleBackend,
    ReadonlySet<string>
  >;
  readonly snapshot: readonly ProcessSnapshotRow[];
}): Pick<LifecycleHygieneInspection, "staleEntries" | "orphanedProcessGroups"> {
  const staleEntries: StaleLifecycleStateEntry[] = [];
  const orphanedProcessGroups = new Set<number>();

  for (const entry of opts.entries) {
    const sessions = opts.sessionsByBackend.get(entry.backend);
    const sessionPresent = sessions?.has(entry.sessionName) ?? false;
    if (sessionPresent) {
      const leaderlessGroups =
        resolveLeaderlessPersistedLifecycleProcessGroupIds({
          lifecycleEntry: entry,
          snapshot: opts.snapshot,
        });
      for (const processGroupId of leaderlessGroups) {
        orphanedProcessGroups.add(processGroupId);
      }
      continue;
    }

    staleEntries.push({
      entry,
      liveProcessGroups: resolvePersistedLifecycleProcessGroupIds({
        lifecycleEntry: entry,
        snapshot: opts.snapshot,
      }),
    });
  }

  return {
    staleEntries,
    orphanedProcessGroups: [...orphanedProcessGroups].sort(
      (left, right) => left - right
    ),
  };
}

export function classifyLifecycleSessionHygiene(opts: {
  readonly entries: readonly LifecycleStateEntry[];
  readonly sessionInspections: ReadonlyMap<string, LifecycleSessionInspection>;
  readonly activeComposeProjects: ReadonlySet<string> | null;
  readonly now?: Date;
}): Pick<
  LifecycleHygieneInspection,
  "orphanedSessions" | "unverifiedSessions"
> {
  const orphanedSessions: OrphanedLifecycleSession[] = [];
  const unverifiedSessions: UnverifiedLifecycleSession[] = [];
  const nowMs = (opts.now ?? new Date()).getTime();

  for (const entry of opts.entries) {
    const inspection = opts.sessionInspections.get(entry.composeProject);
    if (!inspection || inspection.classification === "absent") {
      continue;
    }
    if (
      inspection.classification === "foreign" ||
      inspection.decision.kind === "block"
    ) {
      unverifiedSessions.push({
        entry,
        reason:
          inspection.decision.kind === "block"
            ? inspection.decision.reason
            : `Lifecycle session "${entry.sessionName}" ownership could not be verified.`,
      });
      continue;
    }
    if (
      opts.activeComposeProjects !== null &&
      !opts.activeComposeProjects.has(entry.composeProject)
    ) {
      const stateAgeMs = nowMs - Date.parse(entry.updatedAt);
      if (
        !Number.isFinite(stateAgeMs) ||
        stateAgeMs < LIFECYCLE_SESSION_ORPHAN_GRACE_MS
      ) {
        unverifiedSessions.push({
          entry,
          reason: `Lifecycle session "${entry.sessionName}" is recent enough to belong to an in-flight startup.`,
        });
        continue;
      }
      orphanedSessions.push({
        entry,
        classification: inspection.classification,
      });
    }
  }

  return { orphanedSessions, unverifiedSessions };
}

/** Safely reap sessions that remain ownership-proven and runtime-orphaned. */
export async function repairProjectLifecycleSessions(opts: {
  readonly projectDir: string;
  readonly projectRoot: string;
  /** Platform boundaries for repair ordering and failure regressions. */
  readonly boundary?: {
    readonly inspect?: typeof inspectProjectLifecycleHygiene;
    readonly backends?: typeof getMuxBackends;
    readonly inspectSession?: typeof inspectLifecycleSession;
    readonly readPanes?: typeof readRepairPanes;
    readonly readIdentities?: typeof readProcessIdentities;
    readonly retireSession?: ReturnType<
      typeof createLifecycleSessionRetirement
    >;
  };
}): Promise<LifecycleHygieneRepairResult> {
  const {
    inspect = inspectProjectLifecycleHygiene,
    backends = getMuxBackends,
    inspectSession = inspectLifecycleSession,
    readPanes = readRepairPanes,
    readIdentities = readProcessIdentities,
    retireSession,
  } = opts.boundary ?? {};
  const initial = await inspect(opts);
  const repairedSessions: string[] = [];
  const failures: string[] = [];

  for (const candidate of initial.orphanedSessions) {
    const current = await inspect(opts);
    const orphan = current.orphanedSessions.find(
      (item) => item.entry.composeProject === candidate.entry.composeProject
    );
    if (!orphan) {
      failures.push(
        `${candidate.entry.sessionName}: liveness or ownership changed before repair`
      );
      continue;
    }
    const backend = backends().get(orphan.entry.backend);
    if (!backend?.available) {
      failures.push(`${orphan.entry.sessionName}: mux backend unavailable`);
      continue;
    }
    const inspection = await inspectSession({
      backend,
      entry: orphan.entry,
      expectedSessionName: orphan.entry.sessionName,
      expectedProjectRoot: opts.projectRoot,
      expectedDefinitionHash: orphan.entry.definitionHash ?? "",
    });
    if (
      inspection.decision.kind === "block" ||
      inspection.decision.kind === "create"
    ) {
      failures.push(
        `${orphan.entry.sessionName}: ownership proof changed before repair`
      );
      continue;
    }
    let killed: boolean;
    try {
      const processes = await readRepairPaneIdentities({
        entry: orphan.entry,
        readPanes,
        readIdentities,
      });
      killed = await (retireSession ?? createLifecycleSessionRetirement())({
        processes,
        stopSession: () =>
          killInspectedLifecycleSession({ backend, inspection }),
        assertFresh: () =>
          assertRepairEntryCurrent({
            projectDir: opts.projectDir,
            entry: orphan.entry,
          }),
      });
    } catch (error: unknown) {
      failures.push(
        `${orphan.entry.sessionName}: ${repairFailureMessage(error)}; kept ownership state`
      );
      continue;
    }
    if (!killed) {
      failures.push(`${orphan.entry.sessionName}: mux teardown failed`);
      continue;
    }
    const stateRemoved = await removeLifecycleStateEntryIfMatching({
      projectDir: opts.projectDir,
      expectedEntry: orphan.entry,
    });
    if (!stateRemoved) {
      failures.push(
        `${orphan.entry.sessionName}: session stopped, but lifecycle state changed concurrently`
      );
      continue;
    }
    repairedSessions.push(orphan.entry.sessionName);
  }

  return { repairedSessions, failures };
}

function repairFailureMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "process-group retirement unconfirmed";
}

/** Refresh only panes belonging to the already ownership-proven mux windows. */
async function readRepairPaneIdentities(opts: {
  readonly entry: LifecycleStateEntry;
  readonly readPanes: typeof readRepairPanes;
  readonly readIdentities: typeof readProcessIdentities;
}): Promise<
  readonly { readonly panePid?: number; readonly paneBirth?: string }[]
> {
  if (opts.entry.backend !== "tmux") {
    return opts.entry.processes;
  }
  const windows = new Set(
    opts.entry.processes.map((process) => process.windowName)
  );
  const panes = (
    await opts.readPanes({ sessionName: opts.entry.sessionName })
  ).filter((pane) => windows.has(pane.windowName));
  const hasRecordedIdentity = opts.entry.processes.some(
    (process) => process.paneBirth || process.processGroupBirth
  );
  if (panes.length === 0 && !hasRecordedIdentity) {
    return [];
  }
  const identities = await opts.readIdentities();
  if (
    identities.length === 0 ||
    panes.some((pane) => !identities.some((row) => row.pid === pane.panePid))
  ) {
    throw new Error(
      "Current lifecycle pane identity is unavailable before repair"
    );
  }
  const liveIdentities = identities.filter((row) => !row.zombie);
  const activePanes = panes.filter((pane) =>
    liveIdentities.some((row) => row.pid === pane.panePid)
  );
  const liveWindows = new Set(activePanes.map((pane) => pane.windowName));
  if (
    opts.entry.processes.some(
      (process) =>
        !liveWindows.has(process.windowName) &&
        liveIdentities.some(
          (row) =>
            (process.paneBirth &&
              row.pid === process.panePid &&
              row.birth === process.paneBirth) ||
            (process.processGroupBirth &&
              row.pid === process.processGroupId &&
              row.birth === process.processGroupBirth)
        )
    )
  ) {
    throw new Error(
      "Recorded lifecycle identity remains alive outside current mux windows; retirement is unconfirmed"
    );
  }
  return activePanes.map(({ panePid }) => ({
    panePid,
    paneBirth: liveIdentities.find((row) => row.pid === panePid)?.birth,
  }));
}

async function readRepairPanes(opts: {
  readonly sessionName: string;
}): Promise<
  readonly { readonly panePid: number; readonly windowName: string }[]
> {
  const result = await runMuxCommand(
    [
      "tmux",
      "list-panes",
      "-s",
      "-t",
      `=${opts.sessionName}`,
      "-F",
      "#{pane_pid}\t#{window_name}",
    ],
    { maxStdoutBytes: 256 * 1024 }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "Could not read current lifecycle pane identity before repair"
    );
  }
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(
      "Current lifecycle pane identity is unavailable before repair"
    );
  }
  return lines.map((line) => {
    const fields = line.split("\t");
    const panePid = Number(fields[0]);
    const windowName = fields[1];
    if (
      fields.length !== 2 ||
      !Number.isInteger(panePid) ||
      panePid <= 1 ||
      !windowName
    ) {
      throw new Error(
        "Current lifecycle pane inventory is invalid before repair"
      );
    }
    return { panePid, windowName };
  });
}

/** Retained group identities cannot authorize signals after their owner changes. */
async function assertRepairEntryCurrent(opts: {
  readonly projectDir: string;
  readonly entry: LifecycleStateEntry;
}): Promise<void> {
  const current = (await readLifecycleState(opts)).find(
    (entry) => entry.composeProject === opts.entry.composeProject
  );
  if (
    !current ||
    current.sessionName !== opts.entry.sessionName ||
    current.backend !== opts.entry.backend ||
    current.updatedAt !== opts.entry.updatedAt ||
    current.ownershipToken !== opts.entry.ownershipToken
  ) {
    throw new Error("Lifecycle ownership changed before repair retirement");
  }
}

async function inspectOwnedLifecycleSessions(opts: {
  readonly entries: readonly LifecycleStateEntry[];
  readonly projectRoot: string;
}): Promise<ReadonlyMap<string, LifecycleSessionInspection>> {
  const backends = getMuxBackends();
  const inspections = new Map<string, LifecycleSessionInspection>();
  for (const entry of opts.entries) {
    const backend = backends.get(entry.backend);
    if (!backend?.available) {
      continue;
    }
    inspections.set(
      entry.composeProject,
      await inspectLifecycleSession({
        backend,
        entry,
        expectedSessionName: entry.sessionName,
        expectedProjectRoot: opts.projectRoot,
        expectedDefinitionHash: entry.definitionHash ?? "",
      })
    );
  }
  return inspections;
}

async function readActiveComposeProjects(opts: {
  readonly projectDir: string;
}): Promise<ReadonlySet<string> | null> {
  const runtime = await readRuntimeProjects({ includeGlobal: false });
  if (!runtime.ok) {
    return null;
  }
  const normalizedProjectDir = await normalizePath(opts.projectDir);
  const activeProjects = new Set<string>();
  for (const project of runtime.runtime) {
    if (
      !(project.workingDir && hasRunningComposeContainer(project)) ||
      (await normalizePath(project.workingDir)) !== normalizedProjectDir
    ) {
      continue;
    }
    activeProjects.add(project.project);
  }
  return activeProjects;
}

function hasRunningComposeContainer(project: RuntimeProject): boolean {
  for (const service of project.services.values()) {
    if (
      service.containers.some(
        (container) =>
          container.state === "running" &&
          container.labels?.["hack.lifecycle.process"] !== "true"
      )
    ) {
      return true;
    }
  }
  return false;
}

async function listSessionsByBackend(): Promise<
  ReadonlyMap<LifecycleBackend, ReadonlySet<string>>
> {
  const backends = getMuxBackends();
  const sessionsByBackend = new Map<LifecycleBackend, ReadonlySet<string>>();

  for (const [name, backend] of backends) {
    if (!backend.available) {
      sessionsByBackend.set(name, new Set());
      continue;
    }
    const sessions = await backend.listSessions();
    sessionsByBackend.set(
      name,
      new Set(sessions.map((session) => session.name))
    );
  }

  return sessionsByBackend;
}

async function normalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
