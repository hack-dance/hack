import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, writeSync } from "node:fs";
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
  private startup?: { sender: number; stop: () => void };
  private snapshot?: readonly TimingRecord[];
  private relayTried = false;

  private readonly fd: number | undefined;
  private readonly transport: Transport;
  private readonly originMono: number;

  private readonly publish?: (records: readonly TimingRecord[]) => void;
  constructor(
    fd: number | undefined,
    transport: Transport,
    originMono: number,
    publish?: (records: readonly TimingRecord[]) => void
  ) {
    this.fd = fd;
    this.transport = transport;
    this.originMono = originMono;
    this.publish = publish;
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
    const drain = () => channel.drain((line) => this.receive(line));

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

  private receive(line: string) {
    const record = line.endsWith("\n") ? readTimingLine(line) : undefined;
    if (
      record?.trace === this.trace &&
      record.parent !== null &&
      record.proc !== "cli" &&
      !this.cliSpans.has(record.span)
    ) {
      this.add(record);
    }
  }

  startupRelay() {
    if (!(this.relayTried || this.snapshot)) {
      this.relayTried = true;
      try {
        const channel = this.transport.timingChannel();
        const drain = () => channel.drain((line) => this.receive(line));
        const timer = setInterval(drain, 2);
        timer.unref();
        this.startup = {
          sender: channel.sender,
          stop: () => {
            clearInterval(timer);
            drain();
            channel.close();
          },
        };
      } catch {
        // Startup observation is optional.
      }
    }
    if (this.startup && !this.snapshot) {
      return {
        fd: this.startup.sender,
        identity: `${this.trace}:${this.root}`,
        clock: this.transport.hostMonotonicUs,
      };
    }
  }

  complete(outcome: Outcome): readonly TimingRecord[] {
    if (this.snapshot) {
      return this.snapshot;
    }
    this.startup?.stop();
    const records = this.records.filter(
      (record) => record.proc === "cli" || !this.cliSpans.has(record.span)
    );
    records.push(this.record(this.root, "command.total", 0, outcome));
    if (this.dropped) {
      const marker = this.record(id(), "timings.truncated", this.now(), "ok");
      marker.attrs.dropped = this.dropped;
      records.push(marker);
    }
    this.snapshot = records;
    if (this.fd !== undefined) {
      try {
        for (const record of records) {
          writeSync(this.fd, `${JSON.stringify(record)}\n`);
        }
      } catch {
        // The file is diagnostic only.
      } finally {
        try {
          closeSync(this.fd);
        } catch {
          // Timing I/O must preserve the command result.
        }
      }
    }
    this.publish?.(records);
    return records;
  }

  async finish(outcome: Outcome) {
    await Promise.allSettled(this.children);
    return this.complete(outcome);
  }
}

/** A collector exists only for an explicitly selected command with a host clock. */
export async function withCommandTimings<T>(
  file: string | undefined,
  action: () => Promise<T>,
  publish?: (records: readonly TimingRecord[]) => void
): Promise<T> {
  const transport = await import("./native-timing-transport.ts").catch(
    () => undefined
  );
  const origin = transport?.hostMonotonicUs();
  if (!transport || origin === undefined) {
    return action();
  }
  let fd: number | undefined;
  if (file !== undefined) {
    try {
      fd = openSync(file, "wx", 0o600);
    } catch {
      process.stderr.write("Could not create the timings file.\n");
      return action();
    }
  }
  const trace = new CommandTimings(fd, transport, origin, publish);
  let outcome: Outcome = "error";
  try {
    const result = await context.run(trace, action);
    outcome = result === 0 || typeof result !== "number" ? "ok" : "error";
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

const OWNER_ARGUMENT = "--internal-up-timing=";
const OWNER_ID = /^[0-9a-f]{32}:[0-9a-f]{16}$/;
let inheritedRelay: ReturnType<CommandTimings["startupRelay"]>;

/** The detached launcher transfers only a timing socket and opaque span IDs. */
export function upTimingOwnerRelay() {
  const relay = context.getStore()?.startupRelay();
  return relay && { fd: relay.fd, argument: OWNER_ARGUMENT + relay.identity };
}

export async function acceptUpTimingOwnerRelay(args: string[]) {
  const argument = args[0];
  if (!argument?.startsWith(OWNER_ARGUMENT)) {
    return args;
  }
  const fd = 4; // fd 3 belongs to the owner's existing IPC protocol.
  const identity = argument.slice(OWNER_ARGUMENT.length);
  try {
    const transport = await import("./native-timing-transport.ts");
    if (
      OWNER_ID.test(identity) &&
      fstatSync(fd).isSocket() &&
      transport.protectTimingFd(fd)
    ) {
      inheritedRelay = { fd, identity, clock: transport.hostMonotonicUs };
    }
  } catch {
    // An unavailable relay must not prevent the owner from starting.
  }
  if (!inheritedRelay) {
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed.
    }
  }
  return args.slice(1);
}

export function closeUpTimingOwnerRelay() {
  if (inheritedRelay) {
    const { fd } = inheritedRelay;
    inheritedRelay = undefined;
    try {
      closeSync(fd);
    } catch {
      // Timing must not interfere with readiness or owner shutdown.
    }
  }
}

/** Startup-only observation. Never await the process or register an exit hold. */
export function startupTimingSpawn(command: string[], options: RuntimeOptions) {
  const relay = inheritedRelay ?? context.getStore()?.startupRelay();
  const spawn = relay?.clock();
  const executable = command[0];
  if (!relay || spawn === undefined || !executable || options.stdio) {
    return Bun.spawn(command, options);
  }
  return Bun.spawn(
    [
      executable,
      `--internal-timings=3:${relay.identity}:${spawn}:runtime`,
      ...command.slice(1),
    ],
    {
      ...options,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe", relay.fd],
    }
  );
}

export function completeUpTimings() {
  return context.getStore()?.complete("ok");
}
