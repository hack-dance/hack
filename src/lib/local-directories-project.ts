import { resolve } from "node:path";
import { YAML } from "bun";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import { readTextFile } from "./fs.ts";
import {
  planProjectLocalDirectories,
  withLocalDirectoriesOverride,
} from "./local-directories.ts";
import {
  type ProjectContext,
  readProjectConfig,
  readProjectConfigFiles,
} from "./project.ts";

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

/**
 * Native `up` and `restart` (HACK-2358): refuses an invalid
 * `localDirectories` before anything starts or stops, and prints the same
 * notices as Compose. The native start applies the plan itself; this only
 * reports it, in the foreground (a detached owner's output is not shown, so
 * the launcher calls this before it starts the owner).
 */
export async function reportNativeLocalDirectories(opts: {
  readonly project: ProjectContext;
  readonly warn: (line: string) => void;
}): Promise<void> {
  const config = await readProjectConfig(opts.project);
  if (config.localDirectoriesError) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: config.localDirectoriesError,
    });
  }
  const entries = config.localDirectories ?? [];
  if (entries.length === 0) {
    return;
  }
  const text = await readTextFile(opts.project.composeFile);
  let compose: unknown = null;
  try {
    compose = text === null ? null : YAML.parse(text);
  } catch {
    // Native start reports an unreadable Compose file itself.
    return;
  }
  const { notices } = await planProjectLocalDirectories({
    projectRoot: opts.project.projectRoot,
    composeFile: opts.project.composeFile,
    compose,
    entries,
  });
  for (const line of notices) {
    opts.warn(line);
  }
}

/**
 * Adopted, authored and imported native projects do not read
 * `localDirectories`: `up` and `restart` say so once, instead of silently
 * leaving installs on the shared source.
 */
export async function warnLocalDirectoriesNotApplied(opts: {
  readonly projectRoot: string;
  readonly kind: string;
  readonly warn: (line: string) => void;
}): Promise<void> {
  const config = await readProjectConfigFiles(
    resolve(opts.projectRoot, HACK_PROJECT_DIR_PRIMARY)
  ).catch(() => null);
  if (config === null) {
    return;
  }
  if (
    (config.localDirectories?.length ?? 0) > 0 ||
    config.localDirectoriesError
  ) {
    opts.warn(
      `localDirectories is not applied to ${opts.kind} projects on the native backend; services keep those directories on the shared source.`
    );
  }
}
