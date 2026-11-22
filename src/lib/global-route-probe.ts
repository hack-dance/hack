/**
 * End-to-end readiness of the global proxy, after its containers are
 * healthy: a `.hack` name resolved through CoreDNS to the proxy's own
 * address, and TLS through the published port answered by the proxy itself
 * (a certificate its CA issued).
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
import { isIP } from "node:net";
import { DEFAULT_SCHEMAS_HOST } from "../constants.ts";
import {
  type ProxyHttpsState,
  proxyLoopbackEndpoints,
} from "./proxy-loopback.ts";

const DNS_REFUSAL = /NXDOMAIN|can't find|SERVFAIL|REFUSED/i;
const NAME_LINE = /^\s*Name:/;
const ADDRESS_LINE = /^\s*Address(?:\s+\d+)?:\s*([0-9a-fA-F:.]+)\s*$/;
const TCP_SCHEME = /^tcp:/;
const BRACKETS = /^\[|\]$/g;
const SKIPPED_TAIL = /, so HTTPS through the proxy was not checked.*$/;

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

/** The addresses in `nslookup`'s answer (after the server's own lines). */
export function parseNslookupAnswers(output: string): string[] {
  const answers: string[] = [];
  let inAnswer = false;
  for (const line of output.split("\n")) {
    if (NAME_LINE.test(line)) {
      inAnswer = true;
      continue;
    }
    const address = ADDRESS_LINE.exec(line)?.[1];
    if (inAnswer && address && isIP(address) !== 0) {
      answers.push(address);
    }
  }
  return answers;
}

/**
 * `nslookup` exit and output, as one look at the DNS step. An answer counts
 * only when it is not empty and every address in it is one of `expected`,
 * the proxy container's own addresses (CoreDNS answers routed names with
 * Caddy's address); any other address in it is a wrong answer. With `expected` unknown the answer cannot be compared.
 */
