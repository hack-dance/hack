import {
  type NativeProjectPsResult,
  nativeProjectPs,
} from "../backends/native-project-observe.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  normalizeNativeProfiles,
} from "../backends/native-project-run.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveLifecycleComposeProjectName } from "../lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../lib/logs.ts";
import { readNativeComposeDocument } from "../lib/native-compose-backend-features.ts";
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
        : item.health === null || item.health === "healthy")
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
        durationMs: Date.now() - opts.startedAtMs,
      },
    }),
  });
}

export type NativeUpSelection = {
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly env?: string;
  readonly profiles?: readonly string[];
};

/** One shell-safe command targeting the same instance, without changing its env/profiles. */
export function nativeScopedCommand(opts: {
  readonly action: "restart" | "down";
  readonly selection: NativeUpSelection;
}): string {
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

/** Read-only admission adapter; resolving the CLI's project and branch stays injected. */
export async function answerNativeAlreadyRunning(opts: {
  readonly native: NativeRuntimeSelection;
  readonly json: boolean;
  readonly selection: NativeUpSelection;
  readonly resolveProject: () => Promise<ProjectContext>;
  readonly resolveBranch: (project: ProjectContext) => Promise<string | null>;
  readonly onBranchResolved?: (branch: string | null) => void;
}): Promise<number | null> {
  const startedAtMs = Date.now();
  let observed: {
    state: NativeAlreadyRunning;
    projectName: string;
    branch: string | null;
    matches: boolean;
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
      matches: selectionMatches(saved, opts.selection),
      projectName: await resolveComposeProjectName({
        project,
        cfg: await readProjectConfig(project),
        composeName: isRecord(compose)
          ? (getString(compose, "name") ?? null)
          : null,
      }),
    };
  } catch {
    return null;
  }
  const selection = {
    ...opts.selection,
    branch: observed.branch ?? opts.selection.branch,
  };
  const restartCommand = nativeScopedCommand({ action: "restart", selection });
  if (!observed.matches) {
    throw new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `Native project is already running with a different or unknown environment/profile selection. Stop it with ${nativeScopedCommand({ action: "down", selection })}, then rerun this up command. Nothing was started or stopped.`,
    });
  }
  if (observed.state.kind === "partial") {
    throw nativePartiallyRunningRefusal(observed.state.down, restartCommand);
  }
  if (observed.state.kind === "running") {
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
