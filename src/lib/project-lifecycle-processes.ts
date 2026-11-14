import { traceLifecycleRetirement } from "./lifecycle-retirement-trace.ts";
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
export const LIFECYCLE_TERM_GRACE_MS = 5000;

/** A failed census is unknown and may be retried within the observation budget. */
class LifecycleCensusUnavailable extends Error {}

function hasProcessErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** A zombie holds a PID but runs no code; only live members keep a group active. */
export function selectLiveLifecycleGroups(opts: {
  readonly groups: readonly number[];
  readonly identities: readonly ProcessIdentityRow[];
}): number[] {
  if (
    opts.identities.length === 0 ||
    opts.identities.some((row) => row.processGroupId === undefined)
  ) {
    throw new Error("Could not inspect live lifecycle process-group members");
  }
  const live = new Set(
    opts.identities
      .filter((row) => !row.zombie)
      .map((row) => row.processGroupId)
  );
  return opts.groups.filter((group) => live.has(group));
}

/** Shared post-stop proof, including native host adapters that retain their own pins. */
export async function assertLifecycleProcessGroupRetired(opts: {
  readonly processGroupId: number;
}): Promise<void> {
  try {
    process.kill(-opts.processGroupId, 0);
  } catch (error) {
    if (hasProcessErrorCode(error, "ESRCH")) {
      return;
    }
    // macOS can report EPERM for an unreaped zombie-only group. Only the
    // following census can distinguish that benign state from live members.
    if (!hasProcessErrorCode(error, "EPERM")) {
      throw error;
    }
  }
  if (
    selectLiveLifecycleGroups({
      groups: [opts.processGroupId],
      identities: await readProcessIdentities(),
    }).length > 0
  ) {
    throw new Error("Lifecycle process group still has a live member");
  }
}

