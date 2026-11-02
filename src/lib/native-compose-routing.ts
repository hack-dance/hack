import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";
import {
  nativeRoutingSelectionMatches,
  parseNativeRoutingResolution,
} from "./native-routing-plan-protocol.ts";

/** Public routing intent only. This result does not claim DNS, TLS or proxy ownership. */
export type NativeComposeRouting = {
  readonly labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly hostnames: readonly string[];
  readonly origins: readonly string[];
  readonly network: typeof DEFAULT_INGRESS_NETWORK;
};

export class NativeComposeRoutingError extends Error {
  readonly code = "E_NATIVE_COMPOSE_ROUTING";

  constructor() {
    super(
      "Native Compose routing is unsupported or inconsistent; values omitted."
    );
    this.name = "NativeComposeRoutingError";
  }
}

function refused(): never {
  throw new NativeComposeRoutingError();
}

type RoutingOptions = {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly resolution: unknown;
  readonly declared?: NativeDeclaredWorkloads;
};

function resolvedRouting(opts: RoutingOptions) {
  const resolution = parseNativeRoutingResolution(opts.resolution);
  if (
    !(
      resolution &&
      nativeRoutingSelectionMatches({
        plan: opts.plan,
        declared: opts.declared,
        resolution,
        required: true,
        branch: resolution.branch,
        ...(resolution.domain_origin === "explicit"
          ? { explicitDomain: resolution.domain }
          : {}),
        ...(resolution.domain_origin === "global"
          ? { globalDomain: resolution.domain }
          : {}),
      }) &&
      isRecord(opts.plan.services)
    )
  ) {
    return refused();
  }
  return resolution;
}

/**
 * Translate the compiler's already selected origins into isolated Caddy label groups.
 * The command owner must admit every hostname against the selected engine and shared
 * ingress before using these labels. No file, network, registry or certificate effects.
 */
export function planNativeComposeRouting(
  opts: RoutingOptions
): NativeComposeRouting | null {
  if (opts.plan.routes === undefined && opts.plan.open === undefined) {
    if (opts.resolution !== undefined) {
      return refused();
    }
    return null;
  }
  const resolution = resolvedRouting(opts);
  const labels = new Map<string, Record<string, string>>();
  const indexes = new Map<string, number>();
  const seen = new Set<string>();
  const hosts = new Set<string>();
  for (const name of Object.keys(resolution.routes).sort()) {
    const route = resolution.routes[name];
    if (!route) {
      return refused();
    }
    const origins = [route.origin, ...Object.values(route.aliases)].sort();
    // Standard global ingress owns ports 80/443. Nonstandard origins require a
    // separately qualified ingress binding; never silently route them elsewhere.
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.port !== "" || seen.has(origin)) {
        return refused();
      }
      seen.add(origin);
      hosts.add(url.hostname);
    }
    const fields = labels.get(route.service) ?? {};
    const index = indexes.get(route.service) ?? 0;
    const prefix = `caddy_${index}`;
    fields[prefix] = origins.join(", ");
    fields[`${prefix}.reverse_proxy`] =
      `{{upstreams ${route.protocol} ${route.port}}}`;
    if (origins.some((origin) => origin.startsWith("https://"))) {
      fields[`${prefix}.tls`] = "internal";
    }
    fields.caddy_ingress_network = DEFAULT_INGRESS_NETWORK;
    labels.set(route.service, fields);
    indexes.set(route.service, index + 1);
  }
  if (seen.size === 0) {
    return refused();
  }
  return Object.freeze({
    labels: Object.freeze(
      Object.fromEntries(
        [...labels].map(([service, fields]) => [service, Object.freeze(fields)])
      )
    ),
    hostnames: Object.freeze([...hosts].sort()),
    origins: Object.freeze([...seen].sort()),
    network: DEFAULT_INGRESS_NETWORK,
  });
}
