import { lstat } from "node:fs/promises";
import { createPrivateFileExclusive } from "../private-file.ts";
import { appendCommandAudit, auditEnd } from "./audit.ts";
import {
  type EventEnvelope,
  emittedOffsets,
  endedEvent,
  type JournalPaths,
  JournalWriter,
  readChild,
  readEvents,
  readOwner,
  reconcileTail,
} from "./journal.ts";
import {
  identityMatches,
  type ObservedIdentity,
  observeIdentities,
  observeProcessGroup,
  type ProcessIdentity,
  signalProcess,
  signalProcessGroup,
} from "./platform.ts";
import type { LoadedJournal } from "./reader.ts";
import {
  childState,
  cutUnscannedOutput,
  dropUnscannedOutput,
  needsAtRestScrub,
  type ObserveIdentities,
  type ReadBootTime,
  withJournalLock,
} from "./recovery.ts";

const SUPERVISOR_WAIT_MS = 6000;
const POLL_MS = 100;
/**
 * Same grace the supervisor gives a group between SIGTERM and SIGKILL; also
 * how long the canceller then waits to confirm the KILL.
 */
const ORPHAN_STOP_GRACE_MS = 2000;

/** Seam for tests: the members of a process group (pid and birth). */
export type ObserveGroup = (
  processGroupId: number
) => Promise<readonly ProcessIdentity[] | null>;

export type CancelResult = {
  readonly commandId: string;
  readonly outcome: string;
  /** True when the command had already ended before this cancel. */
  readonly alreadyEnded: boolean;
  readonly confirmed: {
    /** The supervisor passed its pid+birth check and was signalled. */
    readonly supervisorSignalled: boolean;
    /** The child's process group passed its pid+birth+group check and was signalled. */
    readonly childGroupSignalled: boolean;
    /** No process with the child's pid and birth remains. */
    readonly childExited: boolean;
    /**
     * Killing a `docker compose exec` client does not prove the process
     * inside the container stopped (`not_confirmed`). For `run` the
     * supervisor also removes the one-off container (`stopped` when that is
     * confirmed).
     */
    readonly containerProcess: "stopped" | "not_confirmed" | "not_applicable";
    /**
     * With no live supervisor the canceller stops the group itself:
     * `stopped` when every member it recorded is confirmed gone,
     * `not_confirmed` when one may remain. `not_applicable` when a live
     * supervisor stopped the group (its final record says the same), or
     * when the command had already ended.
     */
    readonly descendants: "stopped" | "not_confirmed" | "not_applicable";
  };
  /** Identities that failed verification and were therefore not signalled. */
  readonly refused: readonly ("supervisor" | "child")[];
};

/** Seam for tests: signalling. */
export type Signaller = {
  readonly process: (pid: number, signal: NodeJS.Signals) => boolean;
  readonly group: (pgid: number, signal: NodeJS.Signals) => boolean;
};

const realSignaller: Signaller = {
  process: signalProcess,
  group: signalProcessGroup,
};

/**
 * Cancel a background command.
 *
 * A cancel request is persisted first, so the supervisor records `cancelled`
 * even if it misses the signal. Immediately before each signal the target's
 * pid and birth (and, for the child, its process group) are re-read and
 * compared with the journal; a reused pid is never signalled. The supervisor
 * is signalled so it records the outcome itself and cannot write a false
 * `failed` after its child is killed. If no supervisor is left to do that,
 * the canceller writes `command.ended` under the journal lock.
 */
