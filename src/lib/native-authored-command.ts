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
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { CliUsageError } from "../cli/command.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";
import { emitCliResult, HackCliError, okResult } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import type { NativeComposeCommandOptions } from "./native-compose-command.ts";
import type { NativeComposeSelection } from "./native-compose-selection.ts";

function unsupported(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native authored execution requires whole-project foreground up or restart, owner-mediated down, ps, finite single-service logs --no-follow, noninteractive single-service exec, or explicit stored-generation down --recover on macOS. This request ran no input or runtime operation.",
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
  } catch {
    if (controller.signal.aborted) {
      return 130;
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
    if (error.canceled && error.outcome === "removed") {
      return 130;
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
  if (options.operation === "exec") {
    assertExecOptions(options);
    return "exec";
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
    logger.info({
      message:
        result.status === "pending"
          ? "Native project startup is pending; no current service status is confirmed."
          : "Native project has not been started.",
    });
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
  readonly observe?: typeof nativeAuthoredProjectPs;
  readonly logs?: typeof nativeAuthoredProjectLogs;
  readonly stop?: typeof stopNativeAuthoredProject;
  readonly exec?: typeof nativeAuthoredProjectExec;
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

/** Fresh foreground selection shared by up and the start half of restart. */
function startupSelection(
  input: LifecycleInput
): Parameters<typeof serveNativeAuthoredProject>[0] {
  return {
    runtime: input.runtime,
    scope: input.scope,
    run: randomBytes(16).toString("hex"),
    profiles: input.options.profiles,
    overlay: input.options.overlay,
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
      logger.info({ message: "Project is ready. Press Ctrl-C to stop." });
      return undefined;
    },
  };
}

function runStart(input: LifecycleInput): Promise<number> {
  return (input.seams.serve ?? serveNativeAuthoredProject)(
    startupSelection(input)
  );
}

function runRestart(input: LifecycleInput): Promise<number> {
  return restartNativeAuthoredProject({
    ...startupSelection(input),
    onStopped: () => {
      logger.info({
        message:
          "Selected native project stopped; persistent data is retained. Starting a fresh foreground generation.",
      });
      return undefined;
    },
    dependencies: { stop: input.seams.stop, serve: input.seams.serve },
  });
}

/** Two-stage cancellation and the bounded startup budget shared by the lifecycle modes. */
async function runAuthoredLifecycle(
  input: RunnerInput,
  mode: Exclude<Mode, "exec" | "logs">,
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
      runAuthoredExec({
        options: input.options,
        projectRoot: input.projectRoot,
        runtime: input.runtime,
        exec: input.seams.exec ?? nativeAuthoredProjectExec,
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
 * Explicit native dispatch after exact authored-family and adoption selection.
 * Compose and omitted selections retain their existing owner. Foreground up delegates
 * to the tagged lifetime owner; ordinary down uses its authenticated stop. Foreground
 * restart sequences that same stop before a fresh foreground up with the given
 * selection. Ps and finite service logs observe its saved run;
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
  };
  if (env.HACK_RUNTIME_BACKEND !== "native") {
    return null;
  }
  const options = captureCommandOptions(opts.options);
  const mode = commandMode(options);
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

function assertExecOptions(options: NativeComposeCommandOptions): void {
  if (
    process.platform !== "darwin" ||
    options.operation !== "exec" ||
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
async function runAuthoredExec(input: {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly runtime: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
  readonly exec: typeof nativeAuthoredProjectExec;
}): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const root = await realpath(input.projectRoot);
    const result = await input.exec({
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
    await Bun.write(Bun.stdout, result.stdout);
    if (controller.signal.aborted) {
      return 130;
    }
    await Bun.write(Bun.stderr, result.stderr);
    if (controller.signal.aborted) {
      return 130;
    }
    if (result.truncated) {
      process.stderr.write("Native exec output was truncated.\n");
    }
    return controller.signal.aborted ? 130 : result.exitCode;
  } catch {
    if (controller.signal.aborted) {
      return 130;
    }
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native authored exec completion is unconfirmed; command effects may have occurred. Values omitted. No request was replayed.",
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
