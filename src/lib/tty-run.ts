import { fileURLToPath } from "node:url";
import type { RunExitEvent, RunOptions } from "./shell.ts";
import { openTerminalControl, signalOwnedGroup } from "./tty-process-group.ts";
import { TTY_SUPERVISOR_ARGUMENT } from "./tty-supervisor.ts";

/** Own descendants before starting the command while preserving its real TTY. */
export async function runWithTerminalGroup(opts: {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stdout?: "inherit" | "stderr";
  readonly timeoutMs?: number;
  readonly onSpawn?: RunOptions["onSpawn"];
  readonly onExit?: RunOptions["onExit"];
}): Promise<number> {
  const terminal = openTerminalControl();
  const parentGroup = terminal.group();
  const originalAttributes = terminal.attributes();
  let suspendedAttributes: Uint8Array | null = null;
  let ready = false;
  let stopping = false;
  let acknowledged = false;
  let cancellationCode: number | null = null;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let spawnObservation: Promise<void> = Promise.resolve();
  let observationError: unknown;
  const measurements: {
    accounting: Pick<
      RunExitEvent,
      "finishedAt" | "cpuTimeMs" | "maxRssBytes"
    > | null;
  } = { accounting: null };
  const entrypoint = fileURLToPath(new URL("../../index.ts", import.meta.url));
  const invocation = Bun.main.startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, entrypoint];
  const child = Bun.spawn([...invocation, TTY_SUPERVISOR_ARGUMENT], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "inherit",
    stdout: opts.stdout === "stderr" ? 2 : "inherit",
    stderr: "inherit",
    ipc(message: unknown) {
      if (
        typeof message !== "object" ||
        message === null ||
        !("kind" in message)
      ) {
        return;
      }
      if (message.kind === "ready") {
        startCommand();
      } else if (
        message.kind === "cancel" &&
        "signal" in message &&
        (message.signal === "SIGINT" || message.signal === "SIGTERM")
      ) {
        cancel(message.signal, message.signal === "SIGINT" ? 130 : 143, false);
      } else if (
        message.kind === "spawn" &&
        "pid" in message &&
        typeof message.pid === "number"
      ) {
        observeSpawn(message.pid);
      } else if (message.kind === "done") {
        finishCommand(message);
      } else if (message.kind === "stop") {
        suspend();
      }
    },
  });
  function finishCommand(message: object): void {
    clearTimeout(timeout);
    measurements.accounting = readAccounting(message);
    if (cancellationCode !== null) {
      signalOwnedGroup(child.pid, "SIGKILL");
    } else {
      acknowledged = true;
      child.send("ack");
    }
  }
  function observeSpawn(pid: number): void {
    spawnObservation = Promise.resolve()
      .then(() =>
        opts.onSpawn?.({
          pid,
          ownsProcessGroup: true,
          processGroupId: child.pid,
        })
      )
      .catch((error: unknown) => {
        observationError = error;
      });
  }
  function startCommand(): void {
    ready = true;
    if (cancellationCode !== null) {
      signalOwnedGroup(child.pid, "SIGKILL");
      return;
    }
    if (
      terminal.foreground() === parentGroup &&
      !terminal.setForeground(child.pid)
    ) {
      cancel("SIGTERM", 1, true);
      return;
    }
    child.send({ kind: "start", command: [...opts.command] });
  }
  function cancel(
    signal: "SIGINT" | "SIGTERM",
    code: number,
    forward: boolean
  ): void {
    if (cancellationCode !== null) {
      if (forward && ready) {
        signalOwnedGroup(child.pid, "SIGKILL");
      }
      return;
    }
    cancellationCode = code;
    if (ready && forward) {
      signalOwnedGroup(child.pid, signal);
    }
    escalation = setTimeout(() => {
      if (ready) {
        signalOwnedGroup(child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    }, 2000);
  }
  function restoreTerminal(): void {
    if (terminal.foreground() === child.pid) {
      terminal.setForeground(parentGroup);
    }
  }
  function suspend(): void {
    if (stopping || cancellationCode !== null) {
      return;
    }
    stopping = true;
    signalOwnedGroup(child.pid, "SIGSTOP");
    suspendedAttributes = terminal.attributes();
    restoreTerminal();
    terminal.restoreAttributes(originalAttributes);
    process.kill(process.pid, "SIGSTOP");
  }
  function resume(): void {
    stopping = false;
    if (ready) {
      if (terminal.foreground() === parentGroup) {
        terminal.setForeground(child.pid);
        terminal.restoreAttributes(suspendedAttributes);
      }
      signalOwnedGroup(child.pid, "SIGCONT");
    }
  }
  const interrupt = () => cancel("SIGINT", 130, true);
  const terminate = () => cancel("SIGTERM", 143, true);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGTSTP", suspend);
  process.on("SIGCONT", resume);
  if (opts.timeoutMs !== undefined) {
    timeout = setTimeout(() => cancel("SIGTERM", 124, true), opts.timeoutMs);
  }
  let result: RunExitEvent;
  try {
    const code = await child.exited;
    result = {
      finishedAt:
        measurements.accounting?.finishedAt ?? new Date().toISOString(),
      exitCode: cancellationCode ?? code,
      cancelled: cancellationCode === 130 || cancellationCode === 143,
      timedOut: cancellationCode === 124,
      cpuTimeMs: measurements.accounting?.cpuTimeMs ?? null,
      maxRssBytes: measurements.accounting?.maxRssBytes ?? null,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(escalation);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGTSTP", suspend);
    process.off("SIGCONT", resume);
    if (cancellationCode !== null || !acknowledged) {
      if (ready) {
        signalOwnedGroup(child.pid, "SIGKILL");
      }
      terminal.restoreAttributes(originalAttributes);
    }
    restoreTerminal();
    terminal.close();
  }
  await spawnObservation;
  if (observationError) {
    throw observationError;
  }
  await opts.onExit?.(result);
  return result.exitCode;
}

function readAccounting(
  message: object
): Pick<RunExitEvent, "finishedAt" | "cpuTimeMs" | "maxRssBytes"> | null {
  if (!("finishedAt" in message) || typeof message.finishedAt !== "string") {
    return null;
  }
  return {
    finishedAt: message.finishedAt,
    cpuTimeMs:
      "cpuTimeMs" in message && typeof message.cpuTimeMs === "number"
        ? message.cpuTimeMs
        : null,
    maxRssBytes:
      "maxRssBytes" in message && typeof message.maxRssBytes === "number"
        ? message.maxRssBytes
        : null,
  };
}
