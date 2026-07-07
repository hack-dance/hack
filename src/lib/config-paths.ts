import { homedir } from "node:os";
import { resolve } from "node:path";

import { GLOBAL_CONFIG_FILENAME, GLOBAL_HACK_DIR_NAME } from "../constants.ts";

/**
 * Resolve the global hack home directory (`~/.hack` by default).
 *
 * Resolution order:
 * 1. `HACK_HOME` env var (trimmed, non-empty) — used as-is, resolved to an
 *    absolute path. This override exists for tests and isolated environments
 *    that need to redirect ALL global state (registry, caddy assets, daemon
 *    state, secrets) without overriding `HOME`.
 * 2. `resolve(HOME ?? homedir(), ".hack")` — the default behavior.
 */
export function resolveGlobalHackDir(): string {
  const override = (process.env.HACK_HOME ?? "").trim();
  if (override.length > 0) {
    return resolve(override);
  }
  const home = (process.env.HOME ?? homedir()).trim();
  return resolve(home, GLOBAL_HACK_DIR_NAME);
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
