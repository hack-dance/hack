import { isRecord } from "../lib/guards.ts";
import { readLinesFromStream } from "../ui/lines.ts";

export type DockerEvent = Record<string, unknown>;

export interface DockerEventWatcher {
  stop(): void;
}

const ignoredContainerActions = new Set([
  "attach",
  "commit",
  "copy",
  "detach",
  "exec_create",
  "exec_detach",
  "exec_die",
  "exec_start",
  "export",
  "resize",
  "top",
]);

/**
 * Returns false only for known container actions that cannot change Hack's
 * cached topology, state, ports, labels, mounts, or networks. Unknown actions
 * fail open so the periodic reconciliation is not the only freshness path for
 * new Docker event types.
 */
export function shouldRefreshForDockerEvent(opts: {
  readonly event: DockerEvent;
}): boolean {
  const action = readDockerEventAction({ event: opts.event });
  if (!action) {
    return true;
  }
  return !ignoredContainerActions.has(action);
}

export function startDockerEventWatcher(opts: {
  readonly onEvent: (event: DockerEvent) => void;
  readonly onError: (message: string) => void;
  readonly onExit: (exitCode: number) => void;
}): DockerEventWatcher {
  let stopped = false;
  let current: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;

  const runLoop = async () => {
    let attempt = 0;
    while (!stopped) {
      const proc = Bun.spawn(
        [
          "docker",
          "events",
          "--filter",
          "type=container",
          "--format",
          "{{json .}}",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      );
      current = proc;

      const stdoutTask = (async () => {
        for await (const line of readLinesFromStream(proc.stdout)) {
          const event = parseDockerEvent({ line });
          if (event) {
            opts.onEvent(event);
          }
        }
      })();

      const stderrLines: string[] = [];
      const stderrTask = (async () => {
        for await (const line of readLinesFromStream(proc.stderr)) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            stderrLines.push(trimmed);
          }
        }
      })();

      const exitCode = await proc.exited;
      await Promise.all([stdoutTask, stderrTask]);

      if (stopped) {
        return;
      }

      if (stderrLines.length > 0) {
        opts.onError(stderrLines.join("\n"));
      }
      opts.onExit(exitCode);

      attempt += 1;
      const delayMs = Math.min(2000, 200 * 2 ** attempt);
      await sleep({ ms: delayMs });
    }
  };

  void runLoop();

  return {
    stop() {
      stopped = true;
      if (current) {
        current.kill();
        current = null;
      }
    },
  };
}

function parseDockerEvent(opts: { readonly line: string }): DockerEvent | null {
  const trimmed = opts.line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readDockerEventAction(opts: {
  readonly event: DockerEvent;
}): string | null {
  const rawAction = opts.event.Action ?? opts.event.status;
  if (typeof rawAction !== "string") {
    return null;
  }
  const action = rawAction.split(":", 1)[0]?.trim().toLowerCase() ?? "";
  return action.length > 0 ? action : null;
}

function sleep(opts: { readonly ms: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, opts.ms));
}
