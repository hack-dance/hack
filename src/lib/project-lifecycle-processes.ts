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

/** Collect the process tree without interpreting names or taking ownership. */
export function collectDescendantProcessIds(opts: {
  readonly snapshot: readonly ProcessSnapshotRow[];
  readonly rootPids: readonly number[];
}): number[] {
  const children = new Map<number, number[]>();
  const live = new Set(opts.snapshot.map((row) => row.pid));
  for (const row of opts.snapshot) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  const queue = [...opts.rootPids];
  const visited = new Set<number>();
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index];
    if (pid === undefined || visited.has(pid) || !live.has(pid)) {
      continue;
    }
    visited.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...visited];
}

/** Collect distinct process groups reachable from the provided root PIDs. */
export function collectDescendantProcessGroupIds(opts: {
  readonly snapshot: readonly ProcessSnapshotRow[];
  readonly rootPids: readonly number[];
}): number[] {
  const pids = new Set(collectDescendantProcessIds(opts));
  return [
    ...new Set(
      opts.snapshot
        .filter((row) => pids.has(row.pid))
        .map((row) => row.processGroupId)
    ),
  ].sort((left, right) => left - right);
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

  const discoveredGroups = collectDescendantProcessGroupIds({
    snapshot: opts.snapshot,
    rootPids: [...rootPids],
  });
  const leaderlessGroups = resolveLeaderlessPersistedLifecycleProcessGroupIds({
    lifecycleEntry: opts.lifecycleEntry,
    snapshot: opts.snapshot,
  });
  return [...new Set([...discoveredGroups, ...leaderlessGroups])].sort(
    (left, right) => left - right
  );
}