export function classifyNslookup(opts: {
  readonly exitCode: number;
  readonly output: string;
  readonly expected: readonly string[] | null;
}): StepLook {
  if (opts.exitCode === 0) {
    const answers = parseNslookupAnswers(opts.output);
    if (opts.expected === null || opts.expected.length === 0) {
      return {
        kind: "unknown",
        detail:
          "the proxy container's address could not be read, so the DNS answer was not compared",
        retry: false,
      };
    }
    // Every address must be the proxy's: a client may pick any of them.
    if (
      answers.length > 0 &&
      answers.every((address) => opts.expected?.includes(address))
    ) {
      return { kind: "answered" };
    }
    return {
      kind: "refused",
      detail: `CoreDNS answered ${answers.length > 0 ? answers.join(", ") : "with no address"}, not only the proxy's address (${opts.expected.join(", ")})`,
    };
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

/**
 * HTTPS looks at each endpoint, as one look at the HTTPS step for `name`
 * (the name the DNS step resolved, used as the TLS name and the `Host`).
 * - Another server's certificate at any endpoint is a refusal: names
 *   resolving to that address reach it instead of the proxy.
 * - Ready when an endpoint answered HTTP on a connection verified against
 *   the running proxy's CA for `name` (one family is enough, as in doctor).
 * - A TLS alert (a TLS server refused `name`, as Caddy does for a name it
 *   does not serve) or a refused port is a refusal.
 * - A timeout, or a connection that ended without an alert, is the path
 *   doctor tolerates (a container runtime that does not forward the port
 *   cleanly): not checked.
 */
export function classifyHttps(
  looks: readonly {
    readonly address: string;
    readonly state: ProxyHttpsState;
  }[],
  name: string = ROUTE_PROBE_NAME
): StepLook {
  const impostor = looks.find((look) => look.state === "untrusted");
  if (impostor) {
    return {
      kind: "refused",
      detail: `port 443 on ${impostor.address} answered with a certificate this home's proxy did not issue for ${name} (another server is answering there, or the proxy does not serve that name)`,
    };
  }
  if (looks.some((look) => look.state === "ok")) {
    return { kind: "answered" };
  }
  const rejected = looks.find((look) => look.state === "rejected");
  if (rejected) {
    return {
      kind: "refused",
      detail: `port 443 on ${rejected.address} refused TLS for ${name}: the server there does not serve that name`,
    };
  }
  const refused = looks.find((look) => look.state === "unreachable");
  if (refused) {
    return {
      kind: "refused",
      detail: `port 443 on ${refused.address} refused the connection`,
    };
  }
  const where = looks.map((look) => look.address).join(", ");
  return {
    kind: "unknown",
    detail: `HTTPS for ${name} through port 443 on ${where} did not complete (${looks.map((look) => look.state).join(", ")}), so it was not checked; hack doctor reports this path`,
    retry: false,
  };
}

const NOT_RESOLVED_HINT =
  "hack global install sets up Hack's domains, and hack doctor shows the DNS checks";

/**
 * One look at the HTTPS step for `name`, sent where this machine would send
 * it: the addresses the OS resolver gives for `name` (resolver files, hosts
 * file and local overrides included). A refusal or a foreign certificate at
 * an address the OS resolves is a refusal; the per-family rule of
 * {@link classifyHttps} applies across those addresses.
 *
 * When the OS has no address for `name` (Hack's DNS not set up yet), the
 * `fallback` endpoints (the proxy's loopback bindings, or the engine's
 * address) are probed instead; an answer there is ready, but a refusal there
 * is only "not checked": nothing on this machine is sent there yet, and a
 * container runtime may hold the loopback port with something else.
 */
export async function lookHttps(opts: {
  readonly name: string;
  readonly resolve: (name: string) => Promise<readonly string[]>;
  readonly fallback:
    | { readonly addresses: readonly string[] }
    | { readonly skipped: string };
  readonly probe: (
    addresses: readonly string[]
  ) => Promise<
    readonly { readonly address: string; readonly state: ProxyHttpsState }[]
  >;
}): Promise<StepLook> {
  const resolved = await opts.resolve(opts.name).catch(() => []);
  if (resolved.length > 0) {
    return classifyHttps(await opts.probe(resolved), opts.name);
  }
  if ("skipped" in opts.fallback) {
    return {
      kind: "unknown",
      detail: `${opts.name} has no address on this machine yet (${NOT_RESOLVED_HINT}), and ${opts.fallback.skipped.replace(SKIPPED_TAIL, "")}, so HTTPS through the proxy was not checked`,
      retry: false,
    };
  }
  const look = classifyHttps(
    await opts.probe(opts.fallback.addresses),
    opts.name
  );
  if (look.kind !== "refused") {
    return look;
  }
  return {
    kind: "unknown",
    detail: `${opts.name} has no address on this machine yet (${NOT_RESOLVED_HINT}); at the proxy's published loopback ${look.detail}, so HTTPS through the proxy was not checked`,
    retry: false,
  };
}

/**
 * Where to send the HTTPS step, from the running proxy's live 443
 * bindings: for a local engine (unix socket, npipe) the loopback endpoints
 * doctor checks (`proxyLoopbackEndpoints`); for a TCP engine given by
 * address, that address when the proxy publishes 443 on every interface.
 * Anything else cannot be reached from here: `skipped` says why.
 */
export function routeHttpsTargets(opts: {
  readonly engine: string;
  /** Live loopback bindings of the proxy, or null when unknown. */
  readonly loopbackPorts: Readonly<Record<80 | 443, readonly string[]>> | null;
}): { readonly addresses: readonly string[] } | { readonly skipped: string } {
  if (opts.loopbackPorts === null) {
    return {
      skipped:
        "the running proxy's published ports could not be read, so HTTPS through the proxy was not checked",
    };
  }
  const host = opts.engine.startsWith("host:")
    ? opts.engine.slice("host:".length)
    : null;
  if (
    host === null ||
    host.startsWith("unix://") ||
    host.startsWith("npipe://")
  ) {
    const endpoints = proxyLoopbackEndpoints({
      loopbackPorts: opts.loopbackPorts,
      ports: [443],
    });
    return endpoints.length > 0
      ? { addresses: endpoints.map((endpoint) => endpoint.address) }
      : {
          skipped:
            "the proxy does not publish port 443 on a loopback address, so HTTPS through the proxy was not checked (as in hack doctor)",
        };
  }
  if (host.startsWith("tcp://")) {
    const everywhere = opts.loopbackPorts[443].some(
      (binding) => binding === "0.0.0.0" || binding === "::"
    );
    const hostname = new URL(
      host.replace(TCP_SCHEME, "http:")
    ).hostname.replace(BRACKETS, "");
    if (!everywhere) {
      return {
        skipped:
          "the Docker engine is remote and the proxy does not publish port 443 on every interface, so HTTPS through the proxy was not checked",
      };
    }
    return isIP(hostname) !== 0
      ? { addresses: [hostname] }
      : {
          skipped: `the Docker engine is given by host name (${hostname}), which is not resolved here, so HTTPS through the proxy was not checked`,
        };
  }
  return {
    skipped:
      "the Docker engine is not local and its address is not known here, so HTTPS through the proxy was not checked",
  };
}
