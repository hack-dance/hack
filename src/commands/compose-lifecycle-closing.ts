import { createTextOutput, formatDuration } from "../ui/text-output.ts";

export function writeComposeStarted(opts: {
  readonly addresses: ReadonlyMap<string, readonly string[]>;
  readonly running: readonly string[];
  readonly primaryHost: string | null;
  readonly durationMs: number;
}): void {
  const urls = [
    ...new Set(
      opts.running.flatMap((service) => opts.addresses.get(service) ?? [])
    ),
  ];
  const url =
    urls.find((address) => URL.parse(address)?.hostname === opts.primaryHost) ??
    urls[0];
  // Container observations do not establish HTTP readiness. Counting these
  // routes leaves the first request to the user instead of warming it here.
  const warming =
    urls.length === 0
      ? ""
      : ` · ${urls.length} ${urls.length === 1 ? "route" : "routes"} warming`;
  createTextOutput().line(
    `${url ?? "no address"}  up in ${formatDuration(opts.durationMs)} · compose${warming}`
  );
}

export function writeComposeStopped(durationMs: number): void {
  createTextOutput().stepRows([])({
    status: "ok",
    name: "services",
    result: `stopped · ${formatDuration(durationMs)}`,
  });
}
