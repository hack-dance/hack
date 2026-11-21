/**
 * End-to-end readiness of the global proxy, after its containers are
 * healthy: routing is ready only once a `.hack` name resolves through
 * CoreDNS and an HTTPS request reaches Caddy through its published port.
 * Container health alone does not prove either (CoreDNS has no healthcheck,
 * and Caddy's admin API answers before its routes are loaded).
 *
 * The DNS query runs inside the Caddy container (`nslookup <name> coredns`
 * on the proxy network), so it works the same on Linux and macOS. The HTTPS
 * request goes from the host to the published port with `curl`, resolving
 * the name to the proxy's bind address; any HTTP status proves TLS and the
 * route answered. Without `curl` the HTTPS step is skipped and said so.
 */
import { DEFAULT_SCHEMAS_HOST } from "../constants.ts";

export type RouteProbeStep = "dns" | "https";

export interface RouteProbeDeps {
  /** One DNS answer for `name` from CoreDNS; true when it resolved. */
  readonly resolveName: (name: string) => Promise<boolean>;
  /** One HTTPS request for `name` through the published port; true when any status came back. */
  readonly requestHttps: ((name: string) => Promise<boolean>) | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Called about every `progressMs` while waiting, with the elapsed time. */
  readonly progress?: (opts: {
    readonly waitingFor: readonly RouteProbeStep[];
    readonly elapsedMs: number;
  }) => void;
}

export type RouteProbeResult =
  | { readonly ready: true; readonly skipped: readonly RouteProbeStep[] }
  | { readonly ready: false; readonly waitingFor: readonly RouteProbeStep[] };

/** The name probed: Caddy routes it to its own file server from its labels. */
export const ROUTE_PROBE_NAME = DEFAULT_SCHEMAS_HOST;

/**
 * Waits until both steps succeed, at most `timeoutMs`. Each step, once it
 * succeeds, is not repeated.
 */
export async function waitForRoutes(
  deps: RouteProbeDeps,
  opts: {
    readonly timeoutMs: number;
    readonly pollMs?: number;
    readonly progressMs?: number;
  }
): Promise<RouteProbeResult> {
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = opts.pollMs ?? 250;
  const progressMs = opts.progressMs ?? 3000;
  const started = now();
  let lastProgress = started;
  const pending = new Set<RouteProbeStep>(["dns"]);
  const skipped: RouteProbeStep[] = [];
  if (deps.requestHttps) {
    pending.add("https");
  } else {
    skipped.push("https");
  }
  for (;;) {
    if (pending.has("dns") && (await deps.resolveName(ROUTE_PROBE_NAME))) {
      pending.delete("dns");
    }
    if (
      pending.has("https") &&
      deps.requestHttps &&
      (await deps.requestHttps(ROUTE_PROBE_NAME))
    ) {
      pending.delete("https");
    }
    if (pending.size === 0) {
      return { ready: true, skipped };
    }
    const elapsed = now() - started;
    if (elapsed >= opts.timeoutMs) {
      return { ready: false, waitingFor: [...pending] };
    }
    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      deps.progress?.({ waitingFor: [...pending], elapsedMs: elapsed });
    }
    await sleep(pollMs);
  }
}

/** The host address that reaches the proxy's published ports. */
export function probeAddress(bindAddress: string | null): string {
  if (bindAddress === null || bindAddress === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (bindAddress === "::") {
    return "::1";
  }
  return bindAddress;
}
