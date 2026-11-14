import type { CliContext } from "../cli/command.ts";
import {
  type ActivityAction,
  recordActivity,
  resolveRegisteredProjectName,
} from "../lib/activity-log.ts";
import { sanitizeBranchSlug } from "../lib/project.ts";

type LifecycleInput = {
  readonly ctx: CliContext;
  readonly args: {
    readonly options: {
      readonly path?: string;
      readonly project?: string;
      readonly branch?: string;
    };
  };
};

/**
 * Record a lifecycle command in the activity log (HACK-2218). The handler's
 * exit code, or its error, passes through unchanged; Compose and native
 * paths are covered alike because the record is written here, around the
 * whole command.
 */
export function withActivity<Input extends LifecycleInput>(
  action: ActivityAction,
  handler: (input: Input) => Promise<number>
): (input: Input) => Promise<number> {
  return async (input) => {
    const { path, project, branch } = input.args.options;
    const explicitBranch =
      branch === undefined ? undefined : sanitizeBranchSlug(branch.trim());
    return await recordActivity({
      action,
      ...(explicitBranch ? { branch: explicitBranch } : {}),
      project: () =>
        resolveRegisteredProjectName({
          cwd: input.ctx.cwd,
          ...(path === undefined ? {} : { path }),
          ...(project === undefined ? {} : { project }),
        }),
      run: () => handler(input),
    });
  };
}
