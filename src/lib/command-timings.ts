import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { holdProcessUntil } from "./process-exit.ts";
import {
  readTimingLine,
  TIMING_SCHEMA,
  type TimingRecord,
  type TimingStep,
} from "./timing-record.ts";

type Transport = typeof import("./native-timing-transport.ts");
type RuntimeOptions = Bun.Spawn.SpawnOptions<"ignore" | "pipe", "pipe", "pipe">;
type Outcome = "ok" | "error";
const MAX_CHILD_RECORDS = 2046;
const context = new AsyncLocalStorage<CommandTimings>();
const ZERO_ID = /^0+$/;
function id(bytes = 8): string {
  let value: string;
  do {
    value = randomBytes(bytes).toString("hex");
  } while (ZERO_ID.test(value));
  return value;
}

class CommandTimings {
  private readonly trace = id(16);
  private readonly root = id();
  private readonly originUnix = Date.now() * 1000;
  private readonly cliSpans = new Set([this.root]);
  private readonly records: TimingRecord[] = [];
  private readonly children = new Set<Promise<void>>();
  private dropped = 0;

  private readonly fd: number;
  private readonly transport: Transport;
  private readonly originMono: number;

  constructor(fd: number, transport: Transport, originMono: number) {
    this.fd = fd;
    this.transport = transport;
    this.originMono = originMono;
  }

  private now() {
    return Math.max(
      0,
      (this.transport.hostMonotonicUs() ?? this.originMono) - this.originMono
    );
  }

  private record(
    span: string,
    step: TimingStep,
    start_us: number,
    outcome: Outcome
  ): TimingRecord {
    return {
      schema: TIMING_SCHEMA,
      trace: this.trace,
      span,
      parent: span === this.root ? null : this.root,
      proc: "cli",
      clock: "host",
      origin_unix_us: this.originUnix,
      origin_mono_us: this.originMono,
      step,
      start_us,
      dur_us: Math.max(0, this.now() - start_us),
      outcome,
      attrs: {},
    };
  }

  private add(record: TimingRecord) {
    if (this.records.length < MAX_CHILD_RECORDS) {
      this.records.push(record);
    } else {
      this.dropped++;
    }
  }

  /** Only finite subprocesses belong to this collector. The caller owns long-lived children. */
  spawn(command: string[], options: RuntimeOptions) {
    const [executable, ...args] = command;
    const spawn = this.transport.hostMonotonicUs();
    const span = id();
    const start = this.now();
    let channel: ReturnType<Transport["timingChannel"]>;
    if (
      spawn === undefined ||
      !executable ||
      (options.stdio?.length ?? 0) > 3 ||
      this.cliSpans.size > MAX_CHILD_RECORDS
    ) {
      return Bun.spawn(command, options);
    }
    try {
      channel = this.transport.timingChannel();
    } catch {
      this.add(this.record(span, "runtime.request", start, "error"));
      this.cliSpans.add(span);
      return Bun.spawn(command, options);
    }
    this.cliSpans.add(span);
    const drain = () => {
      channel.drain((line) => {
        if (!line.endsWith("\n")) {
          return;
        }
        const record = readTimingLine(line);
        if (
          record?.trace === this.trace &&
          record.parent !== null &&
          record.proc !== "cli" &&
          !this.cliSpans.has(record.span)
        ) {
          this.add(record);
        }
      });
    };

    try {
      const stdio: NonNullable<RuntimeOptions["stdio"]> = options.stdio
        ? [...options.stdio]
        : [options.stdin ?? "ignore", "pipe", "pipe"];
      stdio[3] = channel.sender;
      const child = Bun.spawn(
        [
          executable,
          `--internal-timings=3:${this.trace}:${span}:${spawn}:runtime`,
          ...args,
        ],
        {
          ...options,
          stdio,
        }
      );
      channel.closeSender();
      const timer = setInterval(drain, 2);
      const finish = (outcome: Outcome) => {
        clearInterval(timer);
        try {
          drain();
          this.add(this.record(span, "runtime.request", start, outcome));
        } finally {
          channel.close();
        }
      };
      const done = child.exited.then(
        (code) => finish(code === 0 ? "ok" : "error"),
        () => finish("error")
      );
      this.children.add(done);
      const remove = () => {
        this.children.delete(done);
      };
      void done.then(remove, remove);
      holdProcessUntil(done);
      return child;
    } catch (error) {
      channel.close();
      this.add(this.record(span, "runtime.request", start, "error"));
      throw error;
    }
  }

  async finish(outcome: Outcome) {
    await Promise.allSettled(this.children);
    try {
      for (const record of this.records) {
        if (record.proc !== "cli" && this.cliSpans.has(record.span)) {
          continue;
        }
        writeSync(this.fd, `${JSON.stringify(record)}\n`);
      }
      writeSync(
        this.fd,
        `${JSON.stringify(this.record(this.root, "command.total", 0, outcome))}\n`
      );
      if (this.dropped) {
        const marker = this.record(id(), "timings.truncated", this.now(), "ok");
        marker.attrs.dropped = this.dropped;
        writeSync(this.fd, `${JSON.stringify(marker)}\n`);
      }
    } catch {
      // Timing I/O must preserve the command result.
    } finally {
      try {
        closeSync(this.fd);
      } catch {
        // The file is diagnostic only.
      }
    }
  }
}

/** A collector exists only for an explicitly selected command with a host clock. */
export async function withCommandTimings<T>(
  file: string,
  action: () => Promise<T>
): Promise<T> {
  let trace: CommandTimings | undefined;
  try {
    const transport = await import("./native-timing-transport.ts");
    const origin = transport.hostMonotonicUs();
    if (origin !== undefined) {
      trace = new CommandTimings(
        openSync(file, "wx", 0o600),
        transport,
        origin
      );
    }
  } catch {
    // Unsupported libc, clock, or output file.
  }
  if (!trace) {
    return action();
  }
  let outcome: Outcome = "error";
  try {
    const result = await context.run(trace, action);
    outcome = "ok";
    return result;
  } finally {
    await trace.finish(outcome);
  }
}

/** fd 3 must be free. Use this only for a finite child owned by the command. */
export function timedNativeSpawn(command: string[], options: RuntimeOptions) {
  return (
    context.getStore()?.spawn(command, options) ?? Bun.spawn(command, options)
  );
}
