import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { nativeAuthoredExecOptions } from "../backends/native-authored-exec-options.ts";
import { nativeAuthoredProjectExec } from "../backends/native-authored-project-exec.ts";
import {
  nativeAuthoredLogsOptions,
  nativeAuthoredProjectLogs,
} from "../backends/native-authored-project-logs.ts";
import {
  type NativeAuthoredProjectStatus,
  nativeAuthoredProjectPs,
} from "../backends/native-authored-project-observe.ts";
import { nativeAuthoredProjectRun } from "../backends/native-authored-project-oneoff.ts";
import { recoverNativeAuthoredProject } from "../backends/native-authored-project-recovery.ts";
import {
  NativeAuthoredProjectRestartError,
  restartNativeAuthoredProject,
} from "../backends/native-authored-project-restart.ts";
import {
  type NativeAuthoredProjectRunScope,
  stopNativeAuthoredProject,
} from "../backends/native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  serveNativeAuthoredProject,
} from "../backends/native-authored-project-start.ts";
import {
  nativeAuthoredUnreservedStartSelected,
  retireNativeAuthoredUnreservedStart,
} from "../backends/native-authored-unreserved-start.ts";
import { resolveNativeAuthoredExecStaleEnvWarning } from "../backends/native-exec-stale-env.ts";
import { parseNativeHttpsSelection } from "../backends/native-project-start.ts";
import {
  isNativeRuntimeNotRunning,
  NATIVE_RUNTIME_NOT_RUNNING,
  nativeCodesReportRuntimeNotRunning,
  resolveNativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import { CliUsageError } from "../cli/command.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";
import { emitCliResult, HackCliError, okResult } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import type { NativeComposeCommandOptions } from "./native-compose-command.ts";
import type { NativeComposeSelection } from "./native-compose-selection.ts";
import {
  createNativeEnvFingerprintEntry,
  createNativeEnvFingerprintSession,
  type NativeEnvFingerprintSession,
} from "./native-env-fingerprint-state.ts";
import { nativeForegroundDetachRefusal } from "./native-up-refusals.ts";

function unsupported(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native authored execution requires whole-project foreground up or restart, owner-mediated down, ps, finite single-service logs --no-follow, noninteractive single-service exec or run, or explicit stored-generation down --recover on macOS. This request ran no input or runtime operation.",
  });
}

function assertLogsOptions(options: NativeComposeCommandOptions): void {
  if (
    process.platform !== "darwin" ||
    options.operation !== "logs" ||
    options.follow !== false ||
    !nativeAuthoredLogsOptions(options.service, options.tail ?? 200) ||
    options.recover ||
    options.detach ||
    options.unsupportedOptions ||
    options.services !== undefined ||
    options.command !== undefined ||
    options.workdir !== undefined ||
    options.profiles !== undefined ||
    options.overlay !== undefined ||
    (options.logFormat !== undefined &&
      options.logFormat !== (options.json ? "json" : "plain"))
  ) {
    unsupported();
  }
}

