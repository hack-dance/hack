import { homedir } from "node:os"
import { resolve } from "node:path"

import { GLOBAL_CONFIG_FILENAME, GLOBAL_HACK_DIR_NAME } from "../constants.ts"

/**
 * Resolve the global hack.config.json path (override with HACK_GLOBAL_CONFIG_PATH).
 */
export function resolveGlobalConfigPath(): string {
  const override = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim()
  if (override.length > 0) return override
  return resolve(homedir(), GLOBAL_HACK_DIR_NAME, GLOBAL_CONFIG_FILENAME)
}
