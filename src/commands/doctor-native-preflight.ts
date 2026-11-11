import {
  buildNativePreflightReport,
  collectNativeCliFindings,
  collectNativeRuntimeFindings,
  type NativePreflightFinding,
  renderNativePreflightReport,
} from "../backends/native-preflight.ts";
import { nativeBuildsEnabled } from "../backends/native-project-builds.ts";
import {
  nativeAdaptationCandidates,
  resolveNativeAdaptationSelection,
  resolveNativeHostSettings,
} from "../backends/native-project-settings.ts";
import {
  type NativeRuntimeSelection,
  resolveNativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import { CliUsageError } from "../cli/command.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { findProjectContext, readProjectConfig } from "../lib/project.ts";

/**
 * The native runtime for the review half, or null. Preflight is useful before
 * a candidate is installed, so native selection is optional here: without it,
 * or with an incomplete one, only the CLI's own checks run and the report
 * says so.
 */
function selectedRuntime(
  env: Readonly<Record<string, string | undefined>>
): NativeRuntimeSelection | null {
  try {
    return resolveNativeRuntimeSelection(env);
  } catch {
    return null;
  }
}

/**
 * `hack doctor --native-preflight`: list every blocker and note for running
 * this project on the native backend. Read-only. Exits 0 when no blocker was
 * found and 1 otherwise; `--json` prints the report in the standard envelope
 * either way.
 */
export async function runNativePreflightCommand(opts: {
  readonly startDir: string;
  readonly json: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<number> {
  const env = opts.env ?? process.env;
  const project = await findProjectContext(opts.startDir);
  if (!project) {
    throw new CliUsageError(
      "Native preflight checks one project. Run it inside a project or pass --path <project root>."
    );
  }
  const settings: NativePreflightFinding[] = [];
  let sharedSource = false;
  let hasHostDependencies = false;
  try {
    const cfg = await readProjectConfig(project);
    const host = await resolveNativeHostSettings({
      env,
      projectName: await resolveComposeProjectName({ project, cfg }),
      projectRoot: project.projectRoot,
    });
    sharedSource = host.sharedSource;
    hasHostDependencies =
      host.dependencyFile !== undefined ||
      Object.keys(host.dependencyFileByEnv ?? {}).length > 0;
  } catch {
    settings.push({
      severity: "blocker",
      gate: "cli",
      code: "native_settings_invalid",
      message:
        "The project configuration or the native machine settings for this project could not be read.",
      fix: "Run hack doctor for details. The settings file must be private to you (directory 0700, file 0600) and list this project root.",
    });
  }
  const adaptationCandidates = await resolveNativeAdaptationSelection({
    env,
    projectDir: project.projectDir,
  }).then(
    (selection) =>
      nativeAdaptationCandidates({ selection, requestedEnvName: undefined }),
    () => undefined
  );
  const cli = [
    ...settings,
    ...(await collectNativeCliFindings({
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      composeFile: project.composeFile,
      adaptationCandidates,
      buildsEnabled: nativeBuildsEnabled(),
      // An unreadable settings file is its own blocker; do not also ask for the grant.
      sharedSource: sharedSource || settings.length > 0,
      hasHostDependencies,
    })),
  ];
  const runtime = await collectNativeRuntimeFindings({
    runtime: selectedRuntime(env),
    projectRoot: project.projectRoot,
    composeFile: project.composeFile,
  });
  const report = buildNativePreflightReport({
    projectRoot: project.projectRoot,
    composeFile: project.composeFile,
    cli,
    runtime,
  });
  if (opts.json) {
    emitCliResult({ result: okResult({ data: report }) });
  } else {
    process.stdout.write(renderNativePreflightReport(report));
  }
  return report.blockers.length === 0 ? 0 : 1;
}
