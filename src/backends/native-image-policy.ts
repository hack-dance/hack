import { isAbsolute } from "node:path";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";

/** Fixed bounds the native runtime also enforces (`image_policy.rs`). */
const MIN_BUDGET_MIB = 16;
const MAX_BUDGET_MIB = 8192;
const MAX_CACHE_MIB = 262_144;
const MAX_LOCAL_REGISTRIES = 16;
const DEFAULT_BUDGET_MIB = 2048;
const DEFAULT_CACHE_MIB = 16_384;
const REGISTRY_HTTP_STATUS = /^registry_http_[45][0-9]{2}$/;
const SECONDS = /^[0-9]+$/;
const MEBIBYTES = /^[0-9]{1,8}$/;
const LOCAL_REGISTRY = /^(?:http:\/\/)?[a-z0-9.-]+(?::[0-9]{1,5})?$/;

export function nativeImageRegistryReason(code: unknown): string | undefined {
  switch (code) {
    case "registry_unreachable":
      return "registry unreachable";
    case "registry_headers_stalled":
      return "registry did not answer";
    case "registry_body_stalled":
      return "registry download stalled";
    case "registry_tls_handshake":
      return "registry TLS handshake failed";
    case "registry_certificate":
      return "registry certificate was not trusted";
    case "registry_transfer_failed":
      return "registry transfer failed";
    case "registry_digest_mismatch":
      return "registry digest mismatch";
    case "registry_http_429":
      return "registry rate limit reached";
    case "registry_http_404":
      return "tag no longer exists in the registry (404)";
    case "registry_http_401":
      return "registry refused access (401)";
    case "registry_http_403":
      return "registry refused access (403)";
    case "registry_refresh_failed":
      return "registry refresh failed";
    default:
      return typeof code === "string" && REGISTRY_HTTP_STATUS.test(code)
        ? `registry request failed (${code.slice(14)})`
        : undefined;
  }
}

const DISPLAY_REFERENCE = /^[A-Za-z0-9._:/@-]{1,512}$/;
export type NativeImageBlockerDetail = {
  readonly missing: string;
  readonly downloading?: true;
  readonly reason?: string;
  readonly present: readonly string[] | null;
};

export function nativeImageBlockerDetail(
  value: unknown
): value is NativeImageBlockerDetail {
  if (
    typeof value !== "object" ||
    value === null ||
    !("missing" in value && "present" in value)
  ) {
    return false;
  }
  return (
    (!("downloading" in value) || value.downloading === true) &&
    (!("reason" in value) ||
      nativeImageRegistryReason(value.reason) !== undefined) &&
    typeof value.missing === "string" &&
    DISPLAY_REFERENCE.test(value.missing) &&
    (value.present === null ||
      (Array.isArray(value.present) &&
        value.present.length <= 32 &&
        value.present.every(
          (image: unknown) =>
            typeof image === "string" && DISPLAY_REFERENCE.test(image)
        )))
  );
}

export class NativeImageBlocker extends ClosedCliError {
  readonly observation: NativeImageBlockerDetail;

  constructor(observation: NativeImageBlockerDetail) {
    const { missing, present } = observation;
    const registryReason = nativeImageRegistryReason(observation.reason);
    const known =
      present === null
        ? "could not verify"
        : present.join(", ") || "none confirmed";
    super(
      [
        observation.downloading
          ? `Image unavailable: another start is downloading ${missing}.`
          : `Image unavailable: ${missing} has no usable recorded resolution in the running guest${registryReason ? ` (${registryReason})` : ""}.`,
        `Already present: ${known}.`,
        observation.downloading
          ? "Run hack up again after the download finishes."
          : "Run hack pull when the registry is reachable, then retry hack up.",
      ].join("\n")
    );
    this.observation = observation;
  }
}

export const DEFAULT_NATIVE_IMAGE_TAG_TTL_SECONDS = 86_400;

export function nativeImageTagTtlSeconds(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env.HACK_NATIVE_IMAGE_TAG_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_NATIVE_IMAGE_TAG_TTL_SECONDS;
  }
  const ttl = Number(raw);
  if (!(SECONDS.test(raw) && Number.isSafeInteger(ttl) && ttl <= 2_592_000)) {
    throw invalid(
      "HACK_NATIVE_IMAGE_TAG_TTL_SECONDS must be a whole number from 0 to 2592000 seconds."
    );
  }
  return ttl;
}

