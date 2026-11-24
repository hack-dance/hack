import { declaredComposeProfiles } from "../backends/native-profile-selection.ts";
import {
  type NativeProjectPsResult,
  nativeProjectPs,
} from "../backends/native-project-observe.ts";
import {
  isNativeForeignHomeRefusal,
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
  nativeForeignHomeRefusal,
  normalizeNativeProfiles,
} from "../backends/native-project-run.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";
import { completeUpTimings } from "../lib/command-timings.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveLifecycleComposeProjectName } from "../lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../lib/logs.ts";
import { readNativeComposeDocument } from "../lib/native-compose-backend-features.ts";
import {
  canPrintStartSelection,
  scopedHackCommand,
} from "../lib/printed-shell-command.ts";
import { type ProjectContext, readProjectConfig } from "../lib/project.ts";

/**
 * `hack up --detach` on a native project that is already up (HACK-2102).
 *
 * A detached native `up` launches a background foreground `up`. When the
 * project already has a live graph, that child refuses it and exits, and the
 * launcher could only report that startup "was not confirmed". On Compose the
 * same command is a successful no-op, and agents run it freely. So the
 * launcher first makes one read-only observation, the same one `hack ps`
 * makes, and answers from it when the project is already up.
 *
 * Only a confirmed state is answered here: a ready graph whose foreground
 * owner answered and whose runtime it verified. Every other state launches
 * exactly as before, so a start that is genuinely unconfirmed still reports
 * its own reason.
 */
export type NativeAlreadyRunning =
  /** Not a confirmed live, ready graph: launch as before. */
  | { readonly kind: "launch" }
  /** Every service is running, or is a one-shot that finished successfully. */
  | {
      readonly kind: "running";
      readonly started: string[];
      readonly completed: string[];
    }
  /** The graph is live and ready, but these services are not up. */
  | { readonly kind: "partial"; readonly down: string[] };

/** Byte-wise order, so output does not depend on the caller's locale. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export function classifyNativeAlreadyRunning(
  result: NativeProjectPsResult
): NativeAlreadyRunning {
  if (result.status !== "observed" || result.phase !== "ready-observed") {
    return { kind: "launch" };
  }
  const started: string[] = [];
  const completed: string[] = [];
  const down: string[] = [];
  for (const item of result.items) {
    if (
      item.state === "running" &&
      item.readiness !== "completed" &&
      (item.readiness === "healthy"
        ? item.health === "healthy"
        : item.health === null ||
          item.health === "none" ||
          item.health === "healthy")
    ) {
      started.push(item.service);
    } else if (
      item.readiness === "completed" &&
      item.state === "exited" &&
      item.exitCode === 0
    ) {
      completed.push(item.service);
    } else {
      down.push(item.service);
    }
  }
  if (started.length === 0 && completed.length === 0 && down.length === 0) {
    return { kind: "launch" };
  }
  return down.length > 0
    ? { kind: "partial", down: down.sort(byCodePoint) }
    : {
        kind: "running",
        started: started.sort(byCodePoint),
        completed: completed.sort(byCodePoint),
      };
}

/**
 * Native `up` starts a whole project and cannot start part of a running one.
 * Naming the services and the commands that do work replaces the launcher's
 * generic refusal; nothing was started or stopped.
 */
export function nativePartiallyRunningRefusal(
  down: readonly string[],
  restartCommand: string
): HackCliError {
  return new HackCliError({
    code: "E_STARTUP_INCOMPLETE",
    message: `Native project is already running, but these services have not reached their required state: ${down.join(", ")}. Native up cannot start part of a running project: run ${restartCommand}. Nothing was started or stopped.`,
  });
}

/** The successful no-op, in the same shape as a detached start that became ready. */
export function reportNativeAlreadyRunning(opts: {
  readonly json: boolean;
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly started: readonly string[];
  readonly completed: readonly string[];
  readonly startedAtMs: number;
  readonly restartCommand: string;
}): void {
  if (!opts.json) {
    process.stdout.write(
      `Project is already running. Configuration changes were not applied; run ${opts.restartCommand} to apply edits.\n`
    );
    return;
  }
  emitCliResult({
    result: okResult({
      data: {
        action: "up",
        alreadyRunning: true,
        project: opts.project,
        branch: opts.branch,
        composeProject: opts.composeProject,
        services: {
          started: [...opts.started],
          completed: [...opts.completed],
          stopped: [],
          failed: [],
        },
        timings: completeUpTimings(),
        durationMs: Date.now() - opts.startedAtMs,
      },
    }),
  });
}

export type NativeUpSelection = {
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly env?: string | null;
  readonly profiles?: readonly string[];
};

/** One shell-safe command targeting the same instance, without changing its env/profiles. */
export function nativeScopedCommand(opts: {
  readonly action: "restart" | "down";
  readonly singleLine?: boolean;
  readonly selection: NativeUpSelection;
}): string {
  if (opts.singleLine) {
    return scopedHackCommand(opts.action, {
      path: opts.selection.path,
      project: opts.selection.project,
      branch: opts.selection.branch,
    });
  }
  const words = ["hack", opts.action];
  for (const [key, value] of Object.entries({
    path: opts.selection.path,
    project: opts.selection.project,
    branch: opts.selection.branch,
  })) {
    if (value !== undefined) {
      words.push(`--${key}`, quoteShellWord(value));
    }
  }
  return words.join(" ");
}

