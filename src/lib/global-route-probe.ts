/**
 * End-to-end readiness of the global proxy, after its containers are
 * healthy: a `.hack` name resolved through CoreDNS, and an HTTPS request
 * answered through the published port.
 *
 * Each step ends in one of three ways, and only one of them fails `hack
 * global up`:
 * - `ready`: it answered;
 * - `not-ready`: a real refusal or a wrong answer, still there at the bound;
 * - `unknown`: Hack could not check (a tool missing from an image Hack does
 *   not control, such as a v4 proxy file's; a path doctor also tolerates, such
 *   as a loopback port a container runtime does not forward; a remote engine
 *   whose address is not known). `up` then succeeds and says what it did not
 *   check.
 */
import { DEFAULT_SCHEMAS_HOST } from "../constants.ts";

const DNS_REFUSAL = /NXDOMAIN|can't find|SERVFAIL|REFUSED/i;
const HTTP_STATUS = /^[1-5]\d\d$/;
const TCP_SCHEME = /^tcp:/;

export type RouteProbeStep = "dns" | "https";

/** One look at a step. `retry` asks for another look before the bound. */
export type StepLook =
  | { readonly kind: "answered" }
  | { readonly kind: "refused"; readonly detail: string }
  | {
      readonly kind: "unknown";
      readonly detail: string;
      readonly retry: boolean;
    };

export interface RouteProbeDeps {
  /** The name to resolve and request; defaults to {@link ROUTE_PROBE_NAME}. */
  readonly name?: string;
  readonly resolveName: (name: string) => Promise<StepLook>;
  /** Null when the HTTPS step cannot be run; `httpsSkipped` says why. */
  readonly requestHttps: ((name: string) => Promise<StepLook>) | null;
  readonly httpsSkipped?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Called about every `progressMs` while waiting. */
  readonly progress?: (opts: {
    readonly waitingFor: readonly RouteProbeStep[];
    readonly elapsedMs: number;
  }) => void;
}

export type StepResult =
  | { readonly state: "ready" }
  | { readonly state: "not-ready"; readonly detail: string }
  | { readonly state: "unknown"; readonly detail: string };

export type RouteProbeResult = Readonly<Record<RouteProbeStep, StepResult>>;

/** The default name probed: Caddy routes it to its own file server. */
export const ROUTE_PROBE_NAME = DEFAULT_SCHEMAS_HOST;

const SCHEMAS_ROUTE_LABEL = /^\s*caddy:\s*["']?(schemas\.[^\s,"']+)/m;

/**
 * The schemas route the proxy file itself declares (its first name), so a
 * file from an older Hack that routes only `schemas.hack` is probed by the
 * name it serves. Falls back to {@link ROUTE_PROBE_NAME}.
 */
export function routeProbeName(proxyCompose: string): string {
  return SCHEMAS_ROUTE_LABEL.exec(proxyCompose)?.[1] ?? ROUTE_PROBE_NAME;
}

type Look = readonly [RouteProbeStep, (name: string) => Promise<StepLook>];

/** One look at a step; a thrown look is unknown and retried. */
async function lookAt(look: Look[1], name: string): Promise<StepLook> {
  return await look(name).catch(
    (error: unknown): StepLook => ({
      kind: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      retry: true,
    })
  );
}

/** The probe's clock and pacing, with defaults. */
function probeTiming(
  deps: Pick<RouteProbeDeps, "sleep" | "now">,
  opts: { readonly pollMs?: number; readonly progressMs?: number }
) {
  return {
    sleep:
      deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    pollMs: opts.pollMs ?? 250,
    progressMs: opts.progressMs ?? 3000,
  };
}

/** The result a look settles its step with, or null to look again. */
function settledBy(look: StepLook): StepResult | null {
  if (look.kind === "answered") {
    return { state: "ready" };
  }
  if (look.kind === "unknown" && !look.retry) {
    return { state: "unknown", detail: look.detail };
  }
  return null;
}

/** A step's result once the bound is reached, from its last look. */
function atBound(final: StepLook | undefined): StepResult {
  if (final?.kind === "refused") {
    return { state: "not-ready", detail: final.detail };
  }
  return {
    state: "unknown",
    detail:
      final?.kind === "unknown" ? final.detail : "no answer within the bound",
  };
}

/**
 * Looks at each step until it answers, until a look says it cannot be
 * checked, or until `timeoutMs`. A step still refused at the bound is
 * `not-ready`; one still unknown is `unknown`.
 */
export async function waitForRoutes(
  deps: RouteProbeDeps,
  opts: {
    readonly timeoutMs: number;
    readonly pollMs?: number;
    readonly progressMs?: number;
  }
): Promise<RouteProbeResult> {
  const { sleep, now, pollMs, progressMs } = probeTiming(deps, opts);
  const started = now();
  let lastProgress = started;
  const done = new Map<RouteProbeStep, StepResult>();
  const last = new Map<RouteProbeStep, StepLook>();
  if (!deps.requestHttps) {
    done.set("https", {
      state: "unknown",
      detail: deps.httpsSkipped ?? "HTTPS through the proxy was not checked",
    });
  }
  const looks: readonly Look[] = [
    ["dns", deps.resolveName],
    ...(deps.requestHttps ? [["https", deps.requestHttps] as Look] : []),
  ];
  const pending = () =>
    looks.map(([step]) => step).filter((step) => !done.has(step));
  for (;;) {
    for (const [step, look] of looks.filter(([step]) => !done.has(step))) {
      const result = await lookAt(look, deps.name ?? ROUTE_PROBE_NAME);
      last.set(step, result);
      const settled = settledBy(result);
      if (settled) {
        done.set(step, settled);
      }
    }
    const elapsed = now() - started;
    if (done.size < 2 && elapsed >= opts.timeoutMs) {
      for (const step of pending()) {
        done.set(step, atBound(last.get(step)));
      }
    }
    if (done.size === 2) {
      return Object.fromEntries(done) as RouteProbeResult;
    }
    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      deps.progress?.({ waitingFor: pending(), elapsedMs: elapsed });
    }
    await sleep(pollMs);
  }
}

