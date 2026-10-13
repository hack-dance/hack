import { createHmac, randomBytes } from "node:crypto";

import { isRecord } from "./guards.ts";

/**
 * Value-free fingerprints of the env set Hack delivered to each compose
 * service when it last (re)created that service.
 *
 * `hack up` and `hack restart` record one keyed digest per service in the
 * project runtime state (`.hack/.internal/runtime-state.json`). `hack exec`
 * recomputes the digest for the env set that the same resolver produces now
 * and, when it differs, prints a closed warning: the running container still
 * has the env it started with until the service is recreated.
 *
 * Invariants:
 * - Digests are HMAC-SHA256 over a canonical encoding of the resolved
 *   key/value pairs, keyed by a random per-record salt. The record never holds
 *   a key name or value, and the salt prevents precomputed or cross-project
 *   comparison of low-entropy values.
 * - Comparison is advisory. A missing, malformed, or foreign record yields
 *   `unknown` and no warning; it never refuses exec.
 * - Everything here is pure except salt generation; callers own all I/O.
 */

/** Current record encoding; any other version is treated as absent. */
export const COMPOSE_ENV_FINGERPRINT_VERSION = 1 as const;

const FINGERPRINT_DOMAIN = "hack.compose-service-env.v1";
const SALT_PATTERN = /^[0-9a-f]{32}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Compose service-name grammar. Names outside it are never recorded or echoed.
 */
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type ComposeEnvFingerprintRecord = {
  readonly version: typeof COMPOSE_ENV_FINGERPRINT_VERSION;
  /** 16 random bytes, lowercase hex. */
  readonly salt: string;
  /** Compose service name to lowercase-hex HMAC-SHA256 digest. */
  readonly services: Readonly<Record<string, string>>;
};

export type ComposeServiceEnvFreshness = "unchanged" | "changed" | "unknown";

/** Fresh random salt for a new fingerprint record. */
export function createComposeEnvFingerprintSalt(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Keyed digest of one resolved env set. Key order does not matter; any key,
 * value, addition, or removal changes the digest.
 */
export function computeComposeEnvFingerprint(opts: {
  readonly salt: string;
  readonly env: Readonly<Record<string, string>>;
}): string {
  if (!SALT_PATTERN.test(opts.salt)) {
    throw new Error("Invalid compose env fingerprint salt.");
  }
  const entries = Object.entries(opts.env).sort(([left], [right]) =>
    compareCodeUnits(left, right)
  );
  return createHmac("sha256", Buffer.from(opts.salt, "hex"))
    .update(FINGERPRINT_DOMAIN)
    .update("\0")
    .update(JSON.stringify(entries))
    .digest("hex");
}

/**
 * Record or refresh the digests of `services` from `envByService`, keeping
 * every other service's digest and the existing salt. A service with no
 * resolved entry is recorded as an empty env set.
 */
export function withComposeServiceEnvFingerprints(opts: {
  readonly existing: ComposeEnvFingerprintRecord | undefined;
  readonly services: readonly string[];
  readonly envByService: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly createSalt?: () => string;
}): ComposeEnvFingerprintRecord {
  const salt =
    opts.existing?.salt ??
    (opts.createSalt ?? createComposeEnvFingerprintSalt)();
  const services: Record<string, string> = { ...opts.existing?.services };
  for (const service of opts.services) {
    if (!SERVICE_NAME_PATTERN.test(service)) {
      continue;
    }
    const env = Object.hasOwn(opts.envByService, service)
      ? (opts.envByService[service] ?? {})
      : {};
    services[service] = computeComposeEnvFingerprint({ salt, env });
  }
  return {
    version: COMPOSE_ENV_FINGERPRINT_VERSION,
    salt,
    services: sortRecord(services),
  };
}

/**
 * Forget the digests of `services` (their delivered env is no longer known).
 * Returns undefined when nothing remains.
 */
export function withoutComposeServiceEnvFingerprints(opts: {
  readonly existing: ComposeEnvFingerprintRecord | undefined;
  readonly services: readonly string[];
}): ComposeEnvFingerprintRecord | undefined {
  if (!opts.existing) {
    return;
  }
  const forgotten = new Set(opts.services);
  const services = Object.fromEntries(
    Object.entries(opts.existing.services).filter(
      ([service]) => !forgotten.has(service)
    )
  );
  if (Object.keys(services).length === 0) {
    return;
  }
  return { ...opts.existing, services: sortRecord(services) };
}

/** Compare the recorded digest for `service` with the env resolved now. */
export function evaluateComposeServiceEnvFreshness(opts: {
  readonly record: ComposeEnvFingerprintRecord | undefined;
  readonly service: string;
  readonly currentEnv: Readonly<Record<string, string>>;
}): ComposeServiceEnvFreshness {
  const record = opts.record;
  if (!(record && Object.hasOwn(record.services, opts.service))) {
    return "unknown";
  }
  const recorded = record.services[opts.service];
  const current = computeComposeEnvFingerprint({
    salt: record.salt,
    env: opts.currentEnv,
  });
  return recorded === current ? "unchanged" : "changed";
}

/**
 * Closed, value-free warning for a stale running service. Names the service
 * only when it matches the compose service-name grammar.
 */
export function buildStaleComposeEnvWarning(opts: {
  readonly service: string;
}): string {
  const named = SERVICE_NAME_PATTERN.test(opts.service);
  const subject = named ? `service "${opts.service}"` : "this service";
  const restart = named
    ? `hack restart ${opts.service}`
    : "hack restart <service>";
  return `Env for ${subject} changed since it started; this exec uses the env it started with. Run \`${restart}\` to apply the current env.`;
}

/**
 * Closed, value-free warning for a stale running native service (HACK-1140).
 * Native restart is whole-project, so the hint never names a service.
 *
 * - `started`: the exec runs with the env the service started with (authored
 *   native exec through the live owner).
 * - `fresh`: the exec itself received freshly resolved values, but the running
 *   service keeps its start-time env (native image-project exec).
 */
export function buildStaleNativeEnvWarning(opts: {
  readonly service: string;
  readonly exec: "started" | "fresh";
}): string {
  const subject = SERVICE_NAME_PATTERN.test(opts.service)
    ? `service "${opts.service}"`
    : "this service";
  const effect =
    opts.exec === "started"
      ? "this exec uses the env it started with"
      : "the running service still uses the env it started with";
  return `Env for ${subject} changed since it started; ${effect}. Run \`hack restart\` to apply the current env.`;
}

/** Strict parse of a stored record; anything unexpected is treated as absent. */
export function parseComposeEnvFingerprintRecord(
  value: unknown
): ComposeEnvFingerprintRecord | undefined {
  if (!isRecord(value)) {
    return;
  }
  if (value.version !== COMPOSE_ENV_FINGERPRINT_VERSION) {
    return;
  }
  const salt = value.salt;
  if (typeof salt !== "string" || !SALT_PATTERN.test(salt)) {
    return;
  }
  const rawServices = value.services;
  if (!isRecord(rawServices)) {
    return;
  }
  const services: Record<string, string> = {};
  for (const [service, digest] of Object.entries(rawServices)) {
    if (
      !SERVICE_NAME_PATTERN.test(service) ||
      typeof digest !== "string" ||
      !DIGEST_PATTERN.test(digest)
    ) {
      return;
    }
    services[service] = digest;
  }
  return {
    version: COMPOSE_ENV_FINGERPRINT_VERSION,
    salt,
    services: sortRecord(services),
  };
}

function sortRecord(
  input: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) =>
      compareCodeUnits(left, right)
    )
  );
}

/** Locale-independent ordering so digests are stable across hosts. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