/** Recover persisted groups whose original leader is gone but members remain. */
export function resolveLeaderlessPersistedLifecycleProcessGroupIds(opts: {
  readonly lifecycleEntry: LifecycleStateEntry | null;
  readonly snapshot: readonly ProcessSnapshotRow[];
}): number[] {
  const groups = new Set<number>();

  for (const processInfo of opts.lifecycleEntry?.processes ?? []) {
    const processGroupId = processInfo.processGroupId;
    if (!(processGroupId && processGroupId > 1)) {
      continue;
    }
    const persistedPaneStillExists =
      processInfo.panePid !== undefined &&
      opts.snapshot.some((row) => row.pid === processInfo.panePid);
    const groupLeaderStillExists = opts.snapshot.some(
      (row) => row.pid === processGroupId
    );
    const groupMemberPids = opts.snapshot
      .filter((row) => row.processGroupId === processGroupId)
      .map((row) => row.pid);
    if (
      !(persistedPaneStillExists || groupLeaderStillExists) &&
      groupMemberPids.length > 0
    ) {
      const descendantGroups = collectDescendantProcessGroupIds({
        snapshot: opts.snapshot,
        rootPids: groupMemberPids,
      });
      for (const descendantGroup of descendantGroups) {
        groups.add(descendantGroup);
      }
    }
  }

  return [...groups].sort((left, right) => left - right);
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

/** Only trust persisted lifecycle metadata when a matching mux session was observed live. */
export function resolveLifecycleStopProcessGroupIds(opts: {
  readonly matchedLiveSession: boolean;
  readonly lifecycleEntry: LifecycleStateEntry | null;
  readonly snapshot: readonly ProcessSnapshotRow[];
}): number[] {
  if (!opts.matchedLiveSession) {
    return [];
  }
  return resolvePersistedLifecycleProcessGroupIds({
    lifecycleEntry: opts.lifecycleEntry,
    snapshot: opts.snapshot,
  });
}

/** Read a process snapshot suitable for lifecycle cleanup and hygiene checks. */
export async function readProcessSnapshot(
  opts: { readonly timeoutMs?: number } = {}
): Promise<ProcessSnapshotRow[]> {
  const result = await exec(["ps", "-axo", "pid=,ppid=,pgid="], {
    stdin: "ignore",
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return parseProcessSnapshotOutput(result.stdout);
}

/** Terminate ownership-proven lifecycle groups with a bounded TERM/KILL sequence. */
export async function terminateLifecycleProcessGroups(opts: {
  readonly processGroupIds: readonly number[];
  readonly assertFresh?: () => Promise<void>;
  /** The mux already delivered HUP; give its wrapper time to reap children. */
  readonly alreadySignalled?: boolean;
  /** OS/time boundary, injectable for deterministic settlement tests. */
  readonly runtime?: {
    readonly signal: (group: number, signal: NodeJS.Signals | 0) => void;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  };
}): Promise<void> {
  const groups = [...new Set(opts.processGroupIds)].filter(
    (processGroupId) => processGroupId > 1
  );
  if (groups.length === 0) {
    return;
  }

  const runtime = opts.runtime ?? {
    signal: (group: number, signal: NodeJS.Signals | 0) => {
      process.kill(-group, signal);
    },
    now: () => performance.now(),
    sleep: async (ms: number) => {
      await Bun.sleep(ms);
    },
  };
  const signal = (group: number, name: NodeJS.Signals | 0): boolean => {
    try {
      runtime.signal(group, name);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return false;
      }
      throw new Error(
        `Could not confirm lifecycle process group ${group} stopped`,
        { cause: error }
      );
    }
  };
  const wait = async (
    pending: readonly number[],
    timeoutMs: number
  ): Promise<number[]> => {
    const deadline = runtime.now() + timeoutMs;
    let remaining = pending.filter((group) => signal(group, 0));
    while (remaining.length > 0 && runtime.now() < deadline) {
      await runtime.sleep(Math.min(25, deadline - runtime.now()));
      remaining = remaining.filter((group) => signal(group, 0));
    }
    return remaining;
  };
  if (!opts.alreadySignalled) {
    for (const group of groups) {
      await opts.assertFresh?.();
      signal(group, "SIGTERM");
    }
  }
  const remaining = await wait(groups, 500);
  for (const group of remaining) {
    await opts.assertFresh?.();
    signal(group, "SIGKILL");
  }
  const unconfirmed = await wait(remaining, 2000);
  if (unconfirmed.length > 0) {
    throw new Error(
      `Could not confirm lifecycle process groups stopped after SIGKILL: ${unconfirmed.join(", ")}`
    );
  }
}

type LifecycleSessionRetirementOptions = {
  readonly processes: readonly { readonly panePid?: number }[];
  readonly stopSession: () => Promise<boolean>;
};

/**
 * Capture owned descendants before removing their mux parent. A successful mux
 * kill is signal delivery, not child exit. Keep the FIFO wrapper alive to reap
 * the detached command before escalating against the wrapper's own group. Keep
 * the captured groups across a retry if the mux exited but retirement failed.
 */
export function createLifecycleSessionRetirement(boundary?: {
  readonly readSnapshot: () => Promise<ProcessSnapshotRow[]>;
}): (opts: LifecycleSessionRetirementOptions) => Promise<boolean> {
  let captured:
    | { groups: number[]; paneGroups: Set<number> }
    | "unknown"
    | undefined;
  return async (opts) => {
    if (!captured) {
      const roots = opts.processes.flatMap((process) =>
        process.panePid ? [process.panePid] : []
      );
      const snapshot =
        roots.length > 0
          ? await readRetirementSnapshot({
              read:
                boundary?.readSnapshot ??
                (() => readProcessSnapshot({ timeoutMs: 1000 })),
            })
          : [];
      const groups = collectDescendantProcessGroupIds({
        snapshot,
        rootPids: roots,
      });
      const paneGroups = new Set(
        snapshot
          .filter((row) => roots.includes(row.pid))
          .map((row) => row.processGroupId)
      );
      captured =
        roots.length > 0 && snapshot.length === 0
          ? "unknown"
          : { groups, paneGroups };
    }
    if (!(await opts.stopSession())) {
      captured = undefined;
      return false;
    }
    if (captured === "unknown") {
      throw new Error(
        "Lifecycle mux stopped, but descendant retirement could not be confirmed because process inspection failed"
      );
    }
    const { groups, paneGroups } = captured;
    await terminateLifecycleProcessGroups({
      processGroupIds: groups.filter((group) => !paneGroups.has(group)),
      alreadySignalled: true,
    });
    await terminateLifecycleProcessGroups({
      processGroupIds: groups.filter((group) => paneGroups.has(group)),
      alreadySignalled: true,
    });
    return true;
  };
}

/** Retry one transient foreground observation; neither failure proves absence. */
async function readRetirementSnapshot(opts: {
  readonly read: () => Promise<ProcessSnapshotRow[]>;
}): Promise<ProcessSnapshotRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const snapshot = await opts.read();
      if (snapshot.length > 0) {
        return snapshot;
      }
    } catch {
      // Still attempt the owned mux stop, but retain descendant uncertainty.
    }
  }
  return [];
}
