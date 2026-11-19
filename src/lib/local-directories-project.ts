import { withLocalDirectoriesOverride } from "./local-directories.ts";
import { type ProjectContext, readProjectConfig } from "./project.ts";

/**
 * Appends the project's `localDirectories` override (HACK-2358) to a Compose
 * file chain, reading `.hack/hack.config.json`. Refuses an invalid setting
 * with `E_CONFIG_INVALID`; `notify` gets one line per entry it cannot keep
 * local.
 */
export async function withProjectLocalDirectories(opts: {
  readonly project: ProjectContext;
  readonly composeFiles: readonly string[];
  readonly notify?: (line: string) => void;
}): Promise<string[]> {
  return await withLocalDirectoriesOverride({
    project: opts.project,
    config: await readProjectConfig(opts.project),
    composeFiles: opts.composeFiles,
    notify: opts.notify,
  });
}