/**
 * Image acquisition time for one `runtime ensure-image` request: registry transfer plus
 * import. The runtime bounds acquisition (360 s) and import (220 s) inside it.
 */
export const NATIVE_IMAGE_ENSURE_TIMEOUT_MS = 600_000;

function invalid(message: string): HackCliError {
  return new HackCliError({ code: "E_CONFIG_INVALID", message });
}

function mebibytes(opts: {
  readonly name: string;
  readonly value: string;
  readonly max: number;
}): string {
  const parsed = MEBIBYTES.test(opts.value) ? Number(opts.value) : Number.NaN;
  if (!(parsed >= MIN_BUDGET_MIB && parsed <= opts.max)) {
    throw invalid(
      `${opts.name} must be a whole number of MiB from ${MIN_BUDGET_MIB} to ${opts.max}.`
    );
  }
  return String(parsed);
}

/**
 * Native image policy flags derived from the caller's environment, appended to the
 * runtime's `admit-image` and `ensure-image` requests. The runtime child receives only a
 * fixed system environment, so these settings travel as explicit flags:
 *
 * - `HACK_NATIVE_IMAGE_BUDGET_MIB`: per-image compressed archive budget (default 2048).
 * - `HACK_NATIVE_IMAGE_TAG_TTL_SECONDS`: tag resolution lifetime (default 86400).
 * - `HACK_NATIVE_IMAGE_CACHE_MIB`: total image cache budget (default 16384).
 * - `HACK_NATIVE_LOCAL_REGISTRIES`: comma-separated `[http://]host[:port]` registries that
 *   are otherwise refused as local; `http://` selects plain HTTP.
 * - `DOCKER_CONFIG`: absolute Docker configuration directory for read-only credential
 *   lookup (default `~/.docker`).
 *
 * Values are not secrets. Invalid values throw a value-free `E_CONFIG_INVALID` before
 * any runtime request.
 */
export function nativeImagePolicyArgs(
  env: Readonly<Record<string, string | undefined>> = process.env
): string[] {
  const args: string[] = [];
  const budget = env.HACK_NATIVE_IMAGE_BUDGET_MIB?.trim();
  if (budget) {
    args.push(
      "--image-budget-mib",
      mebibytes({
        name: "HACK_NATIVE_IMAGE_BUDGET_MIB",
        value: budget,
        max: MAX_BUDGET_MIB,
      })
    );
  }
  const cache = env.HACK_NATIVE_IMAGE_CACHE_MIB?.trim();
  if (cache) {
    args.push(
      "--image-cache-mib",
      mebibytes({
        name: "HACK_NATIVE_IMAGE_CACHE_MIB",
        value: cache,
        max: MAX_CACHE_MIB,
      })
    );
  }
  const budgetMib = budget ? Number(budget) : DEFAULT_BUDGET_MIB;
  const cacheMib = cache ? Number(cache) : DEFAULT_CACHE_MIB;
  if (cacheMib < budgetMib) {
    throw invalid(
      "HACK_NATIVE_IMAGE_CACHE_MIB must be at least HACK_NATIVE_IMAGE_BUDGET_MIB."
    );
  }
  if (env.HACK_NATIVE_IMAGE_TAG_TTL_SECONDS?.trim()) {
    args.push("--image-tag-ttl-seconds", String(nativeImageTagTtlSeconds(env)));
  }
  const registries = (env.HACK_NATIVE_LOCAL_REGISTRIES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (
    registries.length > MAX_LOCAL_REGISTRIES ||
    new Set(registries).size !== registries.length ||
    !registries.every((entry) => LOCAL_REGISTRY.test(entry))
  ) {
    throw invalid(
      `HACK_NATIVE_LOCAL_REGISTRIES must list at most ${MAX_LOCAL_REGISTRIES} unique [http://]host[:port] entries separated by commas.`
    );
  }
  for (const registry of registries) {
    args.push("--allow-local-registry", registry);
  }
  const dockerConfig = env.DOCKER_CONFIG?.trim();
  if (dockerConfig) {
    if (!isAbsolute(dockerConfig) || dockerConfig.length > 1024) {
      throw invalid(
        "DOCKER_CONFIG must be an absolute directory for native image credentials."
      );
    }
    args.push("--docker-config", dockerConfig);
  }
  return args;
}
