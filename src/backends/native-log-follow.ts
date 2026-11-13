import type { Writable } from "node:stream";
import { CliUsageError } from "../cli/command.ts";
import { childEnvironment } from "../lib/child-environment.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { parseTimeInput } from "../lib/time.ts";
import { type LogJsonEntry, parseComposeLogLine } from "../ui/log-json.ts";
import {
  buildLogStreamEndEvent,
  buildLogStreamLogEvent,
  buildLogStreamStartEvent,
  type LogStreamContext,
} from "../ui/log-stream.ts";
import { withPinnedRuntimeBinary } from "./native-authored-runtime-binary.ts";
import { readLogFailure } from "./native-log-drain.ts";
import {
  NATIVE_EXIT_DRAIN_BOUND_MS,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const ID = /^[a-f0-9]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LINE_LIMIT = 64 * 1024;
/** Native's supported flags are explicit; no selector or formatting flag is ignored. */
export function assertNativeLogFlags(options: {
  readonly profile?: string;
  readonly compose?: boolean;
  readonly loki?: boolean;
  readonly services?: string;
  readonly query?: string;
  readonly since?: string;
  readonly until?: string;
  readonly pretty?: boolean;
  readonly follow?: boolean;
  readonly noFollow?: boolean;
}): void {
  for (const name of [
    "profile",
    "compose",
    "loki",
    "services",
    "query",
    "until",
    "pretty",
  ] as const) {
    if (options[name] !== undefined && options[name] !== false) {
      throw new CliUsageError(`Native logs do not support --${name}.`);
    }
  }
  if (options.follow && options.noFollow) {
    throw new CliUsageError("Cannot combine --follow and --no-follow.");
  }
  if (options.noFollow && options.since !== undefined) {
    throw new CliUsageError("Native --since currently requires --follow.");
  }
}
export type NativeLogFollowSelection = {
  readonly run: string;
  readonly owner: string;
  readonly namespace: string;
  readonly plan: string;
  readonly native: boolean;
  readonly container?: string;
};
function refused(code = "native_log_stream_uncertain"): never {
  throw new HackCliError({
    code: "E_LIFECYCLE_FAILED",
    message:
      code === "native_log_stopped_idle"
        ? "Native logs ended after the stopped service was idle for five seconds without stream EOF (native_log_stopped_idle); the final tail may be incomplete."
        : `Native logs failed (${code}); no cleanup was inferred.`,
  });
}
/** Reject unsupported bounds explicitly before selecting or spawning the runtime. */
export function nativeLogFollowOptions(input: {
  readonly service?: string;
  readonly tail?: number;
  readonly since?: string;
}): { service: string; tail: number; since?: number } {
  if (!(input.service && SERVICE.test(input.service))) {
    throw new CliUsageError("Native --follow requires one service name.");
  }
  const tail = input.tail ?? 200;
  if (!Number.isSafeInteger(tail) || tail < 0 || tail > 1000) {
    throw new CliUsageError(
      "Native --tail requires an integer from 0 to 1000."
    );
  }
  if (input.since === undefined) {
    return { service: input.service, tail };
  }
  const since = parseTimeInput(input.since);
  if (!since || since.getTime() < 0) {
    throw new CliUsageError("Native --since requires a timestamp or duration.");
  }
  return {
    service: input.service,
    tail,
    since: Math.floor(since.getTime() / 1000),
  };
}

/** One bounded wire line at a time; no read-ahead while its consumer is blocked. */
export async function* nativeLogWireLines(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  exited?: Promise<number>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let waiting = false;
  let childExited = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  const boundRead = () => {
    if (waiting && childExited) {
      timer = setTimeout(() => {
        expired = true;
        cancel();
      }, NATIVE_EXIT_DRAIN_BOUND_MS);
    }
  };
  void exited?.then(() => {
    childExited = true;
    boundRead();
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      waiting = true;
      boundRead();
      const { done, value } = await reader.read();
      waiting = false;
      clearTimeout(timer);
      if (expired) {
        refused("native_log_exit_drain_timeout");
      }
      if (done) {
        break;
      }
      // Bun pipe chunks have a finite bound; split before concatenation too.
      for (let offset = 0; offset < value.byteLength; offset += 8192) {
        pending += decoder.decode(value.subarray(offset, offset + 8192), {
          stream: true,
        });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          if (newline > 8192) {
            refused("native_log_wire_limit");
          }
          yield pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending.length > 8192) {
          refused("native_log_wire_limit");
        }
      }
    }
    if (!signal.aborted && (pending + decoder.decode()).length !== 0) {
      refused("native_log_wire_truncated");
    }
  } finally {
    waiting = false;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Separate UTF-8/line state per descriptor, capped even for newline-free output. */
export function nativeLogLineDecoder(input: {
  readonly service: string;
  readonly container?: string;
  readonly onLine: (
    stream: "stdout" | "stderr",
    text: string,
    completeness: { readonly truncated: boolean; readonly partial: boolean }
  ) => Promise<void>;
}) {
  const state = {
    stdout: { decoder: new TextDecoder(), pending: "", truncated: false },
    stderr: { decoder: new TextDecoder(), pending: "", truncated: false },
  };
  const emit = async (stream: "stdout" | "stderr", partial: boolean) => {
    const selected = state[stream];
    // Do not split a supplementary Unicode character at the retained-prefix bound.
    const last = selected.pending.charCodeAt(selected.pending.length - 1);
    const prefix =
      selected.truncated && last >= 0xd8_00 && last <= 0xdb_ff
        ? selected.pending.slice(0, -1)
        : selected.pending;
    await input.onLine(
      stream,
      `${prefix}${selected.truncated ? " [truncated]" : ""}${partial ? " [partial]" : ""}`,
      { truncated: selected.truncated, partial }
    );
    selected.pending = "";
    selected.truncated = false;
  };
  const append = async (stream: "stdout" | "stderr", text: string) => {
    const selected = state[stream];
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      const room = LINE_LIMIT - selected.pending.length;
      selected.pending += text.slice(offset, Math.min(end, offset + room));
      selected.truncated ||= end - offset > room;
      if (newline < 0) {
        return;
      }
      await emit(stream, false);
      offset = newline + 1;
    }
  };
  let container = input.container;
  return {
    async accept(line: string): Promise<void> {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        refused("native_log_wire_invalid");
      }
      if (
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !==
          "container,data,kind,service,stream,version" ||
        value.version !== 1 ||
        value.kind !== "native-log-chunk" ||
        value.service !== input.service ||
        typeof value.container !== "string" ||
        !ID.test(value.container) ||
        (container !== undefined && value.container !== container) ||
        (value.stream !== "stdout" && value.stream !== "stderr") ||
        typeof value.data !== "string" ||
        value.data.length > 5464 ||
        !BASE64.test(value.data)
      ) {
        refused("native_log_wire_invalid");
      }
      container = value.container;
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.toString("base64") !== value.data) {
        refused("native_log_wire_invalid");
      }
      if (bytes.byteLength > 4096) {
        refused("native_log_wire_limit");
      }
      const selected = state[value.stream];
      await append(
        value.stream,
        selected.decoder.decode(bytes, { stream: true })
      );
    },
    async finish(): Promise<void> {
      for (const stream of ["stdout", "stderr"] as const) {
        const selected = state[stream];
        await append(stream, selected.decoder.decode());
        if (selected.pending || selected.truncated) {
          await emit(stream, true);
        }
        selected.pending = "";
      }
    },
  };
}
function write(
  output: Writable,
  text: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => settle(new Error("Native log output canceled"));
    const settle = (error?: Error | null) => {
      signal.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    output.write(text, settle);
  });
}

