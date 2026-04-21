import type { LifecycleStateEntry } from "./lifecycle-runtime.ts";
import { exec } from "./shell.ts";

export type ProcessSnapshotRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly processGroupId: number;
};

const WHITESPACE_PATTERN = /\s+/;

/** Parse `ps` output into PID, parent PID, and process-group rows. */
export function parseProcessSnapshotOutput(text: string): ProcessSnapshotRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parts = line.split(WHITESPACE_PATTERN);
      if (parts.length < 3) {
        return [];
      }
      const pid = Number.parseInt(parts[0] ?? "", 10);
      const ppid = Number.parseInt(parts[1] ?? "", 10);
      const processGroupId = Number.parseInt(parts[2] ?? "", 10);
      if (
        !(
          Number.isInteger(pid) &&
          pid > 0 &&
          Number.isInteger(ppid) &&
          ppid >= 0 &&
          Number.isInteger(processGroupId) &&
          processGroupId > 0
        )
      ) {
        return [];
      }
      return [{ pid, ppid, processGroupId }];
    });
}

/** Collect distinct process groups reachable from the provided root PIDs. */
export function collectDescendantProcessGroupIds(opts: {
  readonly snapshot: readonly ProcessSnapshotRow[];
  readonly rootPids: readonly number[];
}): number[] {
  const processByParent = new Map<number, ProcessSnapshotRow[]>();
  const groups = new Set<number>();
  const queue = [...opts.rootPids];
  const visited = new Set<number>();

  for (const row of opts.snapshot) {
    const siblings = processByParent.get(row.ppid) ?? [];
    siblings.push(row);
    processByParent.set(row.ppid, siblings);
  }

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!(pid && pid > 0) || visited.has(pid)) {
      continue;
    }
    visited.add(pid);

    const current = opts.snapshot.find((row) => row.pid === pid);
    if (current) {
      groups.add(current.processGroupId);
    }

    for (const child of processByParent.get(pid) ?? []) {
      groups.add(child.processGroupId);
      if (!visited.has(child.pid)) {
        queue.push(child.pid);
      }
    }
  }

  return [...groups].sort((left, right) => left - right);
}

/** Reconcile mux pane state with persisted lifecycle metadata to recover live groups. */
export function resolveLifecycleProcessGroupIdsForTmuxState(opts: {
  readonly lifecycleEntry: LifecycleStateEntry | null;
  readonly panePidsByWindow: ReadonlyMap<string, readonly number[]>;
  readonly snapshot: readonly ProcessSnapshotRow[];
}): number[] {
  const rootPids = new Set<number>();

  for (const processInfo of opts.lifecycleEntry?.processes ?? []) {
    const currentPanePids =
      opts.panePidsByWindow.get(processInfo.windowName) ?? [];
    for (const panePid of currentPanePids) {
      rootPids.add(panePid);
    }
    if (currentPanePids.length > 0) {
      continue;
    }
    if (
      processInfo.panePid !== undefined &&
      opts.snapshot.some((row) => row.pid === processInfo.panePid)
    ) {
      rootPids.add(processInfo.panePid);
    }
  }

  return collectDescendantProcessGroupIds({
    snapshot: opts.snapshot,
    rootPids: [...rootPids],
  });
}

/** Recover live lifecycle process groups from persisted metadata when mux panes are gone. */
export function resolvePersistedLifecycleProcessGroupIds(opts: {
  readonly lifecycleEntry: LifecycleStateEntry | null;
  readonly snapshot: readonly ProcessSnapshotRow[];
}): number[] {
  return resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: opts.lifecycleEntry,
    panePidsByWindow: new Map(),
    snapshot: opts.snapshot,
  });
}

/** Read a process snapshot suitable for lifecycle cleanup and hygiene checks. */
export async function readProcessSnapshot(): Promise<ProcessSnapshotRow[]> {
  const result = await exec(["ps", "-axo", "pid=,ppid=,pgid="], {
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return parseProcessSnapshotOutput(result.stdout);
}
