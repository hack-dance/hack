export type HackExecutionMode = "default" | "slim";

const SLIM_EXECUTION_MODE_VALUES = new Set(["slim", "codex"]);

export function resolveHackExecutionMode(): HackExecutionMode {
  const raw = (process.env.HACK_EXECUTION_MODE ?? "").trim().toLowerCase();
  return SLIM_EXECUTION_MODE_VALUES.has(raw) ? "slim" : "default";
}

export function isSlimExecutionMode(): boolean {
  return resolveHackExecutionMode() === "slim";
}

export function renderSlimModeUnavailableMessage(opts: {
  readonly feature: string;
  readonly alternative?: string;
}): string {
  const lines = [
    `${opts.feature} is unavailable in slim execution mode.`,
    "Slim mode is intended for managed Codex or CI containers and skips the machine-level Hack stack.",
    "Skipped surfaces: Caddy, CoreDNS, Loki, Grafana, local CA/TLS bootstrap, and Docker event watching.",
  ];
  if (opts.alternative) {
    lines.push(`Next: ${opts.alternative}`);
  }
  return lines.join("\n");
}
