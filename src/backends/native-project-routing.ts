import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { HACK_OWNERSHIP_LABEL_NAMESPACES } from "../lib/hack-ownership-labels.ts";
import { isIgnoredHackComposeLabel } from "../lib/native-hack-compose-conventions.ts";
import { isInferredNativeRouteProbe } from "./native-http-probe-admission.ts";
import { hasOnlyNativeCacheLabels } from "./native-project-cache.ts";

const ROUTE_LABELS = new Set(["caddy", "caddy.reverse_proxy", "caddy.tls"]);
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function refused(): Error {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native routes require reviewed Caddy labels and matching native route readiness; explicit healthchecks are never replaced.",
  });
}

const ROUTE_PROBE_REFUSALS = {
  disabled: {
    message: "The routed service explicitly disables its healthcheck.",
    fix: "Replace the disabled healthcheck with an x-hack-http-only healthcheck on the route port, or remove the healthcheck declaration to use the inferred probe.",
  },
  command: {
    message:
      "The routed service has a command-only healthcheck; native route readiness requires an HTTP probe.",
    fix: "Replace the command healthcheck with an x-hack-http-only healthcheck on the route port, or remove the healthcheck declaration to use the inferred probe.",
  },
  cache: {
    message:
      "The routed service also declares a dependency cache, which native routing does not support.",
    fix: "Move the dependency cache to a separate non-routed service, or remove the dependency cache declaration.",
  },
  mismatch: {
    message:
      "The route has no valid reviewed HTTP probe matching its route port and authored healthcheck.",
    fix: "Check the route port and healthcheck.x-hack-http; remove the authored healthcheck to infer readiness, or configure a valid explicit HTTP probe on that port. If the review still differs, update Hack and rerun native preflight.",
  },
} as const;

/** Closed reasons shared by startup admission and preflight; no authored values. */
class RouteProbeRefusal extends HackCliError {
  readonly reason: keyof typeof ROUTE_PROBE_REFUSALS;
  constructor(reason: keyof typeof ROUTE_PROBE_REFUSALS) {
    const detail = ROUTE_PROBE_REFUSALS[reason];
    super({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: `${detail.message} ${detail.fix}`,
    });
    this.reason = reason;
  }
}

export function nativeRouteProbeRefusalDetails(error: unknown): {
  readonly message: string;
  readonly fix: string;
} {
  return ROUTE_PROBE_REFUSALS[
    error instanceof RouteProbeRefusal ? error.reason : "mismatch"
  ];
}
/**
 * Hack's authored one-shot marker. Only this exact key with the literal value `true`
 * (map form) or the exact entry `hack.service.one-shot=true` (list form) is admitted,
 * matching the native review; the review owns its completion role and conflicts.
 */
const ONE_SHOT_LABEL = "hack.service.one-shot";
function labelEntries(
  labels: unknown
): (readonly [string, unknown])[] | undefined {
  if (labels === undefined) {
    return [];
  }
  if (isRecord(labels)) {
    return Object.entries(labels);
  }
  if (
    Array.isArray(labels) &&
    labels.every((label) => typeof label === "string")
  ) {
    return labels.map((label: string) => {
      const separator = label.indexOf("=");
      return separator < 0
        ? [label, undefined]
        : [label.slice(0, separator), label.slice(separator + 1)];
    });
  }
  return undefined;
}
function labelKeys(labels: unknown): string[] | undefined {
  return labelEntries(labels)?.map(([key]) => key);
}
/**
 * Router label families. Caddy and Traefik label dialects also use forms such
 * as `caddy_0` and `caddy_ingress_network`, so any key that starts with the
 * word belongs to the router.
 */
const ROUTER_LABEL_WORDS = ["caddy", "traefik"] as const;

/** Runtime and Hack namespaces: the exact key and everything under it. */
const RESERVED_LABEL_NAMESPACES = ["hack", "com.docker.compose"] as const;

/**
 * Whether a label is plain metadata, such as `com.example.team` or
 * `org.opencontainers.image.source`: outside every Hack ownership namespace,
 * every router label family and every reserved namespace. Native never sends
 * such a label to the engine, so it cannot change a run; the native review
 * reports it as `labels_not_applied`. Mirrors `inert_metadata_label` in
 * `packages/runtime-core/src/project/compose/mod.rs`.
 */
