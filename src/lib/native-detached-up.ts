import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../backends/native-runtime-client.ts";
import { hackReexecEnvironment } from "./child-environment.ts";
import {
  emitCliResult,
  errorResult,
  HackCliError,
  okResult,
} from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { NATIVE_ROOT_DOTENV_IGNORED_NOTICE } from "./native-environment-notices.ts";

export const NATIVE_DETACHED_OWNER_ARGUMENT =
  "--internal-native-detached-owner";
const SHELL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Ready = {
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly started: readonly string[];
  readonly completed?: readonly string[];
};
let publishReady: ((ready: Ready) => void) | undefined;
let publishShellVariables:
  | ((names: readonly string[], ignoredRootDotenv?: boolean) => void)
  | undefined;
type StartupFailure = {
  readonly code: string;
  readonly message?: string;
  readonly service?: string;
  /** Names only: services whose process failed during startup. Never their output. */
  readonly failedServices?: readonly string[];
  readonly startupPhase?: "static-preflight";
};
let publishFailure: ((failure: StartupFailure) => Promise<void>) | undefined;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_MESSAGE = /^[\x20-\x7e]{1,400}$/;
const FAILURE_SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const FAILED_SERVICES_LIMIT = 32;
let failedStartupServices: readonly string[] = [];

/**
 * Record which services failed during a detached startup. Names only: the
 * owner has no terminal, and service output never crosses IPC.
 */
export function nativeDetachedUpFailedServices(names: readonly string[]): void {
  // Only a detached owner reports names; a foreground start keeps none.
  if (!publishFailure) {
    return;
  }
  failedStartupServices = [...new Set(names)]
    .filter((name) => FAILURE_SERVICE.test(name))
    .sort()
    .slice(0, FAILED_SERVICES_LIMIT);
}

/** Only the runtime's validated fixed detail crosses IPC; never an Error's text or logs. */
export async function nativeDetachedUpFailure(error: unknown): Promise<void> {
  if (!publishFailure) {
    return;
  }
  const { nativeRuntimeFailure } = await import(
    "../backends/native-runtime-client.ts"
  );
  const failure = nativeRuntimeFailure(error);
  if (isStartupFailure(failure)) {
    await publishFailure(
      failedStartupServices.length > 0 && failure.service === undefined
        ? { ...failure, failedServices: failedStartupServices }
        : failure
    );
  }
}

function isStartupFailure(value: unknown): value is StartupFailure {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["code", "message", "service", "failedServices", "startupPhase"].includes(
        key
      )
    ) &&
    typeof value.code === "string" &&
    FAILURE_CODE.test(value.code) &&
    (value.message === undefined ||
      (typeof value.message === "string" &&
        FAILURE_MESSAGE.test(value.message))) &&
    (value.service === undefined ||
      (typeof value.service === "string" &&
        FAILURE_SERVICE.test(value.service))) &&
    (value.failedServices === undefined ||
      (Array.isArray(value.failedServices) &&
        value.failedServices.length > 0 &&
        value.failedServices.length <= FAILED_SERVICES_LIMIT &&
        value.failedServices.every(
          (name) => typeof name === "string" && FAILURE_SERVICE.test(name)
        ))) &&
    (value.startupPhase === undefined ||
      value.startupPhase === "static-preflight")
  );
}

function startupFailureMessage(value: unknown): StartupFailure | undefined {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.kind === "failure" &&
    isStartupFailure(value.data)
    ? value.data
    : undefined;
}

function startupFailureError(failure: StartupFailure): HackCliError {
  if (failure.code === "provider_pin_changed") {
    return new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `Native detached startup refused (provider_pin_changed); ${NATIVE_PROVIDER_PIN_MESSAGE}`,
    });
  }
  let detail = "";
  if (failure.message) {
    detail = failure.service
      ? ` Service ${failure.service}: ${failure.message}`
      : ` Runtime: ${failure.message}`;
  } else if (failure.service) {
    detail = ` Service: ${failure.service}.`;
  }
  if (failure.startupPhase === "static-preflight") {
    return new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `Native detached startup refused (${failure.code}); nothing was started.${detail} Fix the reported configuration and retry; run hack doctor --native-preflight to list every static blocker.`,
    });
  }
  const failed = failure.failedServices?.length
    ? ` Failed during startup: ${failure.failedServices.join(", ")}. A detached start does not keep service output; run hack up without -d in a terminal to see each failed service's last lines (managed values redacted, not saved).`
    : "";
  return new HackCliError({
    code: "E_STARTUP_INCOMPLETE",
    message: `Native detached startup failed (${failure.code}); inspect hack ps before retrying; retained owners and recovery evidence are preserved.${detail}${failed}`,
  });
}

