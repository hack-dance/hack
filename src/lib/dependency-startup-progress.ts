import { isRecord } from "./guards.ts";
import {
  type ProcessIdentityRow,
  readProcessIdentities,
  selectProcessTree,
  signalVerifiedProcessTree,
} from "./process-tree.ts";

export type DependencyStartupPhase =
  | "waiting"
  | "installing"
  | "verifying"
  | "ready"
  | "failed";
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PHASE =
  /^HACK_DEPENDENCY_PHASE_V1 (waiting|installing|verifying|ready|failed)$/;
const MAX_LINE = 4096;

type Child = Bun.Subprocess<"ignore", "pipe", "ignore">;

function json(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
function decodeLine(bytes: number[]): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes)
    );
  } catch {
    return null;
  }
}
function frameLines(accept: (line: string) => void) {
  let bytes: number[] = [];
  let oversized = false;
  function feedByte(byte: number) {
    if (byte !== 10) {
      if (!oversized && bytes.length < MAX_LINE) {
        bytes.push(byte);
      } else {
        oversized = true;
        bytes = [];
      }
      return;
    }
    const line = oversized ? null : decodeLine(bytes);
    bytes = [];
    oversized = false;
    if (line !== null) {
      accept(line);
    }
  }
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      feedByte(byte);
    }
  };
}

function sameProcessRoot(
  captured: readonly ProcessIdentityRow[],
  current: readonly ProcessIdentityRow[],
  pid: number
): boolean {
  const original = captured.find((row) => row.pid === pid);
  const live = current.find((row) => row.pid === pid);
  return (
    live !== undefined &&
    (original === undefined || original.birth === live.birth)
  );
}