type FollowInput = {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly selection: NativeLogFollowSelection;
  readonly service: string;
  readonly tail?: number;
  readonly since?: string;
  readonly json?: boolean;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly project?: string;
  readonly branch?: string;
};

function runtimeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "HACK_DAEMON_AUTOSTART_DISABLE",
    "HACK_NO_INTERACTIVE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function logOutput(
  input: FollowInput,
  signal: AbortSignal,
  failed: (error: Error) => void
) {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  stdout.on("error", failed);
  if (stderr !== stdout) {
    stderr.on("error", failed);
  }
  const context: LogStreamContext = {
    backend: "native",
    project: input.project,
    branch: input.branch,
    services: [input.service],
    follow: true,
    since: input.since,
  };
  return {
    async start() {
      if (input.json) {
        await write(
          stdout,
          `${JSON.stringify(buildLogStreamStartEvent({ context }))}\n`,
          signal
        );
      }
    },
    async end(
      code: number,
      endSignal = signal,
      reason = code === 0 ? "eof" : `exit:${code}`
    ) {
      if (input.json) {
        await write(
          stdout,
          `${JSON.stringify(buildLogStreamEndEvent({ context, reason }))}\n`,
          endSignal
        );
      }
    },
    decoder: nativeLogLineDecoder({
      service: input.service,
      container: input.selection.container,
      onLine: async (stream, text, completeness) => {
        const raw = `${input.service} | ${text}`;
        const entry: LogJsonEntry = {
          ...parseComposeLogLine({ line: raw, stream }),
          source: "native",
          service: input.service,
          instance: undefined,
          project: input.project,
          ...(completeness.truncated ? { truncated: true } : {}),
          ...(completeness.partial ? { partial: true } : {}),
        };
        const output = input.json || stream === "stdout" ? stdout : stderr;
        await write(
          output,
          input.json
            ? `${JSON.stringify(buildLogStreamLogEvent({ context, entry }))}\n`
            : `${raw}\n`,
          signal
        );
      },
    }),
    dispose() {
      stdout.off("error", failed);
      if (stderr !== stdout) {
        stderr.off("error", failed);
      }
    },
  };
}