/** Names-only notice: never accepts or forwards an environment map or output text. */
export function nativeDetachedUpShellVariables(
  names: readonly string[],
  ignoredRootDotenv = false
): boolean {
  if (!publishShellVariables) {
    return false;
  }
  publishShellVariables(names, ignoredRootDotenv);
  return true;
}

export function nativeShellForwardingNotice(names: readonly string[]): string {
  return `Forwarding shell variables: ${names.length ? [...new Set(names)].sort().join(", ") : "(none)"}.`;
}

/** Bound and validate IPC metadata before it reaches a terminal, including on failure. */
function isShellVariables(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8192 &&
    value.every(
      (name: unknown) =>
        typeof name === "string" && SHELL_VARIABLE_NAME.test(name)
    ) &&
    Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024
  );
}

/** Called only after durable readiness and up.after; contains no private values. */
export function nativeDetachedUpReady(ready: Ready): void {
  publishReady?.(ready);
}

/**
 * Keep the existing frontend and Rust foreground owners alive in a new session.
 * IPC is admission to background operation, never runtime ownership authority.
 * Losing the launcher before acceptance requests ordinary owner-mediated stop.
 * After acceptance the existing authenticated down/recovery protocols own lifetime.
 */
export async function runNativeDetachedOwner(opts: {
  readonly args: string[];
  readonly run: (args: string[]) => Promise<number>;
}): Promise<number> {
  if (!(process.send && process.connected) || publishReady) {
    return 1;
  }
  let ready = false;
  let accepted = false;
  let stopping = false;
  const requestStop = () => {
    if (!stopping) {
      stopping = true;
      process.kill(process.pid, "SIGTERM");
    }
  };
  const disconnected = () => {
    if (!accepted) {
      requestStop();
    }
  };
  const send = (
    value:
      | string
      | { readonly kind: "ready"; readonly data: Ready }
      | {
          readonly kind: "shell-variables";
          readonly names: readonly string[];
          readonly ignoredRootDotenv?: true;
        }
      | { readonly kind: "failure"; readonly data: StartupFailure }
  ): Promise<void> =>
    new Promise((resolve) => {
      if (!(process.send && process.connected)) {
        disconnected();
        resolve();
        return;
      }
      try {
        process.send(value, undefined, undefined, (error) => {
          if (error) {
            disconnected();
          }
          resolve();
        });
      } catch {
        disconnected();
        resolve();
      }
    });
  const message = (value: unknown) => {
    if (value === "cancel") {
      requestStop();
      return;
    }
    if (value !== "accept" || !ready || accepted || stopping) {
      return;
    }
    accepted = true;
    send("accepted");
  };
  process.on("disconnect", disconnected);
  process.on("message", message);
  publishReady = (data) => {
    if (ready || stopping) {
      return;
    }
    ready = true;
    send({ kind: "ready", data });
  };
  publishShellVariables = (names, ignoredRootDotenv) => {
    if (!stopping) {
      send({
        kind: "shell-variables",
        names,
        ...(ignoredRootDotenv ? { ignoredRootDotenv: true as const } : {}),
      });
    }
  };
  // A fresh owner starts with no names from any earlier attempt.
  failedStartupServices = [];
  publishFailure = async (data) => {
    if (!(ready || stopping)) {
      await send({ kind: "failure", data });
    }
  };
  try {
    return await opts.run(opts.args);
  } finally {
    stopping = true;
    publishReady = undefined;
    publishShellVariables = undefined;
    publishFailure = undefined;
    failedStartupServices = [];
    process.off("disconnect", disconnected);
    process.off("message", message);
    if (process.connected) {
      process.disconnect?.();
    }
  }
}

function isReady(value: unknown): value is Ready {
  return (
    isRecord(value) &&
    typeof value.project === "string" &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.composeProject === "string" &&
    Array.isArray(value.started) &&
    value.started.length <= 256 &&
    value.started.every((name: unknown) => typeof name === "string") &&
    (value.completed === undefined ||
      (Array.isArray(value.completed) &&
        value.completed.length <= 256 &&
        value.completed.every((name: unknown) => typeof name === "string")))
  );
}