/** Cooperative progress only: exact tokens are not authenticated readiness evidence. */
export async function withDependencyStartupProgress<T>(opts: {
  readonly services: readonly string[];
  readonly project: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly onPhase: (service: string, phase: DependencyStartupPhase) => void;
  readonly onUnavailable?: () => void;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const selected = new Set(opts.services);
  if (selected.size === 0) {
    return await opts.run();
  }
  const started = Date.now();
  let active = true;
  let unavailable = false;
  const children = new Set<Child>();
  const identities = new Map<Child, Promise<ProcessIdentityRow[]>>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const tasks = new Set<Promise<void>>();
  const claimed = new Set<string>();
  const queued = new Map<string, string>();
  const processing = new Set<string>();
  const attempts = new Map<string, number>();
  const seen = new Map<string, Set<DependencyStartupPhase>>();
  function notice() {
    if (!active || unavailable) {
      return;
    }
    unavailable = true;
    try {
      opts.onUnavailable?.();
    } catch {
      /* Progress must not replace startup outcome. */
    }
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...opts.env })) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  function spawn(args: string[]): Child {
    const child = Bun.spawn(["docker", ...args], {
      cwd: opts.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    children.add(child);
    identities.set(
      child,
      (async () => {
        const rows = await readProcessIdentities();
        return child.exitCode === null && child.signalCode === null
          ? selectProcessTree(rows, child.pid)
          : [];
      })()
    );
    return child;
  }
  function track(task: Promise<void>) {
    const guarded = task.catch(notice);
    tasks.add(guarded);
    void guarded.finally(() => tasks.delete(guarded));
  }
  async function lines(
    child: Child,
    accept: (line: string) => void,
    limit = 1_048_576
  ) {
    const reader = child.stdout.getReader();
    readers.add(reader);
    let consumed = 0;
    let capturedOutputTree = false;
    const feed = frameLines((line) => {
      if (active) {
        accept(line);
      }
    });
    try {
      while (active) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        if (!capturedOutputTree) {
          capturedOutputTree = true;
          const previous = identities.get(child);
          identities.set(
            child,
            (async () => {
              const rows = await readProcessIdentities();
              if (child.exitCode === null && child.signalCode === null) {
                return selectProcessTree(rows, child.pid);
              }
              return (await previous) ?? [];
            })()
          );
        }
        consumed += next.value.byteLength;
        if (consumed > limit) {
          notice();
          await stop(child);
          break;
        }
        feed(next.value);
      }
    } finally {
      readers.delete(reader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const stopping = new Map<Child, Promise<void>>();
  function signalGroup(child: Child, signal: NodeJS.Signals) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") {
        throw error;
      }
    }
  }
  const running = (child: Child) =>
    child.exitCode === null && child.signalCode === null;
  async function prepareTermination(
    child: Child,
    captured: ProcessIdentityRow[]
  ): Promise<ProcessIdentityRow[]> {
    if (!running(child)) {
      return captured;
    }
    // Freeze only this anchored observer group before capturing its final descendants.
    signalGroup(child, "SIGSTOP");
    try {
      const current = selectProcessTree(
        await readProcessIdentities(),
        child.pid
      );
      if (running(child) && sameProcessRoot(captured, current, child.pid)) {
        signalGroup(child, "SIGTERM");
        return current;
      }
      notice();
      if (running(child)) {
        child.kill("SIGTERM");
      }
      return captured;
    } finally {
      if (running(child)) {
        signalGroup(child, "SIGCONT");
      }
    }
  }
  function stop(child: Child): Promise<void> {
    const existing = stopping.get(child);
    if (existing) {
      return existing;
    }
    const task = (async () => {
      let captured = (await identities.get(child)) ?? [];
      if (captured.length === 0 && child.exitCode !== null) {
        notice();
      }
      captured = await prepareTermination(child, captured);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
        // Captured births are revalidated after leader exit; never signal its old group ID.
        await signalVerifiedProcessTree(captured, "SIGKILL");
        if (running(child)) {
          child.kill("SIGKILL");
        }
        await child.exited;
      } finally {
        clearTimeout(timer);
        children.delete(child);
        identities.delete(child);
      }
    })();
    stopping.set(child, task);
    return task;
  }
  async function observe(service: string, id: string) {
    const inspect = spawn([
      "inspect",
      "--format",
      '{"labels":{{json .Config.Labels}},"startedAt":{{json .State.StartedAt}},"id":{{json .Id}}}',
      id,
    ]);
    let validStart: string | null = null;
    let count = 0;
    const timer = setTimeout(() => {
      void stop(inspect).catch(notice);
    }, 5000);
    try {
      await lines(
        inspect,
        (line) => {
          count += 1;
          const value = json(line);
          if (
            !(isRecord(value) && isRecord(value.labels)) ||
            value.id !== id ||
            value.labels["com.docker.compose.project"] !== opts.project ||
            value.labels["com.docker.compose.service"] !== service ||
            typeof value.startedAt !== "string" ||
            !Number.isFinite(Date.parse(value.startedAt)) ||
            Date.parse(value.startedAt) < started
          ) {
            return;
          }
          validStart = value.startedAt;
        },
        16_384
      );
      if (
        (await inspect.exited) !== 0 ||
        count !== 1 ||
        validStart === null ||
        !active
      ) {
        return;
      }
    } finally {
      clearTimeout(timer);
      await stop(inspect);
    }
    if (!active || validStart === null) {
      return;
    }
    claimed.add(service);
    const logs = spawn(["logs", "--follow", "--since", validStart, id]);
    await lines(logs, (line) => {
      const match = PHASE.exec(line);
      if (!(match && active)) {
        return;
      }
      const phase = match[1] as DependencyStartupPhase;
      const phases = seen.get(service) ?? new Set<DependencyStartupPhase>();
      if (phases.has(phase)) {
        return;
      }
      phases.add(phase);
      seen.set(service, phases);
      opts.onPhase(service, phase);
    });
    const logsCode = await logs.exited;
    if (logsCode !== 0) {
      notice();
    }
    await stop(logs);
  }
  async function processEvents(service: string) {
    processing.add(service);
    try {
      while (active && !claimed.has(service) && queued.has(service)) {
        const count = attempts.get(service) ?? 0;
        if (count >= 2) {
          notice();
          return;
        }
        const id = queued.get(service);
        queued.delete(service);
        if (!id) {
          return;
        }
        attempts.set(service, count + 1);
        await observe(service, id);
      }
    } finally {
      processing.delete(service);
    }
  }
  let cleanupTask: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    active = false;
    cleanupTask ??= (async () => {
      await Promise.all(
        [...readers].map((reader) => reader.cancel().catch(() => undefined))
      );
      await Promise.all(
        [...children].map((child) => stop(child).catch(() => undefined))
      );
      await Promise.all([...tasks]);
    })();
    return cleanupTask;
  }
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      const hasOtherHandlers = process
        .listeners(signal)
        .some((listener) => listener !== handler);
      void cleanup().then(() => {
        if (!hasOtherHandlers) {
          process.removeListener(signal, handler);
          process.kill(process.pid, signal);
        }
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    if (
      process.platform === "win32" ||
      selected.size > 32 ||
      selected.size !== opts.services.length ||
      !NAME.test(opts.project) ||
      [...selected].some((name) => !NAME.test(name))
    ) {
      notice();
    } else {
      try {
        const events = spawn([
          "events",
          "--since",
          String(Math.floor(started / 1000)),
          "--filter",
          "type=container",
          "--filter",
          "event=start",
          "--filter",
          `label=com.docker.compose.project=${opts.project}`,
          "--format",
          "{{json .}}",
        ]);
        track(
          lines(events, (line) => {
            const event = json(line);
            if (
              !isRecord(event) ||
              event.Type !== "container" ||
              event.Action !== "start" ||
              !isRecord(event.Actor) ||
              !isRecord(event.Actor.Attributes)
            ) {
              return;
            }
            const service =
              event.Actor.Attributes["com.docker.compose.service"];
            const id = event.Actor.ID;
            if (
              event.Actor.Attributes["com.docker.compose.project"] !==
                opts.project ||
              typeof service !== "string" ||
              !selected.has(service) ||
              claimed.has(service) ||
              typeof id !== "string" ||
              !ID.test(id)
            ) {
              return;
            }
            if (
              typeof event.timeNano === "number" &&
              event.timeNano / 1_000_000 < started
            ) {
              return;
            }
            queued.set(service, id);
            if (!processing.has(service)) {
              track(processEvents(service));
            }
          })
            .then(() => {
              notice();
            })
            .finally(() => stop(events))
        );
      } catch {
        notice();
      }
    }
    return await opts.run();
  } finally {
    await cleanup();
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  }
}
