import { resolve } from "node:path";

import { GLOBAL_CONFIG_FILENAME, GLOBAL_HACK_DIR_NAME } from "../constants.ts";
import { readHackHomeOverride, resolveUserHomeDir } from "./home-dir.ts";

/**
 * Resolve the global hack home directory (`~/.hack` by default).
 *
 * Resolution order:
 * 1. `HACK_HOME` env var (trimmed, non-empty) — used as-is. It must be an
 *    absolute path; a relative value throws. This override exists for tests
 *    and isolated environments that need to redirect ALL global state
 *    (registry, caddy assets, daemon state, secrets) without overriding `HOME`.
 * 2. `<home>/.hack`, where an empty or relative `HOME` is treated as unset
 *    (see {@link resolveUserHomeDir}). Never resolves against the cwd.
 */
export function resolveGlobalHackDir(): string {
  const override = readHackHomeOverride();
  if (override) {
    return override;
  }
  return resolve(resolveUserHomeDir(), GLOBAL_HACK_DIR_NAME);
}

/**
 * Resolve the global hack.config.json path (override with HACK_GLOBAL_CONFIG_PATH).
 *
 * `HACK_GLOBAL_CONFIG_PATH` stays the highest-priority override for this
 * specific file; otherwise the path is based on {@link resolveGlobalHackDir}.
 */
export function resolveGlobalConfigPath(): string {
  const override = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (override.length > 0) {
    return override;
  }
  return resolve(resolveGlobalHackDir(), GLOBAL_CONFIG_FILENAME);
}
