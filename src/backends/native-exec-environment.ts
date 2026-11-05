import { basename } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { prepareNativeProjectInput } from "./native-project-input.ts";
import type {
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";

/** Marks a selection that no longer matches the run's recorded startup selection. */
class SelectionChanged extends Error {}

/**
 * Both refusals keep `E_CONFIG_INVALID` for JSON callers. The messages differ:
 * a changed selection needs a restart; an unresolvable environment needs its
 * configuration or values repaired.
 */
const SELECTION_CHANGED_MESSAGE =
  "Native fresh exec selection changed since startup: the service, environment or overlay this run started with is no longer selected. Restart the project to apply the current configuration; no command was requested. Values omitted.";
const ENVIRONMENT_UNAVAILABLE_MESSAGE =
  "Native fresh exec environment could not be resolved; no command was requested. Values omitted.";

/** Resolve fresh selected-service values in memory using explicit startup selectors. */
export async function prepareNativeExecEnvironment(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly composeFile: string;
  readonly service: string;
  readonly prepare?: typeof prepareNativeProjectInput;
  readonly adaptAws?: typeof adaptNativeAwsEnvironment;
}): Promise<Readonly<Record<string, string>>> {
  if (
    !(
      Object.hasOwn(opts.run, "effectiveEnvName") &&
      Object.hasOwn(opts.run, "aws")
    )
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Native fresh exec requires recorded startup environment and AWS selections; restart with the current candidate. Values omitted.",
    });
  }
  try {
    let input = await (opts.prepare ?? prepareNativeProjectInput)({
      projectRoot: opts.scope.projectRoot,
      projectDir: opts.scope.projectDir,
      composeFile: opts.composeFile,
      envName: opts.run.effectiveEnvName,
    });
    if (
      !input.serviceNames.includes(opts.service) ||
      input.effectiveEnvName !== opts.run.effectiveEnvName
    ) {
      throw new SelectionChanged();
    }
    const selected = opts.run.effectiveEnvName;
    // A run started without any managed env file records its env only to select the
    // per-env native files; with still no file there are no values to deliver.
    if (
      selected !== null &&
      input.environmentFiles.length > 0 &&
      !input.environmentFiles.some((path) =>
        [
          `hack.env.${selected}.yaml`,
          `hack.env.${selected}.local.yaml`,
        ].includes(basename(path))
      )
    ) {
      throw new SelectionChanged();
    }
    if (opts.run.aws) {
      input = (
        await (opts.adaptAws ?? adaptNativeAwsEnvironment)({
          input,
          ...opts.run.aws,
        })
      ).input;
    }
    return input.managedEnvironment[opts.service] ?? {};
  } catch (error) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        error instanceof SelectionChanged
          ? SELECTION_CHANGED_MESSAGE
          : ENVIRONMENT_UNAVAILABLE_MESSAGE,
    });
  }
}
