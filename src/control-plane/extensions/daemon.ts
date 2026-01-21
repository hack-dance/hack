import { logger as baseLogger } from "../../ui/logger.ts"
import { readControlPlaneConfig } from "../sdk/config.ts"
import { BUILTIN_EXTENSIONS } from "./builtins.ts"
import { ExtensionManager } from "./manager.ts"

import type { Logger } from "../../ui/logger.ts"

export type DaemonExtensionLoadResult = {
  readonly manager: ExtensionManager
  readonly warnings: readonly string[]
  readonly configError?: string
}

/**
 * Load the extension manager for the daemon and register built-in extensions.
 *
 * @param opts.logger - Optional logger override.
 * @returns Extension manager plus any config warnings.
 */
export async function loadExtensionManagerForDaemon(opts?: {
  readonly logger?: Logger
}): Promise<DaemonExtensionLoadResult> {
  const logger = opts?.logger ?? baseLogger
  const configResult = await readControlPlaneConfig({})

  const manager = new ExtensionManager({
    config: configResult.config,
    logger
  })

  for (const ext of BUILTIN_EXTENSIONS) {
    manager.registerExtension({ extension: ext })
  }

  return {
    manager,
    warnings: manager.getWarnings(),
    configError: configResult.parseError
  }
}
