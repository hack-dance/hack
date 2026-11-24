import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type NativeAuthoredProjectStatus,
  nativeAuthoredProjectPs,
} from "../backends/native-authored-project-observe.ts";
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
import { beginUpTiming, completeUpTimings } from "../lib/command-timings.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveLifecycleComposeProjectName } from "../lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../lib/logs.ts";
import { readNativeComposeDocument } from "../lib/native-compose-backend-features.ts";
import { selectNativeComposeProject } from "../lib/native-compose-selection.ts";
import { warmingItem } from "../lib/native-start-wait.ts";
import {
  canPrintStartSelection,
  scopedHackCommand,
} from "../lib/printed-shell-command.ts";
import { type ProjectContext, readProjectConfig } from "../lib/project.ts";
import { runtimeHostMetadataComposeProject } from "../lib/runtime-host-metadata.ts";

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
      /**
       * Running services whose own goal is not met yet, while the run is
       * `started-observed` (an `up` that returned at started); empty once ready.
       */
      readonly warming: string[];
      /** From the graph: `warming` while `started-observed`, else `ready`. */
      readonly readiness: "warming" | "ready";
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

type PsItem = NativeProjectPsResult["items"][number];

/** Running with its own goal met (a job's goal is completion, not running). */
function startedItem(item: PsItem): boolean {
  if (item.state !== "running" || item.readiness === "completed") {
    return false;
  }
  return item.readiness === "healthy"
    ? item.health === "healthy"
    : item.health === null ||
        item.health === "none" ||
        item.health === "healthy";
}

/**
 * One service of a live run. In `started-observed` (an `up` that returned at
 * started) a service still waiting on its health check is warming, not down.
 */
function classifyItem(
  item: PsItem,
  startedRun: boolean
): "started" | "completed" | "warming" | "down" {
  if (startedRun && warmingItem(item)) {
    return "warming";
  }
  if (startedItem(item)) {
    return "started";
  }
  return item.readiness === "completed" &&
    item.state === "exited" &&
    item.exitCode === 0
    ? "completed"
    : "down";
}

export function classifyNativeAlreadyRunning(
  result: NativeProjectPsResult
): NativeAlreadyRunning {
  const startedRun = result.phase === "started-observed";
  if (
    result.status !== "observed" ||
    !(startedRun || result.phase === "ready-observed")
  ) {
    return { kind: "launch" };
  }
  const by = { started: [], completed: [], warming: [], down: [] } as Record<
    "started" | "completed" | "warming" | "down",
    string[]
  >;
  for (const item of result.items) {
    by[classifyItem(item, startedRun)].push(item.service);
  }
  if (result.items.length === 0) {
    return { kind: "launch" };
  }
  return by.down.length > 0
    ? { kind: "partial", down: by.down.sort(byCodePoint) }
    : {
        kind: "running",
        started: by.started.sort(byCodePoint),
        completed: by.completed.sort(byCodePoint),
        warming: by.warming.sort(byCodePoint),
        readiness: startedRun ? "warming" : "ready",
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
  readonly warming?: readonly string[];
  /** From the graph phase; see `NativeAlreadyRunning`. */
  readonly readiness?: "warming" | "ready";
  readonly startedAtMs: number;
  readonly restartCommand: string;
}): void {
  const warming = opts.warming ?? [];
  if (!opts.json) {
    const still =
      warming.length > 0 ? ` ${warming.join(", ")} still warming.` : "";
    process.stdout.write(
      `Project is already running.${still} Configuration changes were not applied; run ${opts.restartCommand} to apply edits.\n`
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
          warming: [...warming],
          stopped: [],
          failed: [],
        },
        readiness: opts.readiness ?? "ready",
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

/** The last start failed after `up` returned: say so before starting again. */
function noteFailureAfterStarted(
  result: NativeProjectPsResult,
  json: boolean
): void {
  if (!result.failure || json) {
    return;
  }
  const { service, code, at } = result.failure;
  process.stderr.write(
    `The last start failed after up returned: ${service ?? "a service"} (${code}) at ${new Date(at * 1000).toISOString()}. Starting again.\n`
  );
}

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
  /**
   * The authored (`.hack/hack.project.json`) project this `up` selects, or
   * null for a Compose-file project. Authored projects are resolved before
   * `resolveProject`, which refuses them. Omitted: no authored answer.
   */
  readonly resolveAuthored?: () => Promise<NativeAuthoredUpSelection | null>;
  /** Test seam for the authored read-only observation. */
  readonly authoredPs?: typeof nativeAuthoredProjectPs;
}): Promise<number | null> {
  const startedAtMs = Date.now();
  const authored = await opts.resolveAuthored?.().catch(() => null);
  if (authored) {
    return await answerAuthoredAlreadyRunning({
      ...opts,
      authored,
      startedAtMs,
    });
  }
  let observed:
    | {
        state: NativeAlreadyRunning;
        projectName: string;
        branch: string | null;
        matches: boolean;
        saved: NativeProjectRun;
        project: ProjectContext;
        scope: NativeProjectRunScope;
      }
    | undefined;
  try {
    const selectionTiming = beginUpTiming("cli.project.selection");
    const project = await opts.resolveProject();
    const branch = await opts.resolveBranch(project);
    opts.onBranchResolved?.(branch);
    const scope = {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      nativeHome: opts.native.home,
      branch,
    };
    selectionTiming?.();
    const result = await nativeProjectPs({
      runtime: opts.native,
      scope,
      includeReadiness: true,
    });
    const state = classifyNativeAlreadyRunning(result);
    if (state.kind === "launch") {
      noteFailureAfterStarted(result, opts.json);
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
      scope,
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
  if (observed === undefined) {
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
    const state = observed.state;
    reportNativeAlreadyRunning({
      json: opts.json,
      project: observed.projectName,
      branch: observed.branch,
      composeProject: resolveLifecycleComposeProjectName({
        projectName: observed.projectName,
        branch: observed.branch,
      }),
      started: state.started,
      completed: state.completed,
      warming: state.warming,
      readiness: state.readiness,
      startedAtMs,
      restartCommand,
    });
  }
  return 0;
}

/** An authored project's root and instance, as authored dispatch selects them. */
export type NativeAuthoredUpSelection = {
  readonly projectRoot: string;
  /** `--branch` as given: authored commands use it unresolved. */
  readonly branch: string | null;
};

/**
 * The admitted project name of an authored project: the plan's `name`, the
 * `name` of `.hack/hack.project.json`. Null when it cannot be read, so the
 * start reports its own reason as before.
 */
export async function nativeAuthoredProjectName(
  projectRoot: string
): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(projectRoot, ".hack", "hack.project.json"), "utf8")
    );
    const name = isRecord(manifest) ? getString(manifest, "name") : undefined;
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** The authored selection of an `up`, before Compose-file project resolution. */
export async function selectNativeAuthoredUp(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
}): Promise<NativeAuthoredUpSelection | null> {
  const selected = await selectNativeComposeProject(opts);
  return selected
    ? { projectRoot: selected.projectRoot, branch: opts.branch ?? null }
    : null;
}

