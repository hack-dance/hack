import type { ProjectLifecycleCommand } from "../lib/project.ts";
import { resolveLifecycleCommandServiceName } from "../lib/project-lifecycle-controller.ts";
import { createTextOutput, formatDuration } from "../ui/text-output.ts";

export type HookStart = (service: string) => (() => void) | undefined;

function pending(label: string): (() => void) | undefined {
  if (!process.stdout.isTTY || process.env.TERM === "dumb") {
    return;
  }
  const clear = "\r\x1b[2K";
  const output = createTextOutput({
    write: (line) => process.stdout.write(clear + line.trimEnd()),
  });
  const available = (process.stdout.columns || 80) - 5;
  let shown = "";
  for (const character of label) {
    if (Bun.stringWidth(shown + character) > available) {
      break;
    }
    shown += character;
  }
  output.line(`${shown} ...`, "faint");
  let visible = true;
  return () => {
    if (visible) {
      visible = false;
      process.stdout.write(clear);
    }
  };
}

export type HookCompletion = (
  service: string,
  result: "done" | "running",
  durationMs: number
) => void;

export function createComposeUpProgress(opts: {
  readonly before: readonly ProjectLifecycleCommand[] | undefined;
  readonly after: readonly ProjectLifecycleCommand[] | undefined;
  readonly services: readonly string[];
}) {
  const hookLabels = (
    name: "before" | "after",
    commands: readonly ProjectLifecycleCommand[] | undefined
  ) =>
    (commands ?? []).map((command, index) => ({
      name,
      detail: resolveLifecycleCommandServiceName({ command, index }),
    }));
  const row = createTextOutput().stepRows([
    ...hookLabels("before", opts.before),
    ...opts.services.map((detail) => ({ name: "services", detail })),
    ...hookLabels("after", opts.after),
  ]);
  const hook =
    (name: "before" | "after"): HookCompletion =>
    (detail, result, durationMs) =>
      row({
        name,
        detail,
        status: "ok",
        result: `${result} · ${formatDuration(durationMs)}`,
      });
  return {
    beforeStart: ((service) =>
      pending(`before ${service}`)) satisfies HookStart,
    afterStart: ((service) => pending(`after ${service}`)) satisfies HookStart,
    serviceWait: () => pending("services"),
    before: hook("before"),
    after: hook("after"),
    services(state: {
      readonly running: readonly string[];
      readonly completed: readonly string[];
    }): void {
      for (const detail of state.completed) {
        row({ name: "services", detail, status: "ok", result: "completed" });
      }
      for (const detail of state.running) {
        row({ name: "services", detail, status: "ok", result: "up" });
      }
    },
  };
}
