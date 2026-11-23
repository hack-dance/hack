import {
  selectLifecycleAddress,
  writeLifecycleStarted,
} from "../ui/lifecycle-closing.ts";

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
  // Container observations do not establish HTTP readiness. Counting these
  // routes leaves the first request to the user instead of warming it here.
  writeLifecycleStarted({
    url: selectLifecycleAddress(urls, opts.primaryHost),
    backend: "compose",
    durationMs: opts.durationMs,
    warming: urls.length,
  });
}