/** Launch only parsed, whole-project native up arguments; no shell or secret argv. */
export async function startNativeDetachedUp(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly json: boolean;
  /** Synthetic process fixtures may replace the CLI invocation. */
  readonly invocation?: readonly string[];
  readonly timeoutMs?: number;
}): Promise<number> {
  const invocation = opts.invocation ?? [
    process.execPath,
    ...(Bun.main.startsWith("/$bunfs/")
      ? []
      : [fileURLToPath(new URL("../../index.ts", import.meta.url))]),
    NATIVE_DETACHED_OWNER_ARGUMENT,
  ];
  const startedAt = Date.now();
  const executable = invocation[0];
  if (!executable) {
    throw new Error("Missing detached owner executable.");
  }
  const child = spawn(executable, [...invocation.slice(1), ...opts.args], {
    cwd: opts.cwd,
    detached: true,
    // Application/hook output may contain secrets. Never persist it or mix it
    // with the launcher's JSON. Service logs remain available through hack logs.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
    env: hackReexecEnvironment(process.env),
  });
  let ready: Ready | undefined;
  let committed = false;
  const result = Promise.withResolvers<Ready>();
  let failed = false;
  let cancellationCode: number | undefined;
  let shellVariablesReported = false;
  let exitGrace: ReturnType<typeof setTimeout> | undefined;
  const fail = () => {
    if (committed || failed) {
      return;
    }
    failed = true;
    result.reject(
      new HackCliError({
        code: "E_STARTUP_INCOMPLETE",
        message:
          "Native detached startup was not confirmed. Inspect hack ps before retrying; retained owners and recovery evidence are preserved.",
      })
    );
  };
  const cancel = (code: number) => {
    if (committed || failed) {
      return;
    }
    failed = true;
    cancellationCode = code;
    result.reject(
      new HackCliError({
        code: "E_CANCELLED",
        message:
          "Native detached startup canceled; ordinary owned stop was requested. Inspect hack ps before retrying.",
      })
    );
  };
  const interrupt = () => cancel(130);
  const terminate = () => cancel(143);
  child.on("error", fail);
  // Drain buffered IPC after exit, but don't wait for a descendant that
  // inherited the channel descriptor to release it on the full startup timer.
  child.on("exit", () => {
    if (!(committed || failed)) {
      exitGrace = setTimeout(fail, 1500);
    }
  });
  const channelClosed = () => {
    clearTimeout(exitGrace);
    fail();
  };
  child.on("close", channelClosed);
  child.on("disconnect", channelClosed);
  child.on("message", (value: unknown) => {
    if (failed) {
      return;
    }
    const failure = ready ? undefined : startupFailureMessage(value);
    if (failure) {
      failed = true;
      result.reject(startupFailureError(failure));
      return;
    }
    if (isRecord(value) && value.kind === "shell-variables") {
      if (
        !shellVariablesReported &&
        Object.keys(value).every((key) =>
          ["kind", "names", "ignoredRootDotenv"].includes(key)
        ) &&
        (value.ignoredRootDotenv === undefined ||
          value.ignoredRootDotenv === true) &&
        isShellVariables(value.names)
      ) {
        shellVariablesReported = true;
        process.stderr.write(`${nativeShellForwardingNotice(value.names)}\n`);
        if (value.ignoredRootDotenv === true) {
          process.stderr.write(`${NATIVE_ROOT_DOTENV_IGNORED_NOTICE}\n`);
        }
      }
      return;
    }
    if (
      !ready &&
      isRecord(value) &&
      value.kind === "ready" &&
      isReady(value.data)
    ) {
      ready = value.data;
      child.send("accept", (error) => {
        if (error) {
          fail();
        }
      });
    } else if (value === "accepted" && ready) {
      committed = true;
      result.resolve(ready);
    }
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const timer = setTimeout(fail, opts.timeoutMs ?? 900_000);
  try {
    const data = await result.promise;
    if (opts.json) {
      emitCliResult({
        result: okResult({
          data: {
            action: "up",
            project: data.project,
            branch: data.branch,
            composeProject: data.composeProject,
            services: {
              started: [...data.started].sort(),
              completed: [...(data.completed ?? [])].sort(),
              stopped: [],
              failed: [],
            },
            durationMs: Date.now() - startedAt,
          },
        }),
      });
    } else {
      process.stdout.write(
        "Project is ready. Use hack ps, hack logs SERVICE --no-follow, and hack down.\n"
      );
    }
    return 0;
  } catch (error) {
    if (cancellationCode === undefined || !(error instanceof HackCliError)) {
      throw error;
    }
    if (opts.json) {
      emitCliResult({
        result: errorResult({ code: error.code, message: error.message }),
      });
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    return cancellationCode;
  } finally {
    clearTimeout(timer);
    clearTimeout(exitGrace);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    // Before commit this disconnect triggers graceful shutdown in the exact
    // child. Never kill a retained owner, infer cleanup, or replay startup.
    if (child.connected) {
      if (committed) {
        child.disconnect();
      } else {
        // Acceptance may already be queued when the caller cancels. Explicit
        // cancellation requests stop even if the child accepted just before
        // it observed disconnection; disconnection alone cannot undo that.
        child.send("cancel", () => {
          if (child.connected) {
            child.disconnect();
          }
        });
      }
    }
    child.unref();
  }
}
