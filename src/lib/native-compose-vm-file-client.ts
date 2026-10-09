import { lstatSync, realpathSync } from "node:fs";
import { createNativeComposeEngineIdentityObserver } from "./native-compose-engine-identity.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import { NATIVE_COMPOSE_VM_FILE_LIMIT } from "./native-compose-vm-file-protocol.ts";
import { beginNativeCpuChild } from "./native-cpu-diagnostics.ts";
import { findExecutableInPath } from "./shell.ts";

async function capture(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > limit) {
        refuseNativeComposeFile();
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function groupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error: unknown) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
function childLifetime(opts: {
  readonly child: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">;
  readonly signal: AbortSignal;
  readonly terminalDeadline: number;
  readonly terminalReserve: number;
  readonly markUnknown: () => void;
}) {
  const { child, signal, terminalDeadline, terminalReserve, markUnknown } =
    opts;
  const io = new AbortController();
  let complete = false;
  let stopped = false;
  const stop = () => {
    if (!(complete || stopped)) {
      stopped = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* The owned group may already be absent. */
      }
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Exit raced cancellation. */
        }
      }
    }
    io.abort();
  };
  const timer = setTimeout(
    stop,
    Math.max(1, terminalDeadline - Date.now() - terminalReserve)
  );
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) {
    stop();
  }
  let terminalTimer: ReturnType<typeof setTimeout> | undefined;
  const terminalExpired = new Promise<null>((resolve) => {
    terminalTimer = setTimeout(
      () => {
        markUnknown();
        stop();
        resolve(null);
      },
      Math.max(1, terminalDeadline - Date.now())
    );
  });
  return {
    io,
    terminalExpired,
    completed() {
      complete = true;
    },
    wasStopped() {
      return stopped;
    },
    async settle(opts: {
      readonly output: Promise<Uint8Array>;
      readonly diagnostics: Promise<Uint8Array>;
      readonly usage: (code: number) => void;
    }): Promise<void> {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      stop();
      if (stopped || !complete) {
        markUnknown();
      }
      const terminal = Promise.allSettled([
        opts.output,
        opts.diagnostics,
        child.exited,
      ]);
      const results = await Promise.race([terminal, terminalExpired]);
      if (terminalTimer !== undefined) {
        clearTimeout(terminalTimer);
      }
      if (results === null) {
        // An unknown child/pipe lifetime permanently vetoes this transport.
        markUnknown();
        refuseNativeComposeFile();
      }
      if (!complete && results[2]?.status === "fulfilled") {
        opts.usage(results[2].value);
      }
    },
  };
}

/** A private transport, never admission authority. Only the VM material owner
 * chooses mutations after its durable intent and live lease checks. One deadline
 * bounds both transports; CLI output and the identity observer each have their
 * own fixed 8 MiB aggregate allowance. */
export function createNativeComposeVmFileClient(opts: {
  readonly engineId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly assertFresh: () => Promise<void>;
}) {
  const { engineId, signal } = opts;
  const assertFresh = opts.assertFresh;
  const deadline = Math.min(opts.deadline, Date.now() + 60_000);
  const environment = { ...process.env };
  const selected = findExecutableInPath("docker") ?? refuseNativeComposeFile();
  const binary = realpathSync(selected);
  const info = lstatSync(binary);
  if (
    !(
      info.isFile() &&
      (info.uid === 0 || info.uid === process.getuid?.()) &&
      (info.mode & 0o022) === 0 &&
      (info.mode & 0o111) !== 0
    )
  ) {
    refuseNativeComposeFile();
  }
  const pinned = [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    info.nlink,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
  ];
  let remaining = 8 * 1024 * 1024;
  let running = false;
  let unknown = false;
  const check = () => {
    if (
      unknown ||
      signal.aborted ||
      Date.now() >= deadline ||
      realpathSync(selected) !== binary
    ) {
      refuseNativeComposeFile();
    }
    const current = lstatSync(binary);
    if (
      JSON.stringify(pinned) !==
      JSON.stringify([
        current.dev,
        current.ino,
        current.mode,
        current.uid,
        current.gid,
        current.nlink,
        current.size,
        current.mtimeMs,
        current.ctimeMs,
      ])
    ) {
      refuseNativeComposeFile();
    }
  };
  check();
  const observe = createNativeComposeEngineIdentityObserver({
    environment,
    signal,
    timeoutMs: Math.min(60_000, deadline - Date.now()),
  });
  if (observe === null) {
    refuseNativeComposeFile();
  }
  const identity = async () => {
    check();
    // An explicit safe Unix selection is the first supported VM transport. No
    // context/header/API-version fallback can switch engines for material writes.
    if ((await observe()) !== engineId) {
      refuseNativeComposeFile();
    }
    check();
  };
  return Object.freeze({
    async call(args: readonly string[], stdin?: Uint8Array): Promise<string> {
      if (running || unknown) {
        return refuseNativeComposeFile();
      }
      running = true;
      const command = [...args];
      const bytes = stdin === undefined ? undefined : Buffer.from(stdin);
      if (bytes && bytes.length > NATIVE_COMPOSE_VM_FILE_LIMIT) {
        bytes.fill(0);
        running = false;
        return refuseNativeComposeFile();
      }
      try {
        await identity();
        await assertFresh();
        check();
        // Reserve terminal settlement inside the admitted command/aggregate bound.
        const terminalDeadline = Math.min(deadline, Date.now() + 30_000);
        const terminalReserve = Math.min(
          1000,
          Math.max(1, Math.floor((terminalDeadline - Date.now()) / 4))
        );
        const child = Bun.spawn([binary, ...command], {
          env: environment,
          stdin: bytes ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });
        const usage = beginNativeCpuChild(child, "docker");
        const lifetime = childLifetime({
          child,
          signal,
          terminalDeadline,
          terminalReserve,
          markUnknown: () => {
            unknown = true;
          },
        });
        const output = capture(
          child.stdout,
          Math.min(remaining, NATIVE_COMPOSE_VM_FILE_LIMIT),
          lifetime.io.signal
        );
        const diagnostics = capture(
          child.stderr,
          64 * 1024,
          lifetime.io.signal
        );
        try {
          const result = await Promise.race([
            Promise.all([output, diagnostics, child.exited]),
            lifetime.terminalExpired,
          ]);
          if (result === null) {
            return refuseNativeComposeFile();
          }
          const [stdout, stderr, code] = result;
          lifetime.completed();
          usage(code);
          remaining -= stdout.byteLength + stderr.byteLength;
          if (lifetime.wasStopped() || code !== 0 || remaining < 0) {
            refuseNativeComposeFile();
          }
          if (!groupAbsent(child.pid)) {
            unknown = true;
            refuseNativeComposeFile();
          }
          // All streams and the leader are settled. Never signal this former
          // process group after publication or a later identity failure.
          await identity();
          await assertFresh();
          check();
          return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
        } finally {
          await lifetime.settle({ output, diagnostics, usage });
        }
      } finally {
        bytes?.fill(0);
        running = false;
      }
    },
  });
}