async function runAuthoredLogs(input: {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly runtime: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
  readonly logs: typeof nativeAuthoredProjectLogs;
}): Promise<number> {
  const { options, runtime, logs } = input;
  const service = options.service;
  if (typeof service !== "string") {
    return unsupported();
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const root = await realpath(input.projectRoot);
    const result = await logs({
      runtime,
      scope: {
        projectRoot: root,
        projectDir: join(root, ".hack"),
        nativeHome: runtime.home,
        branch: options.instance ?? null,
      },
      service,
      tail: options.tail,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      return 130;
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      return 130;
    }
    if (isNativeRuntimeNotRunning(error)) {
      throw new HackCliError({
        code: "E_DOCKER_UNAVAILABLE",
        message:
          "Native runtime is not running; no service logs are available. Start the native runtime and retry.",
      });
    }
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native authored logs are unavailable or their owner/selection changed; values omitted.",
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

function assertStatusOptions(options: NativeComposeCommandOptions): void {
  if (
    process.platform !== "darwin" ||
    options.operation !== "ps" ||
    options.detach ||
    options.recover ||
    options.unsupportedOptions ||
    options.services !== undefined ||
    options.service !== undefined ||
    options.command !== undefined ||
    options.workdir !== undefined ||
    options.follow !== undefined ||
    options.tail !== undefined ||
    options.logFormat !== undefined ||
    options.profiles !== undefined ||
    options.overlay !== undefined
  ) {
    unsupported();
  }
}

function assertRecoveryOptions(options: NativeComposeCommandOptions): void {
  if (
    process.platform !== "darwin" ||
    options.operation !== "down" ||
    !options.recover ||
    options.detach ||
    options.json ||
    options.unsupportedOptions ||
    options.services !== undefined ||
    options.service !== undefined ||
    options.command !== undefined ||
    options.workdir !== undefined ||
    options.follow !== undefined ||
    options.tail !== undefined ||
    options.logFormat !== undefined ||
    options.profiles !== undefined ||
    options.overlay !== undefined
  ) {
    unsupported();
  }
}

function assertForegroundOptions(options: NativeComposeCommandOptions): void {
  // Where authored foreground up/restart is supported, a detached start gets
  // the same one-line refusal as an image project, not the generic one.
  if (
    process.platform === "darwin" &&
    options.detach &&
    (options.operation === "up" || options.operation === "restart")
  ) {
    throw nativeForegroundDetachRefusal({
      restart: options.operation === "restart",
    });
  }
  if (
    process.platform !== "darwin" ||
    !["up", "down", "restart"].includes(options.operation) ||
    options.detach ||
    options.json ||
    options.recover ||
    options.unsupportedOptions ||
    options.services?.length ||
    options.service !== undefined ||
    options.command !== undefined ||
    options.workdir !== undefined ||
    options.follow !== undefined ||
    options.tail !== undefined ||
    options.logFormat !== undefined ||
    (options.operation === "down" &&
      (options.profiles !== undefined ||
        options.overlay !== undefined ||
        options.services !== undefined))
  ) {
    unsupported();
  }
}

function startupFailure(error: unknown): number {
  if (error instanceof NativeAuthoredProjectStartError) {
    if (
      error.canceled &&
      (error.outcome === "removed" || error.outcome === "unreserved")
    ) {
      return 130;
    }
    if (nativeCodesReportRuntimeNotRunning(error)) {
      throw stoppedRuntimeStartup(error);
    }
    throw new HackCliError({
      code:
        error.nativeCode === "native_graph_subset"
          ? "E_NATIVE_PROJECT_UNSUPPORTED"
          : "E_STARTUP_INCOMPLETE",
      message: error.message,
      detail: {
        outcome: error.outcome,
        canceled: error.canceled,
        stage: error.stage,
        ...(error.compilerCode ? { compilerCode: error.compilerCode } : {}),
        ...(error.nativeCode ? { nativeCode: error.nativeCode } : {}),
      },
    });
  }
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message: "Native authored startup selection is invalid; values omitted.",
  });
}

/**
 * A start refused because the candidate runtime is stopped reports that cause
 * directly, as logs does, with the next action. When nothing was reserved
 * (`not-started`), `ps` keeps reporting `not_started`. A start that reserved
 * its intent before the runtime stopped keeps that evidence, so `ps` reports
 * `pending` until the retained attempt is inspected. A start whose consumer
 * never reserved runtime state (`unreserved`) had its intent retired, so `ps`
 * reports `not_started`.
 */
function stoppedRuntimeStartup(
  error: NativeAuthoredProjectStartError
): HackCliError {
  const message = {
    "not-started":
      "Native runtime is not running; nothing was started. Start the native runtime, then run this command again.",
    removed:
      "Native runtime is not running; this start did not stay up and its native cleanup was confirmed. Start the native runtime, then run this command again.",
    unreserved:
      "Native runtime is not running; this start never reserved runtime state and its startup intent was retired, so `hack ps` reports not_started. Start the native runtime, then run this command again.",
    retained:
      "Native runtime is not running; this start did not reach Ready and its startup evidence is retained, so `hack ps` reports it as pending. Start the native runtime and inspect owned state before retrying.",
  }[error.outcome];
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message,
    detail: {
      outcome: error.outcome,
      canceled: error.canceled,
      stage: error.stage,
      nativeCode: NATIVE_RUNTIME_NOT_RUNNING,
    },
  });
}

