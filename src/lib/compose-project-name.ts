import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { YAML } from "bun";
import { childEnvironment } from "./child-environment.ts";
import { readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import type { ProjectConfig, ProjectContext } from "./project.ts";
import { defaultProjectSlugFromPath } from "./project.ts";
import { exec } from "./shell.ts";

type ComposeProjectNameOptions = {
  readonly project: Pick<ProjectContext, "composeFile" | "projectRoot">;
  readonly cfg?: Pick<ProjectConfig, "name">;
  /** Already parsed Compose name; null skips a file read when no name exists. */
  readonly composeName?: string | null;
};

/**
 * Resolve the base Compose project name for a project's default instance.
 *
 * Precedence: the Compose file's top-level `name:`, then the project config
 * `name`, then the slug derived from the project root directory. A branch
 * instance appends `--<branch slug>` to this base (see
 * {@link branchComposeProjectName}). The read is side-effect free.
 */
export async function resolveComposeProjectName(
  opts: ComposeProjectNameOptions
): Promise<string> {
  const composeName =
    opts.composeName === undefined
      ? await readComposeProjectName(opts.project.composeFile)
      : opts.composeName?.trim();
  if (composeName) {
    return composeName;
  }

  const derived = defaultProjectSlugFromPath(opts.project.projectRoot);
  const cfgName = (opts.cfg?.name ?? derived).trim();
  return cfgName.length > 0 ? cfgName : derived;
}

const COMPOSE_PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]*$/;
export const COMPOSE_PROJECT_NAME_TIMEOUT_MS = 1500;

export function isComposeProjectName(name: string): boolean {
  return COMPOSE_PROJECT_SLUG.test(name);
}

type ComposeNameEnvironment = {
  readonly env?: Readonly<Record<string, string>>;
  readonly executeDocker?: typeof exec;
  readonly disableEnvFile?: boolean;
  /** A branch is explicitly named with `-p`, so a literal name keeps its suffix base. */
  readonly forBranch?: boolean;
};

const DOTENV_PROJECT_NAME =
  /^(?:[ \t]*export[ \t]+)?[ \t]*COMPOSE_PROJECT_NAME[ \t]*(?:=|:|\r?$)/m;
const DISABLE_DEFAULT_DOTENV = /^(?:1|t|T|true|TRUE|True)$/;
const PROJECT_NAME_LABEL = "hack.compose.configured-name";
const PROJECT_NAME_REFERENCE = /\$(?:\{)?COMPOSE_PROJECT_NAME\b/;
const INVALID_COMPOSE_NAME_CHARS = /[^a-z0-9_-]/g;
const COMPOSE_NAME_LEADING_SEPARATORS = /^[-_]+/;

export async function shouldResolveComposeProjectName(
  opts: ComposeNameEnvironment & {
    readonly composeFile: string;
    readonly configuredName: string;
  }
): Promise<boolean> {
  if (opts.configuredName.includes("$")) {
    return true;
  }
  if (opts.forBranch) {
    return false;
  }
  const env = childEnvironment(process.env, opts.env);
  if (env.COMPOSE_PROJECT_NAME) {
    return true;
  }
  if (opts.disableEnvFile) {
    return false;
  }
  const named =
    env.COMPOSE_ENV_FILES?.split(",")
      .map((file) => file.trim())
      .filter(Boolean) ?? [];
  const defaults = DISABLE_DEFAULT_DOTENV.test(
    env.COMPOSE_DISABLE_ENV_FILE ?? ""
  )
    ? []
    : [".env"];
  for (const file of named.length ? named : defaults) {
    const text = await readTextFile(resolve(dirname(opts.composeFile), file));
    if (text && DOTENV_PROJECT_NAME.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the base name Compose would use, or the base for a pinned branch.
 * Compose evaluates dynamic names in the checkout's dotenv and shell
 * environment. For an unnamed base, Compose uses the containing directory.
 */
export async function resolveDesktopComposeProjectName(
  opts: ComposeProjectNameOptions & ComposeNameEnvironment
): Promise<string | null> {
  const composeName =
    opts.composeName === undefined
      ? await readComposeProjectName(opts.project.composeFile)
      : opts.composeName;
  const configuredName = await resolveComposeProjectName({
    ...opts,
    composeName,
  });
  const cwd = dirname(opts.project.composeFile);
  if (
    !(await shouldResolveComposeProjectName({
      ...opts,
      composeFile: opts.project.composeFile,
      configuredName,
    }))
  ) {
    const name = opts.forBranch
      ? configuredName
      : normalizeComposeProjectName(composeName ?? basename(cwd));
    return isComposeProjectName(name) ? name : null;
  }
  const sentinel =
    opts.forBranch && PROJECT_NAME_REFERENCE.test(configuredName)
      ? `hack-name-${randomUUID()}`
      : undefined;
  const config = JSON.stringify({
    name: sentinel ?? composeName ?? undefined,
    services: {
      probe: {
        image: "scratch",
        // Compose interpolates labels even when COMPOSE_PROJECT_NAME takes
        // precedence over the YAML name. Explicit branch names use that YAML
        // expression as their base.
        ...(opts.forBranch
          ? { labels: { [PROJECT_NAME_LABEL]: configuredName } }
          : {}),
      },
    },
  });
  try {
    const result = await (opts.executeDocker ?? exec)(
      [
        "docker",
        "compose",
        "--project-directory",
        cwd,
        ...(opts.disableEnvFile ? ["--env-file", "/dev/null"] : []),
        "-f",
        "-",
        "config",
        "--format",
        "json",
      ],
      {
        cwd,
        env: opts.env ? { ...opts.env } : undefined,
        stdin: new Blob([config]),
        timeoutMs: COMPOSE_PROJECT_NAME_TIMEOUT_MS,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      }
    );
    const rendered: unknown =
      result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    if (!isRecord(rendered)) {
      return null;
    }
    const effectiveName = getString(rendered, "name");
    if (sentinel && effectiveName === sentinel) {
      // Compose injected the probe name into its model because there was
      // no external override. Read the actual top-level expression instead.
      return await resolveDesktopComposeProjectName({
        ...opts,
        composeName,
        forBranch: false,
      });
    }
    const name = opts.forBranch
      ? configuredBranchBase(rendered)
      : effectiveName;
    return name && isComposeProjectName(name) ? name : null;
  } catch {
    return null;
  }
}

function configuredBranchBase(
  rendered: Record<string, unknown>
): string | null {
  const services = isRecord(rendered.services) ? rendered.services : null;
  const probe = services && isRecord(services.probe) ? services.probe : null;
  const value =
    probe && isRecord(probe.labels)
      ? getString(probe.labels, PROJECT_NAME_LABEL)
      : null;
  // Compose normalizes an interpolated YAML name before assigning it.
  return value ? normalizeComposeProjectName(value) : null;
}

function normalizeComposeProjectName(value: string): string {
  return value
    .toLowerCase()
    .replace(INVALID_COMPOSE_NAME_CHARS, "")
    .replace(COMPOSE_NAME_LEADING_SEPARATORS, "");
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
