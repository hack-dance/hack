import { getMuxBackends } from "../mux/mux-resolver.ts";
import type {
  LifecycleBackend,
  LifecycleStateEntry,
} from "./lifecycle-runtime.ts";
import { readLifecycleState } from "./lifecycle-runtime.ts";
import {
  type ProcessSnapshotRow,
  readProcessSnapshot,
  resolveLeaderlessPersistedLifecycleProcessGroupIds,
  resolvePersistedLifecycleProcessGroupIds,
} from "./project-lifecycle-processes.ts";

export type StaleLifecycleStateEntry = {
  readonly entry: LifecycleStateEntry;
  readonly liveProcessGroups: readonly number[];
};

export type LifecycleHygieneInspection = {
  readonly staleEntries: readonly StaleLifecycleStateEntry[];
  readonly orphanedProcessGroups: readonly number[];
};

/** Inspect persisted lifecycle state for entries whose mux session is gone. */
export async function inspectProjectLifecycleHygiene(opts: {
  readonly projectDir: string;
}): Promise<LifecycleHygieneInspection> {
  const entries = await readLifecycleState({ projectDir: opts.projectDir });
  if (entries.length === 0) {
    return { staleEntries: [], orphanedProcessGroups: [] };
  }

  const [sessionsByBackend, snapshot] = await Promise.all([
    listSessionsByBackend(),
    readProcessSnapshot(),
  ]);

  return inspectLifecycleStateEntries({
    entries,
    sessionsByBackend,
    snapshot,
  });
}

/** Classify lifecycle entries that no longer have a matching mux session. */
export function inspectLifecycleStateEntries(opts: {
  readonly entries: readonly LifecycleStateEntry[];
  readonly sessionsByBackend: ReadonlyMap<
    LifecycleBackend,
    ReadonlySet<string>
  >;
  readonly snapshot: readonly ProcessSnapshotRow[];
}): LifecycleHygieneInspection {
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