/** Stop refusals keep the generation; start refusals keep the foreground up contract. */
function restartFailure(error: unknown): number {
  if (
    error instanceof NativeAuthoredProjectRestartError &&
    error.phase === "start"
  ) {
    if (error.startup) {
      return startupFailure(error.startup);
    }
    if (error.canceled) {
      logger.info({
        message:
          "Native project restart was canceled after its proven stop; nothing was restarted and persistent data is retained.",
      });
      return 130;
    }
    return startupFailure(error);
  }
  throw new HackCliError({
    code: "E_LIFECYCLE_FAILED",
    message:
      "Native project restart could not prove the current generation stopped or its ownership changed; nothing was restarted and selected state is retained. Values omitted.",
  });
}

type Mode =
  | "exec"
  | "run"
  | "status"
  | "recovery"
  | "stop"
  | "start"
  | "restart"
  | "logs";
const FOREGROUND_MODES: Readonly<
  Partial<Record<NativeComposeCommandOptions["operation"], Mode>>
> = {
  up: "start",
  down: "stop",
  restart: "restart",
};
function commandMode(options: NativeComposeCommandOptions): Mode {
  if (options.operation === "exec" || options.operation === "run") {
    assertCommandOptions(options, options.operation);
    return options.operation;
  }
  if (options.operation === "logs") {
    assertLogsOptions(options);
    return "logs";
  }
  if (options.operation === "ps") {
    assertStatusOptions(options);
    return "status";
  }
  if (options.operation === "down" && options.recover === true) {
    assertRecoveryOptions(options);
    return "recovery";
  }
  assertForegroundOptions(options);
  return FOREGROUND_MODES[options.operation] ?? unsupported();
}

const STATUS_NOTES: Readonly<
  Record<Exclude<NativeAuthoredProjectStatus["status"], "observed">, string>
> = {
  not_started: "Native project has not been started.",
  pending:
    "Native project startup is pending: a start reserved its intent but has not reached Ready (it is still starting, or it failed and its startup evidence is retained). No current service status is confirmed. If no startup is running, `hack down --recover` retires an attempt that never reserved runtime state.",
  runtime_not_running:
    "Native runtime is not running; no services are running.",
};

async function showStatus(options: {
  readonly result: NativeAuthoredProjectStatus;
  readonly json?: boolean;
}): Promise<void> {
  const { result } = options;
  if (options.json) {
    emitCliResult({ result: okResult({ data: result }) });
    return;
  }
  if (result.status !== "observed") {
    logger.info({ message: STATUS_NOTES[result.status] });
  }
  await display.table({
    columns: ["NATIVE SERVICE", "CONTAINER", "STATE", "HEALTH"],
    rows: result.items.map((item) => [
      item.service,
      item.container,
      item.state,
      item.health ?? "",
    ]),
  });
}

function commandFailure(options: {
  readonly error: unknown;
  readonly mode: Mode;
  readonly signal: AbortSignal;
}): number {
  if (options.mode === "status") {
    if (options.signal.aborted) {
      return 130;
    }
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native project status is unconfirmed or its ownership changed; values omitted. No request was replayed.",
    });
  }
  if (options.mode === "recovery" || options.mode === "stop") {
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native project recovery is incomplete or its ownership changed; selected state is retained. Values omitted.",
    });
  }
  if (options.mode === "restart") {
    return restartFailure(options.error);
  }
  return startupFailure(options.error);
}

function captureCommandOptions(
  options: NativeComposeCommandOptions
): NativeComposeCommandOptions {
  return {
    ...options,
    profiles:
      options.profiles === undefined ? undefined : [...options.profiles],
    services:
      options.services === undefined ? undefined : [...options.services],
    command: options.command === undefined ? undefined : [...options.command],
  };
}

