import type { ProjectLifecycleCommand } from "../lib/project.ts";
import { resolveLifecycleCommandServiceName } from "../lib/project-lifecycle-controller.ts";
import { createTextOutput, formatDuration } from "../ui/text-output.ts";

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
