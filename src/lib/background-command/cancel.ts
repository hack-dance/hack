import { lstat } from "node:fs/promises";
import { createPrivateFileExclusive } from "../private-file.ts";
import { appendCommandAudit, auditEnd } from "./audit.ts";
import {
  type EventEnvelope,
  endedEvent,
  JournalWriter,
  readChild,
  readEvents,
  readOwner,
} from "./journal.ts";
import {
  identityMatches,
  type ObservedIdentity,
  observeIdentities,
  signalProcess,
  signalProcessGroup,
} from "./platform.ts";
import type { LoadedJournal } from "./reader.ts";
import { type ObserveIdentities, withJournalLock } from "./recovery.ts";

const SUPERVISOR_WAIT_MS = 6000;
const POLL_MS = 100;

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
     * Killing a `docker compose exec` or `run` client does not prove the
     * process inside the container stopped.
     */
    readonly containerProcess: "not_confirmed" | "not_applicable";
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
}): Promise<CancelResult> {
  const { meta, paths } = opts.journal;
  const observe = opts.observe ?? observeIdentities;
  const signaller = opts.signaller ?? realSignaller;
  const containerProcess =
    meta.backend === "compose" ? "not_confirmed" : "not_applicable";
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
        containerProcess,
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
  const { supervisorSignalled, childGroupSignalled, refused } = signalled;
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
    }));
  const after = child ? await observe([child.pid]) : new Map();
  const childExited =
    child === null ||
    (after !== null && !identityMatches({ expected: child, snapshot: after }));
  const outcome = finalEvent
    ? String(finalEvent.payload.outcome)
    : "cancelling";
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
      containerProcess,
    },
    refused,
  };
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
  readonly childGroupSignalled: boolean;
  readonly refused: ("supervisor" | "child")[];
} {
  const { owner, child, snapshot } = opts;
  const refused: ("supervisor" | "child")[] = [];
  if (!snapshot) {
    return { supervisorSignalled: false, childGroupSignalled: false, refused };
  }
  let supervisorSignalled = false;
  let childGroupSignalled = false;
  if (owner && identityMatches({ expected: owner, snapshot })) {
    supervisorSignalled = opts.signaller.process(owner.pid, "SIGTERM");
  } else if (owner && snapshot.has(owner.pid)) {
    refused.push("supervisor");
  }
  if (child && childGroupMatches({ child, snapshot })) {
    childGroupSignalled = opts.signaller.group(child.processGroupId, "SIGTERM");
  } else if (child && snapshot.has(child.pid)) {
    refused.push("child");
  }
  return { supervisorSignalled, childGroupSignalled, refused };
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

function cancelReason(opts: {
  readonly owner: boolean;
  readonly childGone: boolean;
}): string {
  if (!opts.childGone) {
    return "cancel_unconfirmed";
  }
  return opts.owner ? "supervisor_unresponsive" : "cancelled_before_start";
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
  if (child && childGroupMatches({ child, snapshot })) {
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
 * No supervisor recorded the end in time. Re-verify identities, force-stop
 * what still verifies, and write `cancelled` ourselves only once the
 * supervisor is provably gone (a live supervisor stays the only writer).
 */
async function finishWithoutSupervisor(opts: {
  readonly journal: LoadedJournal;
  readonly observe: ObserveIdentities;
  readonly signaller: Signaller;
  readonly containerProcess: "not_confirmed" | "not_applicable";
}): Promise<EventEnvelope | null> {
  const { paths, meta } = opts.journal;
  return await withJournalLock(paths, async () => {
    const events = await readEvents(paths);
    const existing = endedEvent(events);
    if (existing) {
      return existing;
    }
    const owner = await readOwner(paths);
    const stopped = await forceStopVerified({ ...opts, owner });
    if (!stopped.supervisorGone) {
      return null;
    }
    // The supervisor may have written up to the moment it died: re-read.
    const current = await readEvents(paths);
    const late = endedEvent(current);
    if (late) {
      return late;
    }
    const writer = new JournalWriter(paths, meta, current.at(-1)?.seq ?? 0);
    // `cancelled` only when the command's process is confirmed gone;
    // otherwise the outcome is not known.
    const ended = await writer.write("command.ended", {
      outcome: stopped.childGone ? "cancelled" : "unknown",
      reason: cancelReason({
        owner: owner !== null,
        childGone: stopped.childGone,
      }),
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, Date.now() - Date.parse(meta.acceptedAt)),
      truncated: false,
      suppressed: meta.capture === "metadata",
      containerProcess: opts.containerProcess,
    });
    await auditEnd({ paths, meta, payload: ended.payload });
    return ended;
  });
}
