import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  nativeAuthoredLogsOptions,
  nativeAuthoredProjectLogs,
} from "../backends/native-authored-project-logs.ts";
import {
  type NativeAuthoredProjectStatus,
  nativeAuthoredProjectPs,
} from "../backends/native-authored-project-observe.ts";
import { recoverNativeAuthoredProject } from "../backends/native-authored-project-recovery.ts";
import { stopNativeAuthoredProject } from "../backends/native-authored-project-run.ts";
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
      "Native authored execution requires whole-project foreground up, ps, owner-mediated down, finite single-service logs --no-follow, or explicit stored-generation down --recover on macOS. This request ran no input or runtime operation.",
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
    !["up", "down"].includes(options.operation) ||
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

type Mode = "status" | "recovery" | "stop" | "start" | "logs";
function commandMode(options: NativeComposeCommandOptions): Mode {
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
  return options.operation === "down" ? "stop" : "start";
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

/**
 * Explicit native dispatch after exact authored-family and adoption selection.
 * Compose and omitted selections retain their existing owner. Foreground up delegates
 * to the tagged lifetime owner. Ps and finite service logs observe its saved run;
 * explicit down --recover uses the stored cleanup owner without input acquisition.
 * Unsupported requests never start input acquisition or runtime work.
 */
export async function tryNativeAuthoredCommand(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly selected: NativeComposeSelection;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Execution seam for command-selection controls; the CLI always uses the real owner. */
  readonly serve?: typeof serveNativeAuthoredProject;
  readonly recover?: typeof recoverNativeAuthoredProject;
  readonly stop?: typeof stopNativeAuthoredProject;
  readonly observe?: typeof nativeAuthoredProjectPs;
  readonly logs?: typeof nativeAuthoredProjectLogs;
}): Promise<number | null> {
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
  const projectRoot = opts.selected.projectRoot;
  const serve = opts.serve ?? serveNativeAuthoredProject;
  const recover = opts.recover ?? recoverNativeAuthoredProject;
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
  if (mode === "logs") {
    return await runAuthoredLogs({
      options,
      projectRoot,
      runtime,
      logs: opts.logs ?? nativeAuthoredProjectLogs,
    });
  }
  const startupTimeoutMs =
    mode === "status" ? 15_000 : resolveComposeStartupTimeoutMs({ env });
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
    const root = await realpath(projectRoot);
    const scope = {
      projectRoot: root,
      projectDir: join(root, ".hack"),
      nativeHome: runtime.home,
      branch: options.instance ?? null,
    };
    if (mode === "status") {
      const result = await (opts.observe ?? nativeAuthoredProjectPs)({
        runtime,
        scope,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return 130;
      }
      await showStatus({ result, json: options.json });
      return 0;
    }
    if (mode === "recovery") {
      await recover({
        runtime,
        scope,
        timeoutMs: startupTimeoutMs,
        signal: controller.signal,
      });
      logger.info({
        message:
          "Selected native project recovered; persistent data is retained.",
      });
      return 0;
    }
    if (options.operation === "down") {
      await (opts.stop ?? stopNativeAuthoredProject)({
        scope,
        timeoutMs: startupTimeoutMs,
        signal: controller.signal,
      });
      logger.info({
        message:
          "Selected native project stopped; persistent data is retained.",
      });
      return 0;
    }
    return await serve({
      runtime,
      scope,
      run: randomBytes(16).toString("hex"),
      profiles: options.profiles,
      overlay: options.overlay,
      startupTimeoutMs,
      signal: controller.signal,
      forceSignal: forceController.signal,
      onHookDiagnostic: (event) => {
        if (
          event.boundary === "failed" ||
          event.boundary === "stop-operation"
        ) {
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
    });
  } catch (error: unknown) {
    return commandFailure({ error, mode, signal: controller.signal });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