type Seams = {
  /** Execution seam for command-selection controls; the CLI always uses the real owner. */
  readonly serve?: typeof serveNativeAuthoredProject;
  readonly recover?: typeof recoverNativeAuthoredProject;
  /** Pending-start selection and unreserved retirement seams (HACK-1272). */
  readonly unreservedSelected?: typeof nativeAuthoredUnreservedStartSelected;
  readonly retireUnreserved?: typeof retireNativeAuthoredUnreservedStart;
  readonly observe?: typeof nativeAuthoredProjectPs;
  readonly logs?: typeof nativeAuthoredProjectLogs;
  readonly stop?: typeof stopNativeAuthoredProject;
  readonly exec?: typeof nativeAuthoredProjectExec;
  readonly run?: typeof nativeAuthoredProjectRun;
  /** Advisory stale-env seam; the CLI always uses the real resolver. */
  readonly staleEnv?: typeof resolveNativeAuthoredExecStaleEnvWarning;
  /** Test seam for the advisory bound; the CLI always uses the default. */
  readonly staleEnvTimeoutMs?: number;
};
type Runtime = NonNullable<ReturnType<typeof resolveNativeRuntimeSelection>>;
type RunnerInput = {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly runtime: Runtime;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly seams: Seams;
};
type LifecycleInput = RunnerInput & {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly startupTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly forceSignal: AbortSignal;
};

async function runStatus(input: LifecycleInput): Promise<number> {
  const result = await (input.seams.observe ?? nativeAuthoredProjectPs)({
    runtime: input.runtime,
    scope: input.scope,
    signal: input.signal,
  });
  if (input.signal.aborted) {
    return 130;
  }
  await showStatus({ result, json: input.options.json });
  return 0;
}

async function runRecovery(input: LifecycleInput): Promise<number> {
  if (
    await (
      input.seams.unreservedSelected ?? nativeAuthoredUnreservedStartSelected
    )(input.scope)
  ) {
    // A startup intent without a Ready generation: only a provably unreserved
    // attempt is retired; every other retained attempt refuses unchanged.
    await (input.seams.retireUnreserved ?? retireNativeAuthoredUnreservedStart)(
      {
        runtime: input.runtime,
        scope: input.scope,
        timeoutMs: input.startupTimeoutMs,
        signal: input.signal,
      }
    );
    logger.info({
      message:
        "Retired an incomplete native startup that never reserved runtime state; nothing else was changed.",
    });
    return 0;
  }
  await (input.seams.recover ?? recoverNativeAuthoredProject)({
    runtime: input.runtime,
    scope: input.scope,
    timeoutMs: input.startupTimeoutMs,
    signal: input.signal,
  });
  logger.info({
    message: "Selected native project recovered; persistent data is retained.",
  });
  return 0;
}

async function runStop(input: LifecycleInput): Promise<number> {
  await (input.seams.stop ?? stopNativeAuthoredProject)({
    scope: input.scope,
    timeoutMs: input.startupTimeoutMs,
    signal: input.signal,
  });
  logger.info({
    message: "Selected native project stopped; persistent data is retained.",
  });
  return 0;
}

/**
 * The native HTTPS frontend port selected the same way native image projects
 * select it, so authored runtime host metadata URLs carry the same port.
 */
function nativeHttpsPort(
  env: Readonly<Record<string, string | undefined>>
): number | null {
  try {
    return parseNativeHttpsSelection(env)?.httpsPort ?? null;
  } catch {
    throw new CliUsageError(
      "Native HTTPS selection requires HACK_NATIVE_CADDY_BINARY, HACK_NATIVE_CADDY_SHA256 and HACK_NATIVE_HTTPS_PORT together; values omitted."
    );
  }
}

/** Value-free stale-env bookkeeping for one foreground lifetime (HACK-1140). */
function envFingerprintSession(
  input: LifecycleInput
): NativeEnvFingerprintSession {
  return createNativeEnvFingerprintSession({
    projectDir: input.scope.projectDir,
    owner: "authored",
    branch: input.scope.branch,
  });
}

/**
 * Fresh foreground selection shared by up and the start half of restart. The
 * delivered env selection is captured as value-free digests and recorded once
 * the run is ready, so exec can warn when the env resolved later differs.
 */