/** `nslookup` exit and output, as one look at the DNS step. */
export function classifyNslookup(opts: {
  readonly exitCode: number;
  readonly output: string;
}): StepLook {
  if (opts.exitCode === 0) {
    return { kind: "answered" };
  }
  // 126/127: the image has no runnable nslookup (a v4 proxy file's image).
  if (opts.exitCode === 126 || opts.exitCode === 127) {
    return {
      kind: "unknown",
      detail:
        "the proxy image has no nslookup, so DNS through CoreDNS was not checked",
      retry: false,
    };
  }
  if (DNS_REFUSAL.test(opts.output)) {
    return {
      kind: "refused",
      detail: "CoreDNS did not resolve the name",
    };
  }
  return {
    kind: "unknown",
    detail: "the DNS query through CoreDNS did not complete",
    retry: true,
  };
}

/** `curl` exit and `%{http_code}`, as one look at the HTTPS step. */
export function classifyCurl(opts: {
  readonly exitCode: number;
  readonly status: string;
  readonly address: string;
}): StepLook {
  if (opts.exitCode === 0 && HTTP_STATUS.test(opts.status.trim())) {
    return { kind: "answered" };
  }
  // 7: connection refused. Retried, since the proxy may not listen yet.
  if (opts.exitCode === 7) {
    return {
      kind: "refused",
      detail: `port 443 on ${opts.address} refused the connection`,
    };
  }
  // A timeout or TLS failure on this path is what doctor tolerates (a
  // container runtime that does not forward loopback): not checked.
  return {
    kind: "unknown",
    detail: `HTTPS through port 443 on ${opts.address} did not reach the proxy (curl exit ${opts.exitCode}), so it was not checked; hack doctor reports this path`,
    retry: false,
  };
}

/**
 * The host address for the HTTPS step. A local engine (unix socket, npipe)
 * uses `localAddress`, doctor's choice from the published bindings; a TCP
 * engine uses its host when the proxy publishes on every interface; an SSH
 * or other remote engine cannot be reached from here, so null.
 */
export function routeProbeAddress(opts: {
  readonly engine: string;
  readonly localAddress: string | null;
  readonly publishesAllInterfaces: boolean;
}): string | null {
  const host = opts.engine.startsWith("host:")
    ? opts.engine.slice("host:".length)
    : null;
  if (
    host === null ||
    host.startsWith("unix://") ||
    host.startsWith("npipe://")
  ) {
    return opts.localAddress;
  }
  if (host.startsWith("tcp://") && opts.publishesAllInterfaces) {
    const hostname = new URL(host.replace(TCP_SCHEME, "http:")).hostname;
    return hostname === "" ? null : hostname;
  }
  return null;
}
