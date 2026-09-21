import { basename } from "node:path";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { prepareNativeProjectInput } from "./native-project-input.ts";
import type {
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";

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
    throw new Error(
      "Native fresh exec requires recorded startup environment and AWS selections; restart with the current candidate. Values omitted."
    );
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
      throw new Error("selection changed");
    }
    const selected = opts.run.effectiveEnvName;
    if (
      selected !== null &&
      !input.environmentFiles.some((path) =>
        [
          `hack.env.${selected}.yaml`,
          `hack.env.${selected}.local.yaml`,
        ].includes(basename(path))
      )
    ) {
      throw new Error("selected overlay missing");
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
  } catch {
    throw new Error(
      "Native fresh exec environment is unavailable or changed; no command was requested. Values omitted."
    );
  }
}