function startupSelection(
  input: LifecycleInput,
  envFingerprints: NativeEnvFingerprintSession
): Parameters<typeof serveNativeAuthoredProject>[0] {
  const run = randomBytes(16).toString("hex");
  return {
    runtime: input.runtime,
    scope: input.scope,
    run,
    profiles: input.options.profiles,
    overlay: input.options.overlay,
    onEnvironmentSelected: (fingerprint) => {
      envFingerprints.capture(
        createNativeEnvFingerprintEntry({
          owner: "authored",
          run,
          fingerprint,
          selection: {
            ...(input.options.overlay === undefined
              ? {}
              : { overlay: input.options.overlay }),
            ...(input.options.profiles === undefined
              ? {}
              : { profiles: input.options.profiles }),
          },
        })
      );
      return undefined;
    },
    httpsPort: nativeHttpsPort(input.env),
    startupTimeoutMs: input.startupTimeoutMs,
    signal: input.signal,
    forceSignal: input.forceSignal,
    onHookDiagnostic: (event) => {
      if (event.boundary === "failed" || event.boundary === "stop-operation") {
        logger.error({
          message:
            "Native lifecycle hook stop is incomplete; the foreground owner and selected state are retained. Values omitted.",
        });
      }
    },
    onReady: () => {
      envFingerprints.commit();
      logger.info({ message: "Project is ready. Press Ctrl-C to stop." });
      return undefined;
    },
  };
}

async function runStart(input: LifecycleInput): Promise<number> {
  const envFingerprints = envFingerprintSession(input);
  try {
    return await (input.seams.serve ?? serveNativeAuthoredProject)(
      startupSelection(input, envFingerprints)
    );
  } finally {
    await envFingerprints.release();
  }
}

async function runRestart(input: LifecycleInput): Promise<number> {
  const envFingerprints = envFingerprintSession(input);
  try {
    return await restartNativeAuthoredProject({
      ...startupSelection(input, envFingerprints),
      onStopped: () => {
        // The stopped run's record is stale; a failed start leaves none.
        envFingerprints.drop();
        logger.info({
          message:
            "Selected native project stopped; persistent data is retained. Starting a fresh foreground generation.",
        });
        return undefined;
      },
      dependencies: { stop: input.seams.stop, serve: input.seams.serve },
    });
  } finally {
    await envFingerprints.release();
  }
}