export async function cancelCommand(opts: {
  readonly journal: LoadedJournal;
  readonly observe?: ObserveIdentities;
  readonly signaller?: Signaller;
  readonly waitMs?: number;
  /** Store root for the audit line (defaults to the Hack home). */
  readonly root?: string;
  readonly readBootTime?: ReadBootTime;
  readonly observeGroup?: ObserveGroup;
  readonly orphanGraceMs?: number;
}): Promise<CancelResult> {
  const { meta, paths } = opts.journal;
  const observe = opts.observe ?? observeIdentities;
  const observeGroup = opts.observeGroup ?? observeProcessGroup;
  const signaller = opts.signaller ?? realSignaller;
  // Neither backend's guest command is stopped by stopping its host client:
  // Compose `exec` and the native engine's exec both keep running.
  const containerProcess = "not_confirmed" as const;
  const before = await readEvents(paths);
  const priorEnd = endedEvent(before);
  if (priorEnd) {
    return {
      commandId: meta.commandId,
      outcome: String(priorEnd.payload.outcome),
      alreadyEnded: true,
      confirmed: {
        supervisorSignalled: false,
        childGroupSignalled: false,
        childExited: true,
        containerProcess:
          recordedContainerProcess(priorEnd) ?? containerProcess,
        descendants: "not_applicable",
      },
      refused: [],
    };
  }
  if (!(await lstat(paths.cancel).catch(() => null))) {
    await createPrivateFileExclusive({
      path: paths.cancel,
      text: JSON.stringify({ requestedAt: new Date().toISOString() }),
    }).catch(() => undefined);
  }
  const owner = await readOwner(paths);
  const child = await readChild(paths);
  const signalled = signalVerified({
    owner,
    child,
    snapshot: await observe([
      ...(owner ? [owner.pid] : []),
      ...(child ? [child.pid] : []),
    ]),
    signaller,
  });
  const { supervisorSignalled, refused } = signalled;
  // No live supervisor to stop the group: the canceller runs the same
  // sequence (record members, TERM, bounded wait, KILL), re-checking each
  // identity immediately before its signal.
  const orphan =
    signalled.orphanGroup && child
      ? await stopOrphanGroup({
          child,
          observe,
          observeGroup,
          signaller,
          graceMs: opts.orphanGraceMs ?? ORPHAN_STOP_GRACE_MS,
        })
      : null;
  const childGroupSignalled = orphan?.signalled ?? false;
  const finalEvent =
    (await waitForEnd({
      journal: opts.journal,
      waitMs: supervisorSignalled ? (opts.waitMs ?? SUPERVISOR_WAIT_MS) : 0,
    })) ??
    (await finishWithoutSupervisor({
      journal: opts.journal,
      observe,
      signaller,
      containerProcess,
      readBootTime: opts.readBootTime,
      descendants: orphan?.descendants,
      groupStopped: orphan !== null,
    }));
  const after = await observe(child ? [child.pid] : []);
  const childExited =
    after !== null &&
    (await childState({
      paths,
      meta,
      snapshot: after,
      readBootTime: opts.readBootTime,
    })) === "gone";
  // Without a final record: a live supervisor that is finishing (it wrote
  // the marker) reports `cancelling`; otherwise the stop is not confirmed
  // (for example the child's identity is unknown). Either way the command
  // keeps its slot.
  const outcome = finalEvent
    ? String(finalEvent.payload.outcome)
    : await pendingOutcome({ paths, observe });
  await appendCommandAudit({
    root: opts.root,
    entry: {
      event: "cancel",
      commandId: meta.commandId,
      operation: meta.operation,
      projectId: meta.projectId,
      instanceId: meta.instanceId,
      service: meta.service,
      caller: meta.caller,
      outcome,
    },
  });
  return {
    commandId: meta.commandId,
    outcome,
    alreadyEnded: false,
    confirmed: {
      supervisorSignalled,
      childGroupSignalled,
      childExited,
      containerProcess:
        finalEvent?.payload.containerProcess === "stopped"
          ? "stopped"
          : containerProcess,
      descendants: orphan?.descendants ?? "not_applicable",
    },
    refused,
  };
}

/**
 * A live supervisor that took the stop over (it wrote the marker) is still
 * working, for example removing a `run` container on a slow Docker: it is
 * left to finish rather than force-killed.
 */
async function supervisorFinishingStop(opts: {
  readonly paths: { readonly stopping: string };
  readonly owner: ObservedIdentity | null;
  readonly observe: ObserveIdentities;
}): Promise<boolean> {
  if (!(opts.owner && (await lstat(opts.paths.stopping).catch(() => null)))) {
    return false;
  }
  const alive = await opts.observe([opts.owner.pid]);
  return (
    alive !== null && identityMatches({ expected: opts.owner, snapshot: alive })
  );
}

