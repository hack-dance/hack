import { getString } from "../lib/guards.ts";
import {
  formatProjectRemoteAddress,
  type ProjectRemoteStatus,
} from "../lib/project-remote-status.ts";
import { type PsRow, psServiceState, renderPs } from "../ui/ps-output.ts";

export function parseComposeExitCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

export function displayComposePs(opts: {
  readonly entries: readonly Record<string, unknown>[];
  readonly addresses: ReadonlyMap<string, readonly string[]>;
  readonly waiting: Readonly<Record<string, readonly string[]>>;
  readonly wide: boolean;
  readonly remotes: readonly ProjectRemoteStatus[];
}): void {
  const rows: PsRow[] = opts.entries.map((entry) => {
    const service = getString(entry, "Service") ?? "-";
    const state = getString(entry, "State") ?? "";
    const exitCode =
      state.toLowerCase() === "exited"
        ? parseComposeExitCode(entry.ExitCode)
        : null;
    const blockers = Object.hasOwn(opts.waiting, service)
      ? opts.waiting[service]
      : undefined;
    const stateLabel = psServiceState({
      state,
      health: getString(entry, "Health"),
      exitCode,
    });
    return {
      service,
      address: null,
      addresses: opts.addresses.get(service),
      container: getString(entry, "Name"),
      exitCode,
      ports: getString(entry, "Ports"),
      state:
        blockers && stateLabel === "created"
          ? `created (waiting for ${blockers.join(", ")})`
          : stateLabel,
    };
  });
  for (const remote of opts.remotes) {
    rows.push({
      service: remote.service,
      state: remote.state,
      address: null,
      remote: {
        kind: remote.kind,
        use: remote.target,
        pointsAt: formatProjectRemoteAddress(remote.address),
        via: remote.via ?? "-",
      },
    });
  }
  renderPs({
    wide: opts.wide,
    hasRemotes: opts.remotes.length > 0,
    hintWhenEmpty: true,
    rows,
  });
}
