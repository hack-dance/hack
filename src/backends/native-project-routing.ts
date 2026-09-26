import { isRecord } from "../lib/guards.ts";
import { hasOnlyNativeCacheLabels } from "./native-project-cache.ts";

const ROUTE_LABELS = new Set(["caddy", "caddy.reverse_proxy", "caddy.tls"]);
function refused(): Error {
  return new Error(
    "Native routes require reviewed Caddy labels and existing matching native HTTP health probes; no probe or route was invented."
  );
}
function labelKeys(labels: unknown): string[] | undefined {
  if (labels === undefined) {
    return [];
  }
  if (isRecord(labels)) {
    return Object.keys(labels);
  }
  if (
    Array.isArray(labels) &&
    labels.every((label) => typeof label === "string")
  ) {
    return labels.map((label: string) => label.split("=", 1)[0] ?? "");
  }
  return undefined;
}
/** Values and complete routing semantics remain native review's responsibility. */
export function hasOnlyNativeSupportedLabels(labels: unknown): boolean {
  return (
    labelKeys(labels)?.every(
      (key) => ROUTE_LABELS.has(key) || hasOnlyNativeCacheLabels({ [key]: "" })
    ) ?? false
  );
}
/** Count all declared routes, including inactive profiles, before allocating the pool. */
export function nativeBridgeCapacity(
  specs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): number {
  const count = Object.values(specs).filter((spec) =>
    labelKeys(spec.labels)?.some((key) => ROUTE_LABELS.has(key))
  ).length;
  if (count > 32) {
    throw refused();
  }
  return count;
}
function requireRouteProbe(
  service: Readonly<Record<string, unknown>>,
  spec: Readonly<Record<string, unknown>> | undefined
): void {
  const probe =
    spec && isRecord(spec.healthcheck)
      ? spec.healthcheck["x-hack-http"]
      : undefined;
  const reviewedProbe = isRecord(service.healthcheck)
    ? service.healthcheck.native_http
    : undefined;
  if (
    !(
      isRecord(service.routing) &&
      isRecord(probe) &&
      isRecord(reviewedProbe) &&
      Number.isInteger(service.routing.port)
    ) ||
    Number(service.routing.port) < 1 ||
    Number(service.routing.port) > 65_535 ||
    probe.port !== service.routing.port ||
    reviewedProbe.port !== service.routing.port ||
    (isRecord(service.healthcheck) && service.healthcheck.disabled === true) ||
    (service.dependency_cache !== undefined &&
      service.dependency_cache !== null)
  ) {
    throw refused();
  }
}
export function reviewedNativeRoutes(opts: {
  readonly plan: unknown;
  readonly specs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly capacity: number;
}): {
  readonly flags: readonly string[];
  readonly services: ReadonlySet<string>;
} {
  if (!(isRecord(opts.plan) && isRecord(opts.plan.services))) {
    throw refused();
  }
  const routed: string[] = [];
  for (const [name, service] of Object.entries(opts.plan.services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    if (
      service.active !== true ||
      service.routing === undefined ||
      service.routing === null
    ) {
      continue;
    }
    requireRouteProbe(service, opts.specs[name]);
    routed.push(name);
  }
  if (routed.length > opts.capacity || routed.length > 32) {
    throw refused();
  }
  routed.sort();
  return {
    flags: routed.flatMap((name, index) => [
      "--route-slot",
      `${name}=${index}`,
    ]),
    services: new Set(routed),
  };
}
