import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { recoverNativeAuthoredProject } from "../backends/native-authored-project-recovery.ts";
import { stopNativeAuthoredProject } from "../backends/native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  serveNativeAuthoredProject,
} from "../backends/native-authored-project-start.ts";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { CliUsageError } from "../cli/command.ts";
import { logger } from "../ui/logger.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import type { NativeComposeCommandOptions } from "./native-compose-command.ts";
import type { NativeComposeSelection } from "./native-compose-selection.ts";

function unsupported(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native authored execution requires whole-project foreground up, owner-mediated down, or explicit stored-generation down --recover on macOS. This request ran no input or runtime operation.",
  });
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

function capturedOptions(
  input: NativeComposeCommandOptions
): NativeComposeCommandOptions {
  return {
    ...input,
    profiles: input.profiles === undefined ? undefined : [...input.profiles],
    services: input.services === undefined ? undefined : [...input.services],
    command: input.command === undefined ? undefined : [...input.command],
  };
}

/**
 * Explicit native dispatch after exact authored-family and adoption selection.
 * Compose and omitted selections retain their existing owner. Only foreground up
 * delegates to the tagged native lifetime owner. Explicit down --recover uses the
 * stored generation owner without input acquisition; unsupported requests never start
 * input acquisition or runtime work. The Rust planner owns capability refusal.
 */
export async function tryNativeAuthoredCommand(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly selected: NativeComposeSelection;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Execution seam for command-selection controls; the CLI always uses the real owner. */
  readonly serve?: typeof serveNativeAuthoredProject;
  readonly recover?: typeof recoverNativeAuthoredProject;
  readonly stop?: typeof stopNativeAuthoredProject;
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
  const options = capturedOptions(opts.options);
  const projectRoot = opts.selected.projectRoot;
  const serve = opts.serve ?? serveNativeAuthoredProject;
  const recover = opts.recover ?? recoverNativeAuthoredProject;
  const recovering = options.operation === "down" && options.recover === true;
  if (recovering) {
    assertRecoveryOptions(options);
  } else {
    assertForegroundOptions(options);
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
  const startupTimeoutMs = resolveComposeStartupTimeoutMs({ env });
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
    if (recovering) {
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
    if (recovering || options.operation === "down") {
      throw new HackCliError({
        code: "E_LIFECYCLE_FAILED",
        message:
          "Native project recovery is incomplete or its ownership changed; selected state is retained. Values omitted.",
      });
    }
    return startupFailure(error);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