/** Two-stage cancellation and the bounded startup budget shared by the lifecycle modes. */
async function runAuthoredLifecycle(
  input: RunnerInput,
  mode: Exclude<Mode, "exec" | "run" | "logs">,
  action: (lifecycle: LifecycleInput) => Promise<number>
): Promise<number> {
  const startupTimeoutMs =
    mode === "status"
      ? 15_000
      : resolveComposeStartupTimeoutMs({ env: input.env });
  if (startupTimeoutMs > 300_000) {
    throw new CliUsageError(
      "Native authored startup supports at most 300000 milliseconds (HACK_COMPOSE_STARTUP_TIMEOUT_MS)."
    );
  }
  const controller = new AbortController();
  const forceController = new AbortController();
  const cancel = () =>
    (controller.signal.aborted ? forceController : controller).abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const root = await realpath(input.projectRoot);
    return await action({
      ...input,
      scope: {
        projectRoot: root,
        projectDir: join(root, ".hack"),
        nativeHome: input.runtime.home,
        branch: input.options.instance ?? null,
      },
      startupTimeoutMs,
      signal: controller.signal,
      forceSignal: forceController.signal,
    });
  } catch (error: unknown) {
    return commandFailure({ error, mode, signal: controller.signal });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

const RUNNERS: Readonly<Record<Mode, (input: RunnerInput) => Promise<number>>> =
  {
    exec: (input) =>
      runAuthoredCommand({
        options: input.options,
        projectRoot: input.projectRoot,
        runtime: input.runtime,
        perform: input.seams.exec ?? nativeAuthoredProjectExec,
        contract: COMMAND_CONTRACTS.exec,
        beforeOutput: (signal) => warnStaleAuthoredEnv(input, signal),
      }),
    run: (input) =>
      runAuthoredCommand({
        options: input.options,
        projectRoot: input.projectRoot,
        runtime: input.runtime,
        perform: input.seams.run ?? nativeAuthoredProjectRun,
        contract: COMMAND_CONTRACTS.run,
      }),
    logs: (input) =>
      runAuthoredLogs({
        options: input.options,
        projectRoot: input.projectRoot,
        runtime: input.runtime,
        logs: input.seams.logs ?? nativeAuthoredProjectLogs,
      }),
    status: (input) => runAuthoredLifecycle(input, "status", runStatus),
    recovery: (input) => runAuthoredLifecycle(input, "recovery", runRecovery),
    stop: (input) => runAuthoredLifecycle(input, "stop", runStop),
    start: (input) => runAuthoredLifecycle(input, "start", runStart),
    restart: (input) => runAuthoredLifecycle(input, "restart", runRestart),
  };

/**
 * Upper bound on the advisory stale-env resolution of one authored exec. Past
 * it, or on cancellation, the exec output is written without a warning.
 */
export const NATIVE_AUTHORED_EXEC_STALE_ENV_TIMEOUT_MS = 5000;

/**
 * Advisory stale-env check for an admitted authored exec (HACK-1140). It reads
 * the value-free record of the current run and, only when one exists, resolves
 * the same env selection again. The resolution receives the exec's cancellation
 * signal bounded by {@link NATIVE_AUTHORED_EXEC_STALE_ENV_TIMEOUT_MS}, and the
 * check settles as soon as that signal aborts even if the resolution has not.
 * The closed warning goes to stderr ahead of the captured output; stdout stays
 * the command's output. It never changes the exec or its exit code.
 */
async function warnStaleAuthoredEnv(
  input: RunnerInput,
  signal: AbortSignal
): Promise<void> {
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(
      input.seams.staleEnvTimeoutMs ?? NATIVE_AUTHORED_EXEC_STALE_ENV_TIMEOUT_MS
    ),
  ]);
  let root: string;
  try {
    root = await realpath(input.projectRoot);
  } catch {
    return;
  }
  const warning = await settleBeforeAbort(
    (input.seams.staleEnv ?? resolveNativeAuthoredExecStaleEnvWarning)({
      scope: {
        projectRoot: root,
        projectDir: join(root, ".hack"),
        nativeHome: input.runtime.home,
        branch: input.options.instance ?? null,
      },
      service: input.options.service ?? "",
      signal: bounded,
    }),
    bounded
  );
  if (warning) {
    process.stderr.write(`WARNING: ${warning}\n`);
  }
}

/**
 * The advisory value, or null once `signal` aborts or the work fails. The
 * abandoned work keeps its own signal and settles on its own; nothing waits
 * for it.
 */
function settleBeforeAbort(
  work: Promise<string | null>,
  signal: AbortSignal
): Promise<string | null> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      }
    );
  });
}

/**
 * Explicit native dispatch after exact authored-family and adoption selection.
 * Compose and omitted selections retain their existing owner. Foreground up delegates
 * to the tagged lifetime owner; ordinary down uses its authenticated stop. Foreground
 * restart sequences that same stop before a fresh foreground up with the given
 * selection. Ps and finite service logs observe its saved run; finite exec and
 * one-off run send one command through its live owner (a completed exec may
 * resolve its run's recorded env selection again, for an advisory value-free
 * stale-env warning only);
 * explicit down --recover uses the stored cleanup owner without input acquisition.
 * Unsupported requests never start input acquisition or runtime work.
 */
export async function tryNativeAuthoredCommand(
  opts: Seams & {
    readonly options: NativeComposeCommandOptions;
    readonly selected: NativeComposeSelection;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }
): Promise<number | null> {
  const sourceEnv = opts.env ?? process.env;
  const env = {
    HACK_RUNTIME_BACKEND: sourceEnv.HACK_RUNTIME_BACKEND,
    HACK_NATIVE_BINARY: sourceEnv.HACK_NATIVE_BINARY,
    HACK_NATIVE_HOME: sourceEnv.HACK_NATIVE_HOME,
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: sourceEnv.HACK_COMPOSE_STARTUP_TIMEOUT_MS,
    HACK_NATIVE_CADDY_BINARY: sourceEnv.HACK_NATIVE_CADDY_BINARY,
    HACK_NATIVE_CADDY_SHA256: sourceEnv.HACK_NATIVE_CADDY_SHA256,
    HACK_NATIVE_HTTPS_PORT: sourceEnv.HACK_NATIVE_HTTPS_PORT,
  };
  if (env.HACK_RUNTIME_BACKEND !== "native") {
    return null;
  }
  const options = captureCommandOptions(opts.options);
  const mode = commandMode(options);
  if (mode === "start" || mode === "restart") {
    // Refuse a partial HTTPS selection before any input or runtime work.
    nativeHttpsPort(env);
  }
  let runtime: ReturnType<typeof resolveNativeRuntimeSelection>;
  try {
    runtime = resolveNativeRuntimeSelection(env);
  } catch {
    throw new CliUsageError(
      "Native authored execution requires absolute HACK_NATIVE_BINARY and HACK_NATIVE_HOME paths."
    );
  }
  if (!runtime) {
    return unsupported();
  }
  return await RUNNERS[mode]({
    options,
    projectRoot: opts.selected.projectRoot,
    runtime,
    env,
    seams: opts,
  });
}

