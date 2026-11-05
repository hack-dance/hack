import { HackCliError } from "../lib/cli-result.ts";
import {
  type LifecycleStateEntry,
  readLifecycleState,
} from "../lib/lifecycle-runtime.ts";
import {
  type ProjectSharedHelperConfig,
  resolveSharedHelperHolder,
  resolveSharedHelperStateDir,
} from "../lib/project-shared-helpers.ts";
import { readOwnedSharedHostProcess } from "../lib/shared-host-lifecycle.ts";
import { runMuxCommand } from "../mux/mux-backend.ts";
import { createTmuxBackend } from "../mux/tmux-backend.ts";

/**
 * Owner selectors for native host dependencies (`host_lifecycle` and
 * `host_shared_helper` in a dependency selection).
 *
 * Ownership contract:
 * - The owner is a process Hack itself started for this instance and still
 *   records: a persistent `up.before` hook or `lifecycle.processes` entry in the
 *   instance's tmux lifecycle session (pane PID, under a live session whose
 *   ownership token matches the lifecycle state), or a `lifecycle.sharedHelpers`
 *   entry with an `owned`, `ready` claim that lists this instance as a holder and
 *   whose PID and birth time are live. Adopted helpers, zellij sessions (no pane
 *   PID), sessions owned by another token and unknown names refuse.
 * - Resolution yields only a PID anchor. Native discovery then requires the
 *   listener to be that process or its descendant, and native review pins the
 *   anchor's native start time. `confirm` repeats the ownership proof after
 *   discovery, so a pane or helper that exited (and whose PID could be reused)
 *   between the two observations refuses instead of granting a stranger.
 * - Nothing here starts, adopts or signals a process, and refusals are closed
 *   messages that never include names, paths, PIDs or argv.
 */
export type NativeDependencyOwner = {
  readonly kind: "lifecycle" | "sharedHelper";
  readonly name: string;
};

export type NativeDependencyOwnerProof = {
  readonly pid: number;
  /** Re-prove the same live owner; throws the closed owner refusal. */
  readonly confirm: () => Promise<void>;
};

export type NativeDependencyOwnerResolver = (
  owner: NativeDependencyOwner
) => Promise<NativeDependencyOwnerProof>;

/** Fixed text: the named owner is not a live process Hack started for this instance. */
export const NATIVE_DEPENDENCY_OWNER_UNAVAILABLE =
  "Native host dependency owner is not a live lifecycle process or owned shared helper that Hack started for this instance; values omitted.";

/** Fixed text: the listener exists but is not in the owner's process tree. */
export const NATIVE_DEPENDENCY_OWNER_MISMATCH =
  "Native host dependency listener does not run under its selected owner; adopted, detached or foreign listeners are refused. Values omitted.";

export function nativeDependencyOwnerUnavailable(): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: NATIVE_DEPENDENCY_OWNER_UNAVAILABLE,
  });
}

export function nativeDependencyOwnerMismatch(): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: NATIVE_DEPENDENCY_OWNER_MISMATCH,
  });
}

/** True for the two closed owner refusals, which callers may surface unchanged. */
export function isNativeDependencyOwnerRefusal(error: unknown): boolean {
  return (
    error instanceof HackCliError &&
    (error.message === NATIVE_DEPENDENCY_OWNER_UNAVAILABLE ||
      error.message === NATIVE_DEPENDENCY_OWNER_MISMATCH)
  );
}

type Pane = { readonly pid: number; readonly dead: boolean };

export type NativeDependencyOwnerReaders = {
  readonly readState: (opts: {
    readonly projectDir: string;
  }) => Promise<readonly LifecycleStateEntry[]>;
  readonly readOwnerToken: (sessionName: string) => Promise<string | null>;
  /** Live panes of one lifecycle window; null when tmux cannot answer. */
  readonly readPanes: (opts: {
    readonly sessionName: string;
    readonly windowName: string;
  }) => Promise<readonly Pane[] | null>;
  readonly readHelper: (opts: {
    readonly helper: ProjectSharedHelperConfig;
    readonly holder: string;
  }) => Promise<{ readonly pid: number; readonly birth: string } | null>;
};

