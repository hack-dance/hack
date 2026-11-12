import type { Writable } from "node:stream";
import { CliUsageError } from "../cli/command.ts";
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
import { watchLogConsumer } from "./native-log-consumer.ts";
import { readLogFailure } from "./native-log-drain.ts";
import {
  abortableLogRead,
  NativeLogRestartUnavailable,
} from "./native-log-restart.ts";
import {
  NATIVE_EXIT_DRAIN_BOUND_MS,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const ID = /^[a-f0-9]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LINE_LIMIT = 64 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function wireVersion(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort().join(",");
  return (
    (value.version === 1 &&
      keys === "container,data,kind,service,stream,version") ||
    (value.version === 2 &&
      keys === "container,data,kind,service,stream,timestamp,version" &&
      (value.timestamp === null ||
        (typeof value.timestamp === "string" &&
          TIMESTAMP.test(value.timestamp))))
  );
}
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
  readonly timestamps?: boolean;
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
  if (options.noFollow && options.timestamps) {
    throw new CliUsageError("Native --timestamps currently requires --follow.");
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
class NativeLogError extends HackCliError {
  readonly reason: string;
  constructor(code: string) {
    super({
      code: "E_LIFECYCLE_FAILED",
      message:
        code === "native_log_stopped_idle"
          ? "Native logs ended after the stopped service was idle for five seconds without stream EOF (native_log_stopped_idle); the final tail may be incomplete."
          : `Native logs failed (${code}); no cleanup was inferred.`,
    });
    this.reason = code;
  }
}
function refused(code = "native_log_stream_uncertain"): never {
  throw new NativeLogError(code);
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
  readonly onAttached?: () => Promise<void>;
  readonly onLine: (
    stream: "stdout" | "stderr",
    text: string,
    completeness: {
      readonly truncated: boolean;
      readonly partial: boolean;
      readonly timestamp?: string;
    }
  ) => Promise<void>;
}) {
  const state = {
    stdout: {
      decoder: new TextDecoder(),
      pending: "",
      truncated: false,
      timestamp: undefined as string | undefined,
    },
    stderr: {
      decoder: new TextDecoder(),
      pending: "",
      truncated: false,
      timestamp: undefined as string | undefined,
    },
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
      {
        truncated: selected.truncated,
        partial,
        ...(selected.timestamp ? { timestamp: selected.timestamp } : {}),
      }
    );
    selected.pending = "";
    selected.truncated = false;
    selected.timestamp = undefined;
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
        isRecord(value) &&
        value.version === 2 &&
        value.kind === "native-log-attached" &&
        Object.keys(value).sort().join(",") ===
          "container,kind,service,version" &&
        value.service === input.service &&
        typeof value.container === "string" &&
        ID.test(value.container) &&
        (container === undefined || container === value.container)
      ) {
        container = value.container;
        await input.onAttached?.();
        return;
      }
      if (
        !(isRecord(value) && wireVersion(value)) ||
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
      await input.onAttached?.();
      const selected = state[value.stream];
      if (
        !(selected.pending || selected.truncated) &&
        typeof value.timestamp === "string"
      ) {
        selected.timestamp = value.timestamp;
      }
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
  readonly selection:
    | NativeLogFollowSelection
    | (() => Promise<NativeLogFollowSelection>);
  /** Fresh admission only; the previous selection never grants restart authority. */
  readonly resume?: (
    previous: NativeLogFollowSelection,
    signal: AbortSignal
  ) => Promise<NativeLogFollowSelection | null>;
  readonly service: string;
  readonly tail?: number;
  readonly since?: string;
  readonly json?: boolean;
  readonly timestamps?: boolean;
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
    notice(message: string, noticeSignal = signal) {
      return write(stderr, `${message}\n`, noticeSignal);
    },
    async restarted() {
      const message = `Service ${input.service} restarted; following the new container.`;
      await write(
        input.json ? stdout : stderr,
        input.json
          ? `${JSON.stringify({ type: "notice", ts: new Date().toISOString(), backend: "native", reason: "native_log_restarted", message })}\n`
          : `${message}\n`,
        signal
      );
    },
    decoder: (
      selection: NativeLogFollowSelection,
      onAttached: () => Promise<void>
    ) =>
      nativeLogLineDecoder({
        service: input.service,
        container: selection.container,
        onAttached,
        onLine: async (stream, text, completeness) => {
          const raw = `${input.service} | ${text}`;
          const entry: LogJsonEntry = {
            ...parseComposeLogLine({ line: raw, stream }),
            source: "native",
            service: input.service,
            instance: undefined,
            project: input.project,
            ...(completeness.timestamp
              ? { timestamp: completeness.timestamp }
              : {}),
            ...(completeness.truncated ? { truncated: true } : {}),
            ...(completeness.partial ? { partial: true } : {}),
          };
          await write(
            stdout,
            input.json
              ? `${JSON.stringify(buildLogStreamLogEvent({ context, entry }))}\n`
              : `${input.timestamps && completeness.timestamp ? `${completeness.timestamp} ` : ""}${text}\n`,
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

/** One session owns admission, sequential readers, and its final NDJSON event. */
export async function followNativeLogs(input: FollowInput): Promise<number> {
  const opts = nativeLogFollowOptions(input);
  const controller = new AbortController();
  let consumerClosed = false;
  let outputError: Error | undefined;
  let canceled = 0;
  const close = () => {
    if (outputError) {
      return;
    }
    consumerClosed = true;
    controller.abort();
  };
  const cancel = (code: number) => {
    canceled ||= code;
    controller.abort();
  };
  const interrupt = () => cancel(130);
  const terminate = () => cancel(143);
  const output = logOutput(input, controller.signal, (error) => {
    if (closedOutput(error)) {
      close();
    } else {
      outputError = error;
      controller.abort();
    }
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let disposeConsumer: () => void = () => undefined;
  try {
    disposeConsumer = await watchLogConsumer(
      input.stdout ?? process.stdout,
      close
    );
    await output.start();
    return await runLogSession(input, opts, controller.signal, output);
  } catch (error) {
    if (consumerClosed || closedOutput(error)) {
      return 0;
    }
    if (canceled) {
      await endInterruptedLog(output, canceled, false);
      return canceled;
    }
    const reason = logErrorReason(error);
    await output.end(1, controller.signal, reason).catch(() => undefined);
    if (!consumerClosed) {
      // Fixed diagnostics: admission errors can contain paths or input values.
      const diagnostic = new NativeLogError(reason);
      await output
        .notice(diagnostic.message, AbortSignal.timeout(1000))
        .catch(() => undefined);
    }
    return consumerClosed ? 0 : canceled || 1;
  } finally {
    controller.abort();
    disposeConsumer();
    output.dispose();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function runLogSession(
  input: FollowInput,
  opts: ReturnType<typeof nativeLogFollowOptions>,
  signal: AbortSignal,
  output: ReturnType<typeof logOutput>
): Promise<number> {
  let selection =
    typeof input.selection === "function"
      ? await abortableLogRead(
          input.selection,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        )
      : input.selection;
  let resumed = false;
  for (;;) {
    signal.throwIfAborted();
    await readSelectedLogs({
      input,
      selection,
      opts: resumed ? { service: opts.service, tail: 1000 } : opts,
      signal,
      output,
      resumed,
    });
    signal.throwIfAborted();
    const resume = input.resume;
    const next = resume
      ? await abortableLogRead(() => resume(selection, signal), signal)
      : null;
    if (!next) {
      await output.notice(`Service ${input.service} stopped.`);
      await output.end(0, signal, "native_log_service_stopped");
      return 0;
    }
    if (next.namespace !== selection.namespace || next.run === selection.run) {
      refused("native_log_restart_unavailable");
    }
    selection = next;
    resumed = true;
  }
}

async function readSelectedLogs({
  input,
  selection,
  opts,
  signal,
  output,
  resumed,
}: {
  input: FollowInput;
  selection: NativeLogFollowSelection;
  opts: ReturnType<typeof nativeLogFollowOptions>;
  signal: AbortSignal;
  output: ReturnType<typeof logOutput>;
  resumed: boolean;
}): Promise<void> {
  await withPinnedRuntimeBinary(
    { binary: input.runtime.binary, signal, refused },
    async (pin) => {
      await pin.check();
      signal.throwIfAborted();
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
          ...(input.timestamps ? ["--timestamps"] : []),
          ...(resumed ? ["--from-start"] : []),
          ...(opts.since === undefined ? [] : ["--since", String(opts.since)]),
        ],
        {
          cwd: input.cwd,
          env: runtimeEnvironment(),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }
      );
      const reader = ownLogReader(child, signal);
      const failure = readLogFailure(child.stderr, reader.exited, signal);
      let marked = !resumed;
      const decoder = output.decoder(selection, async () => {
        if (!marked) {
          await output.restarted();
          marked = true;
        }
      });
      try {
        for await (const line of nativeLogWireLines(
          child.stdout,
          signal,
          reader.exited
        )) {
          await decoder.accept(line);
        }
        const code = await reader.exited;
        const detail = await failure;
        signal.throwIfAborted();
        await decoder.finish();
        if (code !== 0 || detail?.code) {
          refused(detail?.code);
        }
      } catch (error) {
        if (!signal.aborted) {
          await decoder.finish();
        }
        throw error;
      } finally {
        await reader.dispose();
        await failure;
      }
    }
  );
}

function logErrorReason(error: unknown): string {
  if (
    error instanceof NativeLogError ||
    error instanceof NativeLogRestartUnavailable
  ) {
    return error.reason;
  }
  if (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode &&
    ERROR_CODE.test(error.nativeCode)
  ) {
    return error.nativeCode;
  }
  if (error instanceof HackCliError) {
    return error.code;
  }
  return "native_log_failed";
}

function closedOutput(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")
  );
}
