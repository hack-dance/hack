import { YAML } from "bun";
import { readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import type { ProjectConfig, ProjectContext } from "./project.ts";
import { defaultProjectSlugFromPath } from "./project.ts";

/**
 * Resolve the base Compose project name for a project's default instance.
 *
 * Precedence: the Compose file's top-level `name:`, then the project config
 * `name`, then the slug derived from the project root directory. A branch
 * instance appends `--<branch slug>` to this base (see
 * {@link branchComposeProjectName}). The read is side-effect free.
 */
export async function resolveComposeProjectName(opts: {
  readonly project: Pick<ProjectContext, "composeFile" | "projectRoot">;
  readonly cfg?: Pick<ProjectConfig, "name">;
}): Promise<string> {
  const composeName = await readComposeProjectName(opts.project.composeFile);
  if (composeName) {
    return composeName;
  }

  const derived = defaultProjectSlugFromPath(opts.project.projectRoot);
  const cfgName = (opts.cfg?.name ?? derived).trim();
  return cfgName.length > 0 ? cfgName : derived;
}

/** Compose project name of a branch instance: `<base>--<branch slug>`. */
export function branchComposeProjectName(opts: {
  readonly base: string;
  readonly branch: string;
}): string {
  return `${opts.base}--${opts.branch}`;
}

async function readComposeProjectName(
  composeFile: string
): Promise<string | null> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }
  const name = getString(parsed, "name");
  const trimmed = name?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