async function readTmuxPanes(opts: {
  readonly sessionName: string;
  readonly windowName: string;
}): Promise<readonly Pane[] | null> {
  const result = await runMuxCommand(
    [
      "tmux",
      "list-panes",
      "-t",
      `${opts.sessionName}:${opts.windowName}`,
      "-F",
      "#{pane_pid} #{pane_dead}",
    ],
    { stdin: "ignore" }
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const panes: Pane[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [pid, dead, extra] = trimmed.split(" ");
    const parsed = Number(pid);
    if (
      extra !== undefined ||
      !Number.isSafeInteger(parsed) ||
      parsed <= 1 ||
      (dead !== "0" && dead !== "1")
    ) {
      return null;
    }
    panes.push({ pid: parsed, dead: dead === "1" });
  }
  return panes;
}

const SYSTEM_READERS: NativeDependencyOwnerReaders = {
  readState: readLifecycleState,
  readOwnerToken: async (sessionName) =>
    (await createTmuxBackend().readLifecycleOwnerToken?.({
      name: sessionName,
    })) ?? null,
  readPanes: readTmuxPanes,
  readHelper: ({ helper, holder }) =>
    readOwnedSharedHostProcess({
      spec: {
        name: helper.name,
        stateDir: resolveSharedHelperStateDir({
          name: helper.name,
          port: helper.port,
        }),
      },
      holder,
    }),
};

function lifecycleAnchor(opts: {
  readonly entries: readonly LifecycleStateEntry[];
  readonly composeProject: string;
  readonly name: string;
}) {
  const entry = opts.entries.find(
    (candidate) => candidate.composeProject === opts.composeProject
  );
  if (!entry || entry.backend !== "tmux" || !entry.ownershipToken) {
    throw nativeDependencyOwnerUnavailable();
  }
  const matches = entry.processes.filter(
    (process) => process.name === opts.name
  );
  const process = matches[0];
  if (matches.length !== 1 || process?.panePid === undefined) {
    throw nativeDependencyOwnerUnavailable();
  }
  return {
    sessionName: entry.sessionName,
    ownershipToken: entry.ownershipToken,
    windowName: process.windowName,
    pid: process.panePid,
  };
}

/**
 * Resolve owner selectors for one instance. `sharedHelpers` is the instance's
 * parsed `lifecycle.sharedHelpers`; a name that is not configured and enabled
 * there refuses.
 */
export function createNativeDependencyOwnerResolver(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly sharedHelpers: readonly ProjectSharedHelperConfig[];
  readonly readers?: Partial<NativeDependencyOwnerReaders>;
}): NativeDependencyOwnerResolver {
  const readers = { ...SYSTEM_READERS, ...opts.readers };
  const lifecycle = async (
    name: string
  ): Promise<NativeDependencyOwnerProof> => {
    const prove = async () => {
      const anchor = lifecycleAnchor({
        entries: await readers.readState({ projectDir: opts.projectDir }),
        composeProject: opts.composeProject,
        name,
      });
      if (
        (await readers.readOwnerToken(anchor.sessionName)) !==
        anchor.ownershipToken
      ) {
        throw nativeDependencyOwnerUnavailable();
      }
      const panes = await readers.readPanes({
        sessionName: anchor.sessionName,
        windowName: anchor.windowName,
      });
      const pane = panes?.[0];
      if (panes?.length !== 1 || pane?.pid !== anchor.pid || pane.dead) {
        throw nativeDependencyOwnerUnavailable();
      }
      return anchor;
    };
    const first = await prove();
    return {
      pid: first.pid,
      confirm: async () => {
        const again = await prove();
        if (
          again.pid !== first.pid ||
          again.ownershipToken !== first.ownershipToken ||
          again.sessionName !== first.sessionName ||
          again.windowName !== first.windowName
        ) {
          throw nativeDependencyOwnerUnavailable();
        }
      },
    };
  };
  const sharedHelper = async (
    name: string
  ): Promise<NativeDependencyOwnerProof> => {
    const helpers = opts.sharedHelpers.filter(
      (candidate) => candidate.name === name && candidate.enabled
    );
    const helper = helpers[0];
    if (helpers.length !== 1 || !helper) {
      throw nativeDependencyOwnerUnavailable();
    }
    const holder = resolveSharedHelperHolder(opts.composeProject);
    const prove = async () => {
      const owned = await readers.readHelper({ helper, holder });
      if (!owned) {
        throw nativeDependencyOwnerUnavailable();
      }
      return owned;
    };
    const first = await prove();
    return {
      pid: first.pid,
      confirm: async () => {
        const again = await prove();
        if (again.pid !== first.pid || again.birth !== first.birth) {
          throw nativeDependencyOwnerUnavailable();
        }
      },
    };
  };
  return (owner) =>
    owner.kind === "lifecycle"
      ? lifecycle(owner.name)
      : sharedHelper(owner.name);
}
