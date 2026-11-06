import { isAbsolute } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";

/** Fixed bounds the native runtime also enforces (`image_policy.rs`). */
const MIN_BUDGET_MIB = 16;
const MAX_BUDGET_MIB = 8192;
const MAX_CACHE_MIB = 262_144;
const MAX_LOCAL_REGISTRIES = 16;
const DEFAULT_BUDGET_MIB = 2048;
const DEFAULT_CACHE_MIB = 16_384;
const MEBIBYTES = /^[0-9]{1,8}$/;
const LOCAL_REGISTRY = /^(?:http:\/\/)?[a-z0-9.-]+(?::[0-9]{1,5})?$/;

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