export function isInertMetadataLabel(key: string): boolean {
  return (
    isIgnoredHackComposeLabel(key) ||
    !(
      HACK_OWNERSHIP_LABEL_NAMESPACES.some(
        (namespace) =>
          key.startsWith(namespace) || key === namespace.slice(0, -1)
      ) ||
      ROUTER_LABEL_WORDS.some((word) => key.startsWith(word)) ||
      RESERVED_LABEL_NAMESPACES.some(
        (prefix) => key === prefix || key.startsWith(`${prefix}.`)
      )
    )
  );
}

/** Values and complete routing semantics remain native review's responsibility. */
export function hasOnlyNativeSupportedLabels(labels: unknown): boolean {
  return (
    labelEntries(labels)?.every(
      ([key, value]) =>
        ROUTE_LABELS.has(key) ||
        hasOnlyNativeCacheLabels({ [key]: "" }) ||
        (key === ONE_SHOT_LABEL && value === "true") ||
        isInertMetadataLabel(key)
    ) ?? false
  );
}

/** Only bounded label keys are named in refusals; label values are never printed. */
export function unsupportedNativeLabelKeys(labels: unknown): readonly string[] {
  return (labelEntries(labels) ?? [])
    .filter(([key, value]) => !hasOnlyNativeSupportedLabels({ [key]: value }))
    .map(([key]) => (LABEL_KEY.test(key) ? key : "[invalid-label]"))
    .slice(0, 32)
    .sort();
}

/** Log drivers that keep logs in the engine; native reviews them and applies none. */
const LOCAL_LOGGING_DRIVERS = new Set(["json-file", "local", "none"]);

/**
 * Whether a service's `logging` is absent or names a local driver. The native
 * review reports an admitted block as `logging_not_applied`; an external sink
 * stays refused.
 */
export function hasOnlyNativeSupportedLogging(logging: unknown): boolean {
  if (logging === undefined) {
    return true;
  }
  return (
    isRecord(logging) &&
    (logging.driver === undefined ||
      (typeof logging.driver === "string" &&
        LOCAL_LOGGING_DRIVERS.has(logging.driver)))
  );
}
/**
 * Count all declared routes, including inactive profiles, before allocating the pool.
 *
 * This runs before the profile-aware review, so it is a conservative upper bound: profile
 * activation stays the reviewed plan's decision, and `reviewedNativeRoutes` must never find
 * more active routes than this floor. Unlike readiness goals, an unused slot is harmless.
 */
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
  if (
    service.dependency_cache !== undefined &&
    service.dependency_cache !== null
  ) {
    throw new RouteProbeRefusal("cache");
  }
  const authored = spec?.healthcheck;
  if (
    (isRecord(service.healthcheck) && service.healthcheck.disabled === true) ||
    (isRecord(authored) &&
      (authored.disable === true ||
        (Array.isArray(authored.test) && authored.test[0] === "NONE")))
  ) {
    throw new RouteProbeRefusal("disabled");
  }
  if (
    isRecord(authored) &&
    !Object.hasOwn(authored, "x-hack-http") &&
    Object.hasOwn(authored, "test")
  ) {
    throw new RouteProbeRefusal("command");
  }
  const probe =
    spec && isRecord(spec.healthcheck)
      ? spec.healthcheck["x-hack-http"]
      : undefined;
  const reviewedProbe = isRecord(service.healthcheck)
    ? service.healthcheck.native_http
    : undefined;
  const inferred =
    spec !== undefined &&
    !Object.hasOwn(spec, "healthcheck") &&
    isRecord(service.routing) &&
    isInferredNativeRouteProbe(reviewedProbe, service.routing.port);
  if (
    !(
      isRecord(service.routing) &&
      isRecord(reviewedProbe) &&
      Number.isInteger(service.routing.port)
    ) ||
    Number(service.routing.port) < 1 ||
    Number(service.routing.port) > 65_535 ||
    !(
      inferred ||
      (isRecord(probe) &&
        probe.port === service.routing.port &&
        reviewedProbe.policy === undefined)
    ) ||
    reviewedProbe.port !== service.routing.port
  ) {
    throw new RouteProbeRefusal("mismatch");
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
    // The provider reserves all slots under its pool mutation lock. A local
    // index would collide with other graphs already using the same pool.
    flags: routed.flatMap((name) => ["--route-slot", `${name}=auto`]),
    services: new Set(routed),
  };
}