/** Authored status in the shape the already-running classifier reads. */
function authoredPsResult(
  status: NativeAuthoredProjectStatus
): NativeProjectPsResult {
  return {
    backend: "native",
    status: status.status === "observed" ? "observed" : "not_started",
    run: status.run,
    phase: status.phase,
    items: status.items.map((item) => ({
      ...item,
      phase: status.phase ?? "",
    })),
  };
}

/**
 * HACK-2620: `hack up -d` on an authored project that is already running.
 * The detached child refuses the live generation, and the launcher used to
 * report only `E_STARTUP_INCOMPLETE`. Answer from the same read-only status
 * `hack ps` makes, in the Compose-file path's shape. Anything but a confirmed
 * live, ready generation launches as before, and so does an env or profile
 * selection, which authored up refuses itself.
 */
async function answerAuthoredAlreadyRunning(opts: {
  readonly native: NativeRuntimeSelection;
  readonly json: boolean;
  readonly selection: NativeUpSelection;
  readonly authored: NativeAuthoredUpSelection;
  readonly startedAtMs: number;
  readonly authoredPs?: typeof nativeAuthoredProjectPs;
}): Promise<number | null> {
  if (
    opts.selection.env !== undefined ||
    opts.selection.profiles !== undefined
  ) {
    return null;
  }
  const { projectRoot, branch } = opts.authored;
  const projectName = await nativeAuthoredProjectName(projectRoot);
  if (projectName === null) {
    return null;
  }
  let state: NativeAlreadyRunning;
  try {
    state = classifyNativeAlreadyRunning(
      authoredPsResult(
        await (opts.authoredPs ?? nativeAuthoredProjectPs)({
          runtime: opts.native,
          scope: {
            projectRoot,
            projectDir: join(projectRoot, ".hack"),
            nativeHome: opts.native.home,
            branch,
          },
          includeReadiness: true,
        })
      )
    );
  } catch {
    return null;
  }
  if (state.kind === "launch") {
    return null;
  }
  const restartCommand = nativeScopedCommand({
    action: "restart",
    selection: { ...opts.selection, branch: branch ?? opts.selection.branch },
  });
  if (state.kind === "partial") {
    throw nativePartiallyRunningRefusal(state.down, restartCommand);
  }
  reportNativeAlreadyRunning({
    json: opts.json,
    project: projectName,
    branch,
    composeProject: runtimeHostMetadataComposeProject({ projectName, branch }),
    started: state.started,
    completed: state.completed,
    warming: state.warming,
    readiness: state.readiness,
    startedAtMs: opts.startedAtMs,
    restartCommand,
  });
  return 0;
}