/** The container result an end recorded, when it recorded a known one. */
function recordedContainerProcess(
  ended: EventEnvelope
): "stopped" | "not_confirmed" | "not_applicable" | undefined {
  const value = ended.payload.containerProcess;
  return value === "stopped" ||
    value === "not_confirmed" ||
    value === "not_applicable"
    ? value
    : undefined;
}

/** `cancelling` only while a live supervisor is finishing right now. */
async function pendingOutcome(opts: {
  readonly paths: JournalPaths;
  readonly observe: ObserveIdentities;
}): Promise<"cancelling" | "unconfirmed"> {
  return (await supervisorFinishingStop({
    paths: opts.paths,
    owner: await readOwner(opts.paths),
    observe: opts.observe,
  }))
    ? "cancelling"
    : "unconfirmed";
}

/**
 * SIGTERM the supervisor and the child's process group, each only if its pid
 * and birth (and, for the child, its group) match the journal right now. A
 * live pid with another birth is a reused pid: it is reported, never signalled.
 */
function signalVerified(opts: {
  readonly owner: ObservedIdentity | null;
  readonly child: ObservedIdentity | null;
  readonly snapshot: ReadonlyMap<number, ObservedIdentity> | null;
  readonly signaller: Signaller;
}): {
  readonly supervisorSignalled: boolean;
  /** No live supervisor took the stop, and the child's group verifies. */
  readonly orphanGroup: boolean;
  readonly refused: ("supervisor" | "child")[];
} {
  const { owner, child, snapshot } = opts;
  const refused: ("supervisor" | "child")[] = [];
  if (!snapshot) {
    return { supervisorSignalled: false, orphanGroup: false, refused };
  }
  let supervisorSignalled = false;
  let orphanGroup = false;
  if (owner && identityMatches({ expected: owner, snapshot })) {
    supervisorSignalled = opts.signaller.process(owner.pid, "SIGTERM");
  } else if (owner && snapshot.has(owner.pid)) {
    refused.push("supervisor");
  }
  // A live supervisor stops the group itself: it records the group's members
  // first, so descendants that ignore SIGTERM are still killed after the
  // leader exits. Signalling the group from here would race that.
  if (child && !supervisorSignalled && childGroupMatches({ child, snapshot })) {
    orphanGroup = true;
  } else if (
    child &&
    snapshot.has(child.pid) &&
    !childGroupMatches({ child, snapshot })
  ) {
    refused.push("child");
  }
  return { supervisorSignalled, orphanGroup, refused };
}

/**
 * Stop the child's group when no live supervisor will: the supervisor's own
 * sequence. Members are recorded (pid and birth) only while the leader still
 * verifies, since after it is gone its group id could be reused; when no
 * such snapshot was obtained, descendants are reported `not_confirmed`. SIGTERM
 * goes to the group, then after a bounded wait SIGKILL goes to the group if
 * its leader still verifies, and to each recorded member that still matches
 * (a descendant that ignored SIGTERM outlives its leader). Each identity is
 * re-checked immediately before its signal.
 */
