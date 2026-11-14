import { HackCliError } from "./cli-result.ts";

const MANUAL_START_REASONS = new Set([
  "host_commands_require_manual_start",
  "image_build_requires_manual_start",
  "image_requires_manual_start",
  "command_provider_requires_manual_start",
  "compose_inputs_require_manual_start",
  "env_file_requires_manual_start",
  "pending_env_migration",
  "adopted_project_requires_manual_start",
]);

/** Closed pre-start refusals do not consume a claim or report a startup failure. */
export function isAutostartManualStartReason(
  reason: unknown
): reason is string {
  return typeof reason === "string" && MANUAL_START_REASONS.has(reason);
}

/** Retained adoption has its own runtime and does not implement unattended guards. */
export function assertAutostartAdoptionAllowed(): void {
  if (process.env.HACK_AUTOSTART_LOGIN === "1") {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Adopted projects require a manual start. No unattended adoption operation ran.",
      detail: { reason: "adopted_project_requires_manual_start" },
    });
  }
}

/** Enforce the boundary again at host-execution sites, using their actual inputs. */
export function assertAutostartHostCommandsAllowed(opts: {
  readonly hasCommands: boolean;
}): void {
  if (process.env.HACK_AUTOSTART_LOGIN === "1" && opts.hasCommands) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "This project requires host commands; start it manually. No unattended host command ran.",
      detail: { reason: "host_commands_require_manual_start" },
    });
  }
}
