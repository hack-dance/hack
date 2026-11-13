import type { LifecycleStateEntry } from "./lifecycle-runtime.ts";
import {
  type ProcessIdentityRow,
  readProcessIdentities,
} from "./process-tree.ts";
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
  readonly beforeSignal?: (
    groups: readonly number[]
  ) => Promise<readonly number[]>;
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
    const targets = opts.beforeSignal
      ? await opts.beforeSignal(groups)
      : groups;
    for (const group of targets) {
      await opts.assertFresh?.();
      signal(group, "SIGTERM");
    }
  }
  const remaining = await wait(groups, 500);
  const targets =
    remaining.length > 0 && opts.beforeSignal
      ? await opts.beforeSignal(remaining)
      : remaining;
  for (const group of targets) {
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

type LifecyclePaneIdentity = {
  readonly panePid?: number;
  readonly paneBirth?: string;
};
type LifecycleSessionRetirementOptions = {
  readonly processes: readonly LifecyclePaneIdentity[];
  readonly stopSession: () => Promise<boolean>;
  readonly assertFresh?: () => Promise<void>;
};
type RetirementBoundary = {
  readonly readSnapshot: () => Promise<ProcessSnapshotRow[]>;
  readonly readIdentities: () => Promise<ProcessIdentityRow[]>;
};
type CapturedLifecycleGroups = {
  readonly groups: number[];
  readonly paneGroups: Set<number>;
  readonly members: Map<number, ProcessIdentityRow[]>;
};

/**
 * Capture owned descendants before removing their mux parent. A successful mux
 * kill is signal delivery, not child exit. Keep the FIFO wrapper alive to reap
 * the detached command before escalating against the wrapper's own group. Keep
 * the captured groups across a retry if the mux exited but retirement failed.
 */
export function createLifecycleSessionRetirement(boundary?: {
  readonly readSnapshot: () => Promise<ProcessSnapshotRow[]>;
  readonly readIdentities?: () => Promise<ProcessIdentityRow[]>;
}): (opts: LifecycleSessionRetirementOptions) => Promise<boolean> {
  let captured: CapturedLifecycleGroups | "unknown" | undefined;
  const os: RetirementBoundary = {
    readSnapshot:
      boundary?.readSnapshot ??
      (() => readProcessSnapshot({ timeoutMs: 1000 })),
    readIdentities: boundary?.readIdentities ?? readProcessIdentities,
  };
  return async (opts) => {
    if (!captured) {
      captured = await captureRetirementGroups({
        processes: opts.processes,
        os,
      });
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
    const { groups, paneGroups, members } = captured;
    const beforeSignal = (pending: readonly number[]) =>
      verifyRetirementGroups({ pending, members, os });
    await terminateLifecycleProcessGroups({
      processGroupIds: groups.filter((group) => !paneGroups.has(group)),
      alreadySignalled: true,
      beforeSignal,
      assertFresh: opts.assertFresh,
    });
    await terminateLifecycleProcessGroups({
      processGroupIds: groups.filter((group) => paneGroups.has(group)),
      alreadySignalled: true,
      beforeSignal,
      assertFresh: opts.assertFresh,
    });
    return true;
  };
}

async function captureRetirementGroups(opts: {
  readonly processes: readonly LifecyclePaneIdentity[];
  readonly os: RetirementBoundary;
}): Promise<CapturedLifecycleGroups | "unknown"> {
  if (!opts.processes.some((process) => process.panePid)) {
    return { groups: [], paneGroups: new Set(), members: new Map() };
  }
  const [snapshot, identities] = await Promise.all([
    readRetirementSnapshot({ read: opts.os.readSnapshot }),
    opts.os.readIdentities().catch(() => []),
  ]);
  if (
    snapshot.length === 0 ||
    identities.length === 0 ||
    opts.processes.some(
      (process) =>
        process.panePid &&
        !process.paneBirth &&
        identities.some((row) => row.pid === process.panePid)
    )
  ) {
    return "unknown";
  }
  const roots = opts.processes.flatMap((process) =>
    process.panePid &&
    process.paneBirth &&
    identities.some(
      (row) => row.pid === process.panePid && row.birth === process.paneBirth
    )
      ? [process.panePid]
      : []
  );
  const groups = collectDescendantProcessGroupIds({
    snapshot,
    rootPids: roots,
  });
  const paneGroups = new Set(
    snapshot
      .filter((row) => roots.includes(row.pid))
      .map((row) => row.processGroupId)
  );
  const members = new Map(
    groups.map((group) => [
      group,
      identities.filter((identity) =>
        snapshot.some(
          (row) => row.pid === identity.pid && row.processGroupId === group
        )
      ),
    ])
  );
  return { groups, paneGroups, members };
}

/** A captured PID/group number is not authority after its member's birth changes. */
async function verifyRetirementGroups(opts: {
  readonly pending: readonly number[];
  readonly members: ReadonlyMap<number, readonly ProcessIdentityRow[]>;
  readonly os: RetirementBoundary;
}): Promise<readonly number[]> {
  const [current, births] = await Promise.all([
    opts.os.readSnapshot(),
    opts.os.readIdentities(),
  ]);
  if (current.length === 0 || births.length === 0) {
    throw new Error(
      "Could not revalidate lifecycle process identities before signalling"
    );
  }
  return opts.pending.filter((group) => {
    const live = current.filter((row) => row.processGroupId === group);
    if (live.length === 0) {
      return false;
    }
    if (
      !(opts.members.get(group) ?? []).some(
        (member) =>
          live.some((row) => row.pid === member.pid) &&
          births.some(
            (row) => row.pid === member.pid && row.birth === member.birth
          )
      )
    ) {
      throw new Error(
        `Lifecycle process group ${group} no longer has a verified owned member; no signal sent`
      );
    }
    return true;
  });
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