async function stopOrphanGroup(opts: {
  readonly child: ObservedIdentity;
  readonly observe: ObserveIdentities;
  readonly observeGroup: ObserveGroup;
  readonly signaller: Signaller;
  readonly graceMs: number;
}): Promise<{
  readonly signalled: boolean;
  readonly descendants: "stopped" | "not_confirmed";
}> {
  const { child } = opts;
  const members = new Map<number, ProcessIdentity>([
    [child.pid, { pid: child.pid, birth: child.birth }],
  ]);
  // Descendants count as stopped only when at least one group snapshot was
  // validated (the leader verified before and after the read) and no read
  // failed. Without one, a descendant may be alive that was never recorded.
  let snapshotValidated = false;
  let readFailed = false;
  const membersKnown = (): boolean => snapshotValidated && !readFailed;
  const leaderVerifies = async (): Promise<boolean> => {
    const snapshot = await opts.observe([child.pid]);
    return snapshot !== null && childGroupMatches({ child, snapshot });
  };
  const remember = async (): Promise<void> => {
    if (!(await leaderVerifies())) {
      return;
    }
    const group = await opts.observeGroup(child.processGroupId);
    if (group === null) {
      readFailed = true;
      return;
    }
    // Read while the leader still verifies (checked again after the read):
    // these members belong to its group.
    if (await leaderVerifies()) {
      snapshotValidated = true;
      for (const member of group) {
        members.set(member.pid, member);
      }
    }
  };
  const survivors = async (): Promise<ProcessIdentity[] | null> => {
    const snapshot = await opts.observe([...members.keys()]);
    return snapshot
      ? [...members.values()].filter((member) =>
          identityMatches({ expected: member, snapshot })
        )
      : null;
  };

  await remember();
  const signalled =
    (await leaderVerifies()) &&
    opts.signaller.group(child.processGroupId, "SIGTERM");
  const termDeadline = Date.now() + opts.graceMs;
  while (Date.now() < termDeadline) {
    await Bun.sleep(POLL_MS);
    await remember();
    if ((await survivors())?.length === 0) {
      return {
        signalled,
        descendants: membersKnown() ? "stopped" : "not_confirmed",
      };
    }
  }
  await remember();
  if (await leaderVerifies()) {
    opts.signaller.group(child.processGroupId, "SIGKILL");
  }
  for (const member of (await survivors()) ?? []) {
    opts.signaller.process(member.pid, "SIGKILL");
  }
  const killDeadline = Date.now() + opts.graceMs;
  for (;;) {
    const left = await survivors();
    if (left?.length === 0) {
      return {
        signalled,
        descendants: membersKnown() ? "stopped" : "not_confirmed",
      };
    }
    if (Date.now() >= killDeadline) {
      return { signalled, descendants: "not_confirmed" };
    }
    await Bun.sleep(POLL_MS);
  }
}

function childGroupMatches(opts: {
  readonly child: ObservedIdentity;
  readonly snapshot: ReadonlyMap<number, ObservedIdentity>;
}): boolean {
  const row = opts.snapshot.get(opts.child.pid);
  return (
    row !== undefined &&
    row.birth === opts.child.birth &&
    row.processGroupId === opts.child.processGroupId
  );
}

/**
 * SIGKILL what still verifies and wait briefly for the supervisor to be gone.
 * `supervisorGone` is true only when no supervisor is left that could still
 * write; `childGone` only when no process with the child's identity remains.
 */
async function forceStopVerified(opts: {
  readonly journal: LoadedJournal;
  readonly owner: ObservedIdentity | null;
  readonly observe: ObserveIdentities;
  readonly signaller: Signaller;
  readonly killChildGroup: boolean;
}): Promise<{ readonly supervisorGone: boolean; readonly childGone: boolean }> {
  const { owner } = opts;
  const child = await readChild(opts.journal.paths);
  const snapshot = await opts.observe([
    ...(owner ? [owner.pid] : []),
    ...(child ? [child.pid] : []),
  ]);
  if (!snapshot) {
    return { supervisorGone: false, childGone: false };
  }
  if (owner && identityMatches({ expected: owner, snapshot })) {
    opts.signaller.process(owner.pid, "SIGKILL");
  }
  if (opts.killChildGroup && child && childGroupMatches({ child, snapshot })) {
    opts.signaller.group(child.processGroupId, "SIGKILL");
  }
  return await waitUntilGone({ owner, child, observe: opts.observe });
}

/** Poll up to 2 s until neither identity is alive; report what was confirmed. */
async function waitUntilGone(opts: {
  readonly owner: ObservedIdentity | null;
  readonly child: ObservedIdentity | null;
  readonly observe: ObserveIdentities;
}): Promise<{ readonly supervisorGone: boolean; readonly childGone: boolean }> {
  const { owner, child } = opts;
  const pids = [...(owner ? [owner.pid] : []), ...(child ? [child.pid] : [])];
  const deadline = Date.now() + 2000;
  let gone = { supervisorGone: false, childGone: false };
  for (;;) {
    const recheck = await opts.observe(pids);
    if (recheck) {
      gone = {
        supervisorGone: !(
          owner && identityMatches({ expected: owner, snapshot: recheck })
        ),
        childGone: !(
          child && identityMatches({ expected: child, snapshot: recheck })
        ),
      };
    }
    if ((gone.supervisorGone && gone.childGone) || Date.now() >= deadline) {
      return gone;
    }
    await Bun.sleep(POLL_MS);
  }
}

