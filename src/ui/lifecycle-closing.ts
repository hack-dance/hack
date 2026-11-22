import { createTextOutput, formatDuration } from "./text-output.ts";

export function selectLifecycleAddress(
  addresses: readonly string[],
  primaryHost: string | null
): string | undefined {
  const host = primaryHost?.toLowerCase();
  return (
    addresses.find((address) => URL.parse(address)?.hostname === host) ??
    addresses[0]
  );
}

export function writeLifecycleStarted(opts: {
  readonly url: string | undefined;
  readonly backend: "compose" | "native";
  readonly durationMs: number;
  readonly warming?: number;
}): void {
  const warming = opts.warming
    ? ` · ${opts.warming} ${opts.warming === 1 ? "route" : "routes"} warming`
    : "";
  createTextOutput().line(
    `${opts.url ?? "no address"}  up in ${formatDuration(opts.durationMs)} · ${opts.backend}${warming}`
  );
}

export function writeLifecycleStopped(
  durationMs: number,
  opts?: { readonly retained?: boolean; readonly unchanged?: boolean }
): void {
  const duration = formatDuration(durationMs);
  createTextOutput().stepRows([])({
    status: "ok",
    name: opts?.unchanged ? "nothing changed" : "services",
    result: opts?.unchanged
      ? duration
      : `stopped · ${opts?.retained ? "data retained · " : ""}${duration}`,
  });
}
