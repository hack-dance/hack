import type { ComposeStartupPhase } from "../lib/compose-startup-budget.ts";
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
    { name: "images" },
    ...opts.services.map((detail) => ({ name: "services", detail })),
    ...hookLabels("after", opts.after),
  ]);
  // The Compose client's own lines are captured (HACK-2542), so its two
  // detached phases show a transient wait here and the images phase closes
  // with one row when the start phase begins.
  let clearPhase: (() => void) | undefined;
  let imagesStartedAt: number | undefined;
  const settle = () => {
    clearPhase?.();
    clearPhase = undefined;
  };
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
    /** The backend began a detached phase. */
    phase(phase: ComposeStartupPhase): void {
      settle();
      if (phase === "images") {
        imagesStartedAt = performance.now();
        clearPhase = pending("images");
        return;
      }
      if (imagesStartedAt !== undefined) {
        row({
          name: "images",
          status: "ok",
          result: `ready · ${formatDuration(performance.now() - imagesStartedAt)}`,
        });
        imagesStartedAt = undefined;
      }
      clearPhase = pending("services");
    },
    /** Compose returned or threw: drop any transient phase wait. */
    settle,
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
