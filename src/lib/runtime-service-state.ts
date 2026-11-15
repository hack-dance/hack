import { getString, isRecord } from "./guards.ts";
import type { ServiceMemberEvidence } from "./project-state.ts";

/** Docker's inspect State is current evidence; never parse prose from ps Status. */
export function readContainerState(
  value: unknown
): ServiceMemberEvidence | null {
  if (!isRecord(value)) {
    return null;
  }
  const state = getString(value, "Status") ?? null;
  if (state === null) {
    return null;
  }
  const health = isRecord(value.Health)
    ? (getString(value.Health, "Status") ?? null)
    : null;
  const exited = state === "exited" || state === "dead";
  const code = value.ExitCode;
  const started = getString(value, "StartedAt") ?? null;
  return {
    state,
    health,
    exitCode:
      exited && typeof code === "number" && Number.isSafeInteger(code)
        ? code
        : null,
    startedAt:
      started !== null &&
      !started.startsWith("0001-") &&
      Number.isFinite(Date.parse(started))
        ? started
        : null,
  };
}