async function waitForEnd(opts: {
  readonly journal: LoadedJournal;
  readonly waitMs: number;
}): Promise<EventEnvelope | null> {
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    const ended = endedEvent(await readEvents(opts.journal.paths));
    if (ended || Date.now() >= deadline) {
      return ended;
    }
    await Bun.sleep(POLL_MS);
  }
}

/**
 * The end the dead supervisor wrote, if tail repair just published it. Its
 * output nobody scanned is cut first, adding no record (as recovery does).
 */
async function lateEnd(opts: {
  readonly journal: LoadedJournal;
  readonly events: readonly EventEnvelope[];
}): Promise<EventEnvelope | null> {
  const ended = endedEvent(opts.events);
  if (ended && needsAtRestScrub(opts.journal.meta)) {
    await dropUnscannedOutput({
      paths: opts.journal.paths,
      events: opts.events,
    });
  }
  return ended;
}

/**
 * Output nobody scanned cannot be redacted by a canceller: cut it (as
 * recovery does) before the final record. Returns the final record's
 * `truncated`.
 */
async function truncatedBeforeEnd(opts: {
  readonly journal: LoadedJournal;
  readonly events: readonly EventEnvelope[];
  readonly writer: JournalWriter;
}): Promise<boolean> {
  return needsAtRestScrub(opts.journal.meta)
    ? await cutUnscannedOutput({
        paths: opts.journal.paths,
        events: opts.events,
        writer: opts.writer,
      })
    : emittedOffsets(opts.events).truncated;
}

/**
 * No supervisor recorded the end in time. Re-verify identities, force-stop
 * what still verifies, and write `cancelled` ourselves only once the
 * supervisor is provably gone (a live supervisor stays the only writer).
 */
async function finishWithoutSupervisor(opts: {
  readonly journal: LoadedJournal;
  readonly observe: ObserveIdentities;
  readonly signaller: Signaller;
  readonly containerProcess: "not_confirmed" | "not_applicable";
  readonly readBootTime?: ReadBootTime;
  /** From the canceller's own group stop, when it ran one. */
  readonly descendants?: "stopped" | "not_confirmed";
  /** The canceller already ran the TERM/KILL sequence on the child's group. */
  readonly groupStopped?: boolean;
}): Promise<EventEnvelope | null> {
  const { paths, meta } = opts.journal;
  return await withJournalLock(paths, async () => {
    // Read only: the supervisor may still be alive and mid-write here.
    const existing = endedEvent(await readEvents(paths));
    if (existing) {
      return existing;
    }
    const owner = await readOwner(paths);
    if (
      await supervisorFinishingStop({ paths, owner, observe: opts.observe })
    ) {
      return null;
    }
    const stopped = await forceStopVerified({
      ...opts,
      owner,
      killChildGroup: opts.groupStopped !== true,
    });
    if (!stopped.supervisorGone) {
      return null;
    }
    // The supervisor may have written up to the moment it died.
    const current = await reconcileTail(paths);
    const late = await lateEnd({ journal: opts.journal, events: current });
    if (late) {
      return late;
    }
    // The supervisor is proven gone: output nobody scanned is cut now,
    // whether or not the child is, so cancel never leaves it on disk.
    const writer = new JournalWriter(paths, meta, current.at(-1)?.seq ?? 0);
    const truncated = await truncatedBeforeEnd({
      journal: opts.journal,
      events: current,
      writer,
    });
    const child = await readChild(paths);
    const snapshot = await opts.observe(child ? [child.pid] : []);
    const state = snapshot
      ? await childState({
          paths,
          meta,
          snapshot,
          readBootTime: opts.readBootTime,
        })
      : "unknown";
    if (state !== "gone") {
      // Alive or unknown: no final record, so admission and retention keep
      // treating the command as running.
      return null;
    }
    const ended = await writer.write("command.ended", {
      outcome: "cancelled",
      reason: owner ? "supervisor_unresponsive" : "cancelled_before_start",
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, Date.now() - Date.parse(meta.acceptedAt)),
      truncated,
      suppressed: meta.capture === "metadata",
      containerProcess: opts.containerProcess,
      ...(opts.descendants === "not_confirmed"
        ? { descendants: "not_confirmed" }
        : {}),
    });
    await auditEnd({ paths, meta, payload: ended.payload });
    return ended;
  });
}
