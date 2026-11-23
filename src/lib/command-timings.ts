import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import type {
  hostMonotonicUs,
  timingChannel,
} from "./native-timing-transport.ts";
import { holdProcessUntil } from "./process-exit.ts";
import {
  readTimingLine,
  TIMING_SCHEMA,
  type TimingRecord,
  type TimingStep,
} from "./timing-record.ts";

type Transport = {
  hostMonotonicUs: typeof hostMonotonicUs;
  timingChannel: typeof timingChannel;
};
type RuntimeOptions = Bun.Spawn.SpawnOptions<"ignore" | "pipe", "pipe", "pipe">;
type Attributes = {
  service_index?: number;
  attempt?: number;
  dropped?: number;
};
type Outcome = "ok" | "error" | "cancelled" | "incomplete" | "skipped";
const context = new AsyncLocalStorage<{
  trace: CommandTimings;
  parent: string;
}>();
const ZERO_ID = /^0+$/;
function id(bytes = 8): string {
  let value: string;
  do {
    value = randomBytes(bytes).toString("hex");
  } while (ZERO_ID.test(value));
  return value;
}
/** One explicitly selected command. No arguments or application values enter records. */
export class CommandTimings {
  readonly trace = id(16);
  private readonly originUnix: number;
  private readonly originMono: number;
  private readonly hostClock: boolean;
  private readonly fallbackStart: number;
  private readonly prepared = new Set<() => void>();
  private readonly children = new Set<Promise<void>>();
  private failure = false;
  private closed = false;
  private readonly fd: number;
  private readonly transport: Transport;
  constructor(fd: number, transport: Transport) {
    this.fd = fd;
    this.transport = transport;
    this.fallbackStart = performance.now();
    this.originUnix = Date.now() * 1000;
    const origin = this.sampleHost();
    this.hostClock = origin !== undefined;
    this.originMono = origin ?? 0;
  }
  private sampleHost() {
    try {
      return this.transport.hostMonotonicUs();
    } catch {
      return;
    }
  }
  private now() {
    const host = this.hostClock ? this.sampleHost() : undefined;
    return (
      host ??
      this.originMono +
        Math.round((performance.now() - this.fallbackStart) * 1000)
    );
  }
  private write(record: TimingRecord) {
    if (this.closed || this.failure) {
      return;
    }
    try {
      const line = `${JSON.stringify(record)}\n`;
      this.failure = writeSync(this.fd, line) !== Buffer.byteLength(line);
    } catch {
      this.failure = true;
    }
  }
  begin(step: TimingStep, attrs: Attributes = {}) {
    const span = id();
    const current = context.getStore();
    const parent = current?.trace === this ? current.parent : null;
    const start_us = Math.max(0, this.now() - this.originMono);
    let finished = false;
    return {
      span,
      finish: (outcome: Outcome) => {
        if (finished) {
          return;
        }
        finished = true;
        this.write({
          schema: TIMING_SCHEMA,
          trace: this.trace,
          span,
          parent,
          proc: "cli",
          clock: this.hostClock ? "host" : "guest",
          origin_unix_us: this.originUnix,
          origin_mono_us: this.originMono,
          step,
          start_us,
          dur_us: Math.max(0, this.now() - this.originMono - start_us),
          outcome,
          attrs,
        });
      },
    };
  }
  async measure<T>(
    step: TimingStep,
    action: () => Promise<T>,
    attrs: Attributes = {}
  ): Promise<T> {
    const span = this.begin(step, attrs);
    try {
      const value = await context.run(
        { trace: this, parent: span.span },
        action
      );
      span.finish("ok");
      return value;
    } catch (error) {
      span.finish("error");
      throw error;
    }
  }
  child(fd = 3) {
    if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255) {
      throw new Error("Timing transport requires an extra integer descriptor.");
    }
    if (this.closed) {
      return;
    }
    const span = this.begin("runtime.request");
    const channel = this.transport.timingChannel();
    const spawn =
      (this.hostClock ? this.sampleHost() : undefined) ??
      Number.MAX_SAFE_INTEGER + 1;
    const args = [
      `--internal-timings=${fd}:${this.trace}:${span.span}:${spawn}:runtime`,
    ];
    let pending = true,
      accepted = 0,
      dropped = 0;
    const consume = (line: string) => {
      const record = readTimingLine(line);
      if (record?.trace !== this.trace) {
        return;
      }
      if (accepted++ < 2048) {
        this.write(record);
      } else {
        dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
      }
    };
    const drain = () => {
      try {
        channel.drain(consume);
      } catch {
        this.failure = true;
      }
    };
    const complete = (outcome: Outcome) => {
      drain();
      if (dropped) {
        context.run({ trace: this, parent: span.span }, () =>
          this.begin("timings.truncated", { dropped }).finish("ok")
        );
      }
      span.finish(outcome);
    };
    const abandon = () => {
      if (!pending) {
        return;
      }
      pending = false;
      this.prepared.delete(abandon);
      try {
        complete("incomplete");
      } finally {
        channel.close();
      }
    };
    this.prepared.add(abandon);
    return {
      args,
      sender: channel.sender,
      failed: () => {
        if (!pending) {
          return;
        }
        pending = false;
        this.prepared.delete(abandon);
        try {
          complete("error");
        } finally {
          channel.close();
        }
      },
      started: (exited: Promise<number>) => {
        if (!pending) {
          return;
        }
        pending = false;
        this.prepared.delete(abandon);
        channel.closeSender();
        const timer = setInterval(drain, 2);
        const done = exited
          .then(
            (code) => complete(code === 0 ? "ok" : "error"),
            () => complete("error")
          )
          .finally(() => {
            clearInterval(timer);
            channel.close();
          })
          .catch(() => {
            this.failure = true;
          });
        this.children.add(done);
        const remove = () => {
          this.children.delete(done);
        };
        void done.then(remove, remove);
        holdProcessUntil(done);
      },
    };
  }
  async settle() {
    for (const abandon of this.prepared) {
      try {
        abandon();
      } catch {
        this.failure = true;
      }
    }
    while (this.children.size) {
      await Promise.allSettled([...this.children]);
    }
  }
  async finish() {
    try {
      await this.settle();
    } finally {
      if (!this.closed) {
        this.closed = true;
        try {
          closeSync(this.fd);
        } catch {
          this.failure = true;
        }
      }
    }
  }
}
/** Await before returning the command code; child drains additionally register exit holds. */
export async function withCommandTimings<T>(
  file: string,
  action: () => Promise<T>
): Promise<T> {
  const transport = await import("./native-timing-transport.ts");
  const fd = openSync(file, "wx", 0o600);
  let trace: CommandTimings;
  try {
    trace = new CommandTimings(fd, transport);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  try {
    return await trace.measure("command.total", async () => {
      try {
        return await action();
      } finally {
        await trace.settle();
      }
    });
  } finally {
    await trace.finish();
  }
}
/** Bun calls retain their existing stdin/stdout/stderr contracts. A selected extra fd is added. */
export function timedNativeSpawn(
  command: string[],
  options: RuntimeOptions,
  fd = 3
) {
  const timing = context.getStore()?.trace.child(fd);
  if (!timing) {
    return Bun.spawn(command, options);
  }
  try {
    const stdio: NonNullable<RuntimeOptions["stdio"]> = options.stdio
      ? [...options.stdio]
      : [options.stdin ?? "ignore", "pipe", "pipe"];
    stdio[fd] = timing.sender;
    const child = Bun.spawn(
      [command[0] ?? "", ...timing.args, ...command.slice(1)],
      {
        ...options,
        stdio,
      }
    );
    timing.started(child.exited);
    return child;
  } catch (error) {
    timing.failed();
    throw error;
  }
}