async function endInterruptedLog(
  output: ReturnType<typeof logOutput>,
  code: number,
  consumerClosed: boolean,
  reason?: string
) {
  if (code === 0 || consumerClosed) {
    return;
  }
  // Best effort only: cancellation must remain bounded even behind a paused pager.
  await output
    .end(code, AbortSignal.timeout(100), reason)
    .catch(() => undefined);
}

function ownLogReader(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  signal: AbortSignal
) {
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.stdin.end();
    if (settled) {
      return;
    }
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, 1000);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) {
    stop();
  }
  const exited = child.exited.then((code) => {
    settled = true;
    return code;
  });
  return {
    exited,
    async dispose() {
      stop();
      await exited;
      clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
    },
  };
}

/** Own exactly one read child. Cancellation reaps it, never the project owner. */
export async function followNativeLogs(input: FollowInput): Promise<number> {
  const opts = nativeLogFollowOptions(input);
  const controller = new AbortController();
  let consumerClosed = false;
  let canceled = 0;
  const cancel = (code: number) => {
    canceled ||= code;
    controller.abort();
  };
  const interrupt = () => cancel(130);
  const terminate = () => cancel(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await withPinnedRuntimeBinary(
      { binary: input.runtime.binary, signal: controller.signal, refused },
      async (pin) => {
        await pin.check();
        const selection = input.selection;
        const env = runtimeEnvironment();
        pin.checkSync();
        const child = Bun.spawn(
          [
            input.runtime.binary,
            "--candidate-root",
            input.runtime.home,
            "graph",
            "logs-follow",
            "--run-id",
            selection.run,
            "--service",
            opts.service,
            "--expect-owner",
            selection.owner,
            "--expect-plan",
            selection.plan,
            "--expect-namespace",
            selection.namespace,
            "--tail",
            String(opts.tail),
            ...(selection.native ? ["--native"] : []),
            ...(opts.since === undefined
              ? []
              : ["--since", String(opts.since)]),
          ],
          {
            cwd: input.cwd,
            env: childEnvironment(env),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
          }
        );
        const reader = ownLogReader(child, controller.signal);
        const { exited } = reader;
        const failure = readLogFailure(child.stderr, exited, controller.signal);
        // Writable emits error independently of the write callback. Keep a listener
        // for the entire session, including cancellation of a blocked write.
        const outputFailed = (error: Error) => {
          consumerClosed ||= closedOutput(error);
          controller.abort();
        };
        const output = logOutput(input, controller.signal, outputFailed);
        const { decoder } = output;
        let endReason: string | undefined;
        try {
          await output.start();
          for await (const line of nativeLogWireLines(
            child.stdout,
            controller.signal,
            exited
          )) {
            await decoder.accept(line);
          }
          const code = await exited;
          const detail = await failure;
          if (canceled) {
            await endInterruptedLog(output, canceled, consumerClosed);
            return canceled;
          }
          if (consumerClosed) {
            return 0;
          }
          if (detail?.code === "native_log_stopped_idle") {
            endReason = detail.code;
            await decoder.finish();
            refused(detail.code);
          }
          if (
            code !== 0 ||
            controller.signal.aborted ||
            detail?.code === "native_log_exit_drain_timeout"
          ) {
            refused(detail?.code);
          }
          await decoder.finish();
          await output.end(code);
          return 0;
        } catch (error) {
          await endInterruptedLog(
            output,
            canceled || 1,
            consumerClosed,
            endReason
          );
          throw error;
        } finally {
          controller.abort();
          await reader.dispose();
          await failure;
          output.dispose();
        }
      }
    );
  } catch (error) {
    if (canceled) {
      return canceled;
    }
    if (consumerClosed || closedOutput(error)) {
      return 0;
    }
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

function closedOutput(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")
  );
}