/**
 * Exec and one-off run share the closed noninteractive command domain: one
 * service, a literal argv, an optional absolute workdir, no TTY/stdin, no
 * profile/env/service-list/JSON/detach/log options.
 */
function assertCommandOptions(
  options: NativeComposeCommandOptions,
  operation: "exec" | "run"
): void {
  if (
    process.platform !== "darwin" ||
    options.operation !== operation ||
    !nativeAuthoredExecOptions(
      options.service,
      options.command,
      options.workdir
    ) ||
    options.json ||
    options.follow !== undefined ||
    options.tail !== undefined ||
    options.logFormat !== undefined ||
    options.recover ||
    options.detach ||
    options.unsupportedOptions ||
    options.services !== undefined ||
    options.profiles !== undefined ||
    options.overlay !== undefined
  ) {
    unsupported();
  }
}
type CommandContract = {
  readonly truncated: string;
  readonly unconfirmed: string;
};
const COMMAND_CONTRACTS: Readonly<Record<"exec" | "run", CommandContract>> = {
  exec: {
    truncated: "Native exec output was truncated.\n",
    unconfirmed:
      "Native authored exec completion is unconfirmed; command effects may have occurred. Values omitted. No request was replayed.",
  },
  run: {
    truncated: "Native run output was truncated.\n",
    unconfirmed:
      "Native authored run completion is unconfirmed; command effects may have occurred and its one-off container may remain until down. Values omitted. No request was replayed.",
  },
};
type CommandCompletion = {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
};
/** One owner-mediated command whose validated completion is written in order; cancellation stops further writes. */
async function runAuthoredCommand(input: {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly runtime: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
  readonly perform: (request: {
    readonly runtime: Runtime;
    readonly scope: NativeAuthoredProjectRunScope;
    readonly service: string;
    readonly command: readonly string[];
    readonly workdir?: string;
    readonly signal: AbortSignal;
  }) => Promise<CommandCompletion>;
  readonly contract: CommandContract;
  /**
   * Advisory step after a validated completion and before any output. It
   * receives the command's cancellation signal and must settle promptly once
   * that signal aborts.
   */
  readonly beforeOutput?: (signal: AbortSignal) => Promise<void>;
}): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const root = await realpath(input.projectRoot);
    const result = await input.perform({
      runtime: input.runtime,
      scope: {
        projectRoot: root,
        projectDir: join(root, ".hack"),
        nativeHome: input.runtime.home,
        branch: input.options.instance ?? null,
      },
      service: input.options.service ?? "",
      command: input.options.command ?? [],
      workdir: input.options.workdir,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      return 130;
    }
    await input.beforeOutput?.(controller.signal).catch(() => undefined);
    if (controller.signal.aborted) {
      return 130;
    }
    await Bun.write(Bun.stdout, result.stdout);
    if (controller.signal.aborted) {
      return 130;
    }
    await Bun.write(Bun.stderr, result.stderr);
    if (controller.signal.aborted) {
      return 130;
    }
    if (result.truncated) {
      process.stderr.write(input.contract.truncated);
    }
    return controller.signal.aborted ? 130 : result.exitCode;
  } catch {
    if (controller.signal.aborted) {
      return 130;
    }
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message: input.contract.unconfirmed,
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
