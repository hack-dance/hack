import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  emitCliResult,
  errorResult,
  HackCliError,
  okResult,
} from "./cli-result.ts";
import { isRecord } from "./guards.ts";

export const NATIVE_DETACHED_OWNER_ARGUMENT =
  "--internal-native-detached-owner";

type Ready = {
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly started: readonly string[];
  readonly completed?: readonly string[];
};
let publishReady: ((ready: Ready) => void) | undefined;

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
    value: string | { readonly kind: "ready"; readonly data: Ready }
  ) => {
    if (!(process.send && process.connected)) {
      disconnected();
      return;
    }
    try {
      process.send(value, undefined, undefined, (error) => {
        if (error) {
          disconnected();
        }
      });
    } catch {
      disconnected();
    }
  };
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
  try {
    return await opts.run(opts.args);
  } finally {
    stopping = true;
    publishReady = undefined;
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
    env: process.env,
  });
  let ready: Ready | undefined;
  let committed = false;
  const result = Promise.withResolvers<Ready>();
  let failed = false;
  let cancellationCode: number | undefined;
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
  child.on("exit", fail);
  child.on("disconnect", () => {
    if (!committed) {
      fail();
    }
  });
  child.on("message", (value: unknown) => {
    if (failed) {
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
