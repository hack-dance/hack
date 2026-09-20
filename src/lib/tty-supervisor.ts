import { readSubprocessResourceUsage } from "./process-resource-usage.ts";
import { openTerminalControl } from "./tty-process-group.ts";

export const TTY_SUPERVISOR_ARGUMENT = "--internal-tty-supervisor";

type StartMessage = { readonly kind: "start"; readonly command: string[] };
function isStartMessage(value: unknown): value is StartMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "start" &&
    "command" in value &&
    Array.isArray(value.command) &&
    value.command.length > 0 &&
    value.command.every((part: unknown) => typeof part === "string")
  );
}

/** Remain the group leader until the wrapper acknowledges completion. */
export async function runTtySupervisor(): Promise<number> {
  if (!process.send) {
    return 1;
  }
  const terminal = openTerminalControl();
  if (!terminal.createGroup()) {
    throw new Error("Unable to create the command process group");
  }
  let cancelled = false;
  let completed: number | null = null;
  let started = false;
  const result = Promise.withResolvers<number>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cancelled = true;
      process.send?.({ kind: "cancel", signal });
    });
  }
  for (const signal of ["SIGTSTP", "SIGTTIN", "SIGTTOU"] as const) {
    process.on(signal, () => process.send?.({ kind: "stop" }));
  }
  process.on("disconnect", () => {
    // Losing the wrapper must not leave the command running unattended.
    process.kill(-process.pid, "SIGKILL");
  });
  process.on("message", (message: unknown) => {
    if (message === "ack" && completed !== null && !cancelled) {
      result.resolve(completed);
    }
    if (!started && isStartMessage(message)) {
      started = true;
      try {
        const child = Bun.spawn(message.command, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: process.env,
        });
        process.send?.({ kind: "spawn", pid: child.pid });
        child.exited.then((code) => {
          completed = code;
          process.send?.({
            kind: "done",
            finishedAt: new Date().toISOString(),
            ...readSubprocessResourceUsage(child),
          });
        });
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`
        );
        completed = 1;
        process.send?.({ kind: "done" });
      }
    }
  });
  process.send({ kind: "ready" });
  const code = await result.promise;
  terminal.close();
  return code;
}