export async function terminateLifecycleProcessGroups(opts: {
  readonly processGroupIds: readonly number[];
  readonly assertFresh?: () => Promise<void>;
  /** All groups already received their shutdown signal. */
  readonly alreadySignalled?: boolean;
  /** Only these groups received shutdown through the mux/wrapper. */
  readonly alreadySignalledGroups?: readonly number[];
  /** A repeated interrupt skips grace, never identity checks or confirmation. */
  readonly force?: AbortSignal;
  readonly beforeSignal?: (
    groups: readonly number[]
  ) => Promise<readonly number[]>;
  readonly readIdentities?: typeof readProcessIdentities;
  /** OS/time boundary, injectable for deterministic settlement tests. */
  readonly runtime?: {
    readonly signal: (group: number, signal: NodeJS.Signals | 0) => void;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly liveGroups: (
      groups: readonly number[]
    ) => Promise<readonly number[]>;
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
    liveGroups: async (groups: readonly number[]) =>
      selectLiveLifecycleGroups({
        groups,
        identities: await (opts.readIdentities ?? readProcessIdentities)(),
      }),
  };
  const deniedDeliveries = new Map<number, Error>();
  const signal = (group: number, name: NodeJS.Signals | 0): boolean => {
    try {
      runtime.signal(group, name);
      traceLifecycleRetirement("group-signal", {
        group,
        probe: name === 0,
        kill: name === "SIGKILL",
      });
      return true;
    } catch (error: unknown) {
      traceLifecycleRetirement(
        "group-signal-failed",
        { group, probe: name === 0, kill: name === "SIGKILL" },
        error
      );
      if (hasProcessErrorCode(error, "ESRCH")) {
        return false;
      }
      const failure = new Error(
        `Could not confirm lifecycle process group ${group} stopped`,
        { cause: error }
      );
      if (hasProcessErrorCode(error, "EPERM")) {
        // A probe proves neither liveness nor absence. A denied delivery is
        // benign only if the next successful observation proves retirement.
        if (name !== 0) {
          deniedDeliveries.set(group, failure);
        }
        return true;
      }
      throw failure;
    }
  };
  const living = async (pending: readonly number[]): Promise<number[]> => {
    const existing = pending.filter((group) => signal(group, 0));
    if (existing.length === 0) {
      return [];
    }
    let live: Set<number>;
    try {
      live = new Set(await runtime.liveGroups(existing));
      traceLifecycleRetirement("group-census", {
        groups: existing,
        live: [...live],
      });
    } catch (cause) {
      traceLifecycleRetirement(
        "group-census-failed",
        { groups: existing },
        cause
      );
      throw new LifecycleCensusUnavailable(
        "Could not inspect live lifecycle process-group members",
        { cause }
      );
    }
    const remaining = existing.filter((group) => live.has(group));
    for (const group of remaining) {
      const denied = deniedDeliveries.get(group);
      if (denied) {
        throw denied;
      }
    }
    return remaining;
  };
  const observe = async (pending: readonly number[]) => {
    try {
      return { groups: await living(pending) };
    } catch (error) {
      if (!(error instanceof LifecycleCensusUnavailable)) {
        throw error;
      }
      return { unavailable: error };
    }
  };
  const wait = async ({
    pending,
    timeoutMs,
    firstObservation = false,
    allowForce = false,
  }: {
    readonly pending: readonly number[];
    readonly timeoutMs: number;
    readonly firstObservation?: boolean;
    readonly allowForce?: boolean;
  }): Promise<number[]> => {
    const deadline = runtime.now() + timeoutMs;
    let remaining = [...pending];
    let observed = false;
    let unavailable: LifecycleCensusUnavailable | undefined;
    for (;;) {
      const sample = await observe(remaining);
      if (sample.groups) {
        remaining = sample.groups;
        observed = true;
        if (firstObservation || remaining.length === 0) {
          return remaining;
        }
      } else {
        unavailable = sample.unavailable;
      }
      const forced = allowForce && opts.force?.aborted === true;
      if (runtime.now() >= deadline || (observed && forced)) {
        traceLifecycleRetirement("group-wait-ended", {
          groups: remaining,
          observed,
          forced,
          timeoutMs,
        });
        if (!observed) {
          throw unavailable;
        }
        return remaining;
      }
      await runtime.sleep(Math.min(100, Math.max(0, deadline - runtime.now())));
    }
  };
  const initial = await wait({
    pending: groups,
    timeoutMs: LIFECYCLE_TERM_GRACE_MS,
    firstObservation: true,
  });
  const signalled = new Set(opts.alreadySignalledGroups);
  const needsTerm = opts.alreadySignalled
    ? []
    : initial.filter((group) => !signalled.has(group));
  if (needsTerm.length > 0) {
    const targets = opts.beforeSignal
      ? await opts.beforeSignal(needsTerm)
      : needsTerm;
    for (const group of targets) {
      await opts.assertFresh?.();
      signal(group, "SIGTERM");
    }
  }
  const remaining = await wait({
    pending: initial,
    timeoutMs: LIFECYCLE_TERM_GRACE_MS,
    allowForce: true,
  });
  const targets =
    remaining.length > 0 && opts.beforeSignal
      ? await opts.beforeSignal(remaining)
      : remaining;
  for (const group of targets) {
    await opts.assertFresh?.();
    signal(group, "SIGKILL");
  }
  const unconfirmed = await wait({ pending: remaining, timeoutMs: 2000 });
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
  readonly force?: AbortSignal;
};
type RetirementBoundary = {
  readonly readSnapshot: () => Promise<ProcessSnapshotRow[]>;
  readonly readIdentities: () => Promise<ProcessIdentityRow[]>;
};
type CapturedLifecycleGroups = {
  readonly groups: number[];
  readonly paneGroups: Set<number>;
  readonly signalledGroups: number[];
  readonly members: Map<number, ProcessIdentityRow[]>;
};

/**
 * Capture owned descendants before removing their mux parent. A successful mux
 * kill is signal delivery, not child exit. Keep the FIFO wrapper alive to reap
 * the detached command before escalating against the wrapper's own group. Keep
 * the captured groups across a retry if the mux exited but retirement failed.
 */
export function createLifecycleSessionRetirement(boundary?: {
  readonly readSnapshot?: () => Promise<ProcessSnapshotRow[]>;
  readonly readIdentities?: () => Promise<ProcessIdentityRow[]>;
}): (opts: LifecycleSessionRetirementOptions) => Promise<boolean> {
  let captured:
    | CapturedLifecycleGroups
    | "unknown"
    | "identity_unavailable"
    | undefined;
  const os: RetirementBoundary = {
    readSnapshot:
      boundary?.readSnapshot ??
      (() => readProcessSnapshot({ timeoutMs: 1000 })),
    readIdentities: boundary?.readIdentities ?? readProcessIdentities,
  };
  return async (opts) => {
    if (!captured) {
      traceLifecycleRetirement("capture-begin", {
        processes: opts.processes.length,
      });
      captured = await captureRetirementGroups({
        processes: opts.processes,
        os,
      });
    }
    traceLifecycleRetirement("retirement-captured", {
      unknown: captured === "unknown",
      missingIdentity: captured === "identity_unavailable",
      groups: typeof captured === "object" ? captured.groups : [],
    });
    if (!(await opts.stopSession())) {
      captured = undefined;
      return false;
    }
    traceLifecycleRetirement("retirement-mux-stopped");
    if (captured === "unknown") {
      throw new Error(
        "Lifecycle mux stopped, but descendant retirement could not be confirmed because process inspection failed"
      );
    }
    if (captured === "identity_unavailable") {
      throw new Error(
        "Lifecycle mux stopped, but descendant retirement could not be confirmed because pane identity is unavailable"
      );
    }
    const { groups, paneGroups, signalledGroups, members } = captured;
    const beforeSignal = (pending: readonly number[]) =>
      verifyRetirementGroups({ pending, members, os });
    await terminateLifecycleProcessGroups({
      processGroupIds: groups.filter((group) => !paneGroups.has(group)),
      alreadySignalledGroups: signalledGroups,
      beforeSignal,
      readIdentities: os.readIdentities,
      assertFresh: opts.assertFresh,
      force: opts.force,
    });
    await terminateLifecycleProcessGroups({
      processGroupIds: groups.filter((group) => paneGroups.has(group)),
      alreadySignalled: true,
      beforeSignal,
      readIdentities: os.readIdentities,
      assertFresh: opts.assertFresh,
      // Even a forced command stop leaves the wrapper time to reap children
      // and remove its private FIFO directory before wrapper escalation.
    });
    return true;
  };
}

async function captureRetirementGroups(opts: {
  readonly processes: readonly LifecyclePaneIdentity[];
  readonly os: RetirementBoundary;
}): Promise<CapturedLifecycleGroups | "unknown" | "identity_unavailable"> {
  if (!opts.processes.some((process) => process.panePid)) {
    return {
      groups: [],
      paneGroups: new Set(),
      signalledGroups: [],
      members: new Map(),
    };
  }
  const [snapshot, identities] = await Promise.all([
    readRetirementSnapshot({ read: opts.os.readSnapshot }),
    readRetirementIdentities(opts.os.readIdentities),
  ]);
  traceLifecycleRetirement("capture-reads", {
    snapshotRows: snapshot.length,
    identityRows: identities.length,
    panePids: opts.processes.flatMap((process) =>
      process.panePid ? [process.panePid] : []
    ),
    livePanePids: identities
      .filter(
        (row) =>
          !row.zombie &&
          opts.processes.some((process) => process.panePid === row.pid)
      )
      .map((row) => row.pid),
    zombiePanePids: identities
      .filter(
        (row) =>
          row.zombie &&
          opts.processes.some((process) => process.panePid === row.pid)
      )
      .map((row) => row.pid),
  });
  if (snapshot.length === 0 || identities.length === 0) {
    return "unknown";
  }
  if (
    opts.processes.some(
      (process) =>
        process.panePid &&
        !process.paneBirth &&
        identities.some((row) => !row.zombie && row.pid === process.panePid)
    )
  ) {
    return "identity_unavailable";
  }
  const roots = opts.processes.flatMap((process) =>
    process.panePid &&
    process.paneBirth &&
    identities.some(
      (row) =>
        !row.zombie &&
        row.pid === process.panePid &&
        row.birth === process.paneBirth
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
  // The FIFO wrapper forwards TERM to its direct command child's group only.
  // Other descendant groups need their own TERM, with the same identity fence.
  const signalledGroups = snapshot
    .filter((row) => roots.includes(row.ppid))
    .map((row) => row.processGroupId);
  const members = new Map(
    groups.map((group) => [
      group,
      identities.filter(
        (identity) =>
          !identity.zombie &&
          snapshot.some(
            (row) => row.pid === identity.pid && row.processGroupId === group
          )
      ),
    ])
  );
  traceLifecycleRetirement("capture-complete", {
    groups,
    paneGroups: [...paneGroups],
    roots,
  });
  return { groups, paneGroups, signalledGroups, members };
}

/** A captured PID/group number is not authority after its member's birth changes. */
async function verifyRetirementGroups(opts: {
  readonly pending: readonly number[];
  readonly members: ReadonlyMap<number, readonly ProcessIdentityRow[]>;
  readonly os: RetirementBoundary;
}): Promise<readonly number[]> {
  const births = await readRetirementIdentities(opts.os.readIdentities);
  const active = new Set(
    selectLiveLifecycleGroups({ groups: opts.pending, identities: births })
  );
  return opts.pending.filter((group) => {
    if (!active.has(group)) {
      return false;
    }
    const live = births.filter(
      (row) => !row.zombie && row.processGroupId === group
    );
    if (
      !(opts.members.get(group) ?? []).some(
        (member) =>
          !member.zombie &&
          live.some(
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

/** Retry one failed bounded identity read; no successful read still means unknown. */
async function readRetirementIdentities(
  read: () => Promise<ProcessIdentityRow[]>
): Promise<ProcessIdentityRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const identities = await read().catch(() => []);
    if (identities.length > 0) {
      return identities;
    }
  }
  return [];
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
