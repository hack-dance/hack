import { resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import { resolveRegisteredProjectOption } from "../cli/project-selector.ts";
import { resolveEffectiveBranch } from "./branches.ts";
import { resolveHackEnv } from "./hack-env.ts";
import { resolveLifecycleComposeProjectName } from "./lifecycle-runtime.ts";
import { MissingProjectContextError } from "./missing-project-error.ts";
import {
  findProjectContext,
  type ProjectConfig,
  type ProjectContext,
  resolveWorktreeAutoBranch,
  sanitizeProjectSlug,
} from "./project.ts";
import {
  discoverComposeServiceNames,
  resolveProjectEnvConfig,
} from "./project-env-config.ts";
import {
  applyRemoteEnv,
  type EffectiveRemote,
} from "./project-remote-selection.ts";
import { readProjectRuntimeStateEntry } from "./project-runtime-state.ts";
import { selectEnvForRunningInstance } from "./running-env-selection.ts";
import { isHostControlEnvKey } from "./vetted-env.ts";

export async function resolveUseProject(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
}): Promise<ProjectContext> {
  if (opts.path && opts.project !== undefined) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }
  if (opts.project !== undefined) {
    return await resolveRegisteredProjectOption({ projectOpt: opts.project });
  }
  const project = await findProjectContext(resolve(opts.cwd, opts.path ?? "."));
  if (!project) {
    throw new MissingProjectContextError();
  }
  return project;
}

export async function resolveUseInstance(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly base: string;
}) {
  const instance = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: opts.project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(opts.cfg),
  });
  if (instance.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached linked worktree cannot auto-select an isolated instance. Set worktree.auto_branch=false to target the base instance explicitly."
    );
  }
  return {
    composeProjectName: instance.branch
      ? `${opts.base}--${instance.branch}`
      : null,
    lifecycleComposeProject: resolveLifecycleComposeProjectName({
      projectName: sanitizeProjectSlug(opts.base),
      branch: instance.branch,
    }),
  };
}

/** Read application interpolation values without adopting checkout client settings. */
export async function resolveRemoteInspectionEnv(opts: {
  readonly project: ProjectContext;
  readonly baseProjectName: string;
  readonly composeProject: string;
  readonly requestedEnvName: string | null | undefined;
  readonly choices: readonly EffectiveRemote[];
}): Promise<Record<string, string>> {
  const { project } = opts;
  const envName = selectEnvForRunningInstance({
    requestedEnvName: opts.requestedEnvName,
    running: await readProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      composeProject: opts.composeProject,
    }),
  });
  const modern = await resolveProjectEnvConfig({
    projectDir: project.projectDir,
    projectRoot: project.projectRoot,
    envName,
    serviceNames: await discoverComposeServiceNames({
      composeFile: project.composeFile,
    }),
  });
  const managed =
    modern?.globalEnv ??
    (
      await resolveHackEnv({
        projectDir: project.projectDir,
        projectName: sanitizeProjectSlug(opts.baseProjectName),
        envName,
      })
    ).envForCompose;
  return Object.fromEntries(
    Object.entries(applyRemoteEnv(managed, opts.choices)).filter(
      ([key]) => !isHostControlEnvKey(key)
    )
  );
}