function selectionMatches(
  saved: NativeProjectRun,
  requested: NativeUpSelection
): boolean {
  if (requested.env !== undefined && saved.effectiveEnvName !== requested.env) {
    return false;
  }
  return (
    requested.profiles === undefined ||
    (saved.profiles !== undefined &&
      JSON.stringify(normalizeNativeProfiles(saved.profiles)) ===
        JSON.stringify(normalizeNativeProfiles(requested.profiles)))
  );
}

/**
 * Explains a detached start whose child was not confirmed. A run mapping from
 * another native home can appear after the launcher's probe (another version
 * starting the same instance); the child's own refusal cannot cross IPC, so
 * re-inspect the mapping and return its coded refusal instead of the generic
 * `E_STARTUP_INCOMPLETE` (HACK-2339). Any other error is returned unchanged.
 */
export async function explainUnconfirmedNativeDetachedStart(opts: {
  readonly error: unknown;
  readonly scope: NativeProjectRunScope | null;
  readonly inspect?: (
    scope: NativeProjectRunScope
  ) => Promise<Error | undefined>;
}): Promise<unknown> {
  if (
    opts.scope === null ||
    !(opts.error instanceof HackCliError) ||
    opts.error.code !== "E_STARTUP_INCOMPLETE"
  ) {
    return opts.error;
  }
  const foreign = await (opts.inspect ?? nativeForeignHomeRefusal)(
    opts.scope
  ).catch(() => undefined);
  return foreign ?? opts.error;
}

/** Read-only admission adapter; resolving the CLI's project and branch stays injected. */
export async function answerNativeAlreadyRunning(opts: {
  readonly native: NativeRuntimeSelection;
  readonly json: boolean;
  readonly selection: NativeUpSelection;
  readonly resolveProject: () => Promise<ProjectContext>;
  readonly resolveBranch: (project: ProjectContext) => Promise<string | null>;
  readonly onBranchResolved?: (branch: string | null) => void;
  /**
   * Called before reporting an already-running graph, with its saved run:
   * for example to say that the environment now selects other profiles
   * than the ones the run keeps (HACK-2338 item 8). Notices go to stderr.
   */
  readonly notifyRunning?: (
    saved: NativeProjectRun,
    project: ProjectContext
  ) => Promise<void>;
}): Promise<number | null> {
  const startedAtMs = Date.now();
  let observed: {
    state: NativeAlreadyRunning;
    projectName: string;
    branch: string | null;
    matches: boolean;
    saved: NativeProjectRun;
    project: ProjectContext;
  };
  try {
    const project = await opts.resolveProject();
    const branch = await opts.resolveBranch(project);
    opts.onBranchResolved?.(branch);
    const scope = {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      nativeHome: opts.native.home,
      branch,
    };
    const result = await nativeProjectPs({
      runtime: opts.native,
      scope,
      includeReadiness: true,
    });
    const state = classifyNativeAlreadyRunning(result);
    if (state.kind === "launch") {
      return null;
    }
    const saved = await loadNativeProjectRun(scope);
    if (!saved || saved.run !== result.run) {
      return null;
    }
    const compose = await readNativeComposeDocument(project.composeFile);
    observed = {
      state,
      branch,
      saved,
      project,
      // Compose's `*` selects every declared profile; the saved run records
      // the expanded names.
      matches: selectionMatches(saved, {
        ...opts.selection,
        profiles: opts.selection.profiles?.includes("*")
          ? declaredComposeProfiles(compose)
          : opts.selection.profiles,
      }),
      projectName: await resolveComposeProjectName({
        project,
        cfg: await readProjectConfig(project),
        composeName: isRecord(compose)
          ? (getString(compose, "name") ?? null)
          : null,
      }),
    };
  } catch (error) {
    // A run mapping that another native home owns is a refusal, not "not
    // running": starting would fail in the child with no way out (HACK-2339).
    if (isNativeForeignHomeRefusal(error)) {
      throw error;
    }
    return null;
  }
  const selection = {
    ...opts.selection,
    branch: observed.branch ?? opts.selection.branch,
  };
  const restartCommand = nativeScopedCommand({ action: "restart", selection });
  if (!observed.matches) {
    const command = nativeScopedCommand({ action: "down", selection });
    throw new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `Native project is already running with a different or unknown environment/profile selection. Stop it with ${command}, then rerun this up command. Nothing was started or stopped.`,
      startBlocker: {
        thing: "project",
        problem: "already running with a different or unknown selection",
        needs: "this start needs the running instance stopped first",
        command: canPrintStartSelection(opts.selection)
          ? nativeScopedCommand({ action: "down", selection, singleLine: true })
          : undefined,
      },
    });
  }
  if (observed.state.kind === "partial") {
    throw nativePartiallyRunningRefusal(observed.state.down, restartCommand);
  }
  if (observed.state.kind === "running") {
    await opts.notifyRunning?.(observed.saved, observed.project);
    reportNativeAlreadyRunning({
      json: opts.json,
      project: observed.projectName,
      branch: observed.branch,
      composeProject: resolveLifecycleComposeProjectName({
        projectName: observed.projectName,
        branch: observed.branch,
      }),
      started: observed.state.started,
      completed: observed.state.completed,
      startedAtMs,
      restartCommand,
    });
  }
  return 0;
}
