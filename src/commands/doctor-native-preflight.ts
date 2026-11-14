import {
  collectNativePreflight,
  type NativePreflightFinding,
  parseNativePreflightCompose,
  readNativePreflightCompose,
  renderNativePreflightReport,
} from "../backends/native-preflight.ts";
import { nativeBuildsEnabled } from "../backends/native-project-builds.ts";
import {
  type NativeHostAliasSource,
  resolveNativeInternalExtraHostSelection,
} from "../backends/native-project-internal-hosts.ts";
import { selectNativeEnvFile } from "../backends/native-project-selection.ts";
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
import { getString, isRecord } from "../lib/guards.ts";
import { findProjectContext, readProjectConfig } from "../lib/project.ts";
import { resolveProjectEnvSelection } from "../lib/project-env-config.ts";
import { ProjectInputSelectionError } from "../lib/project-input-selection.ts";

/**
 * The native runtime for the review half. Preflight is useful before a
 * candidate is installed, so native selection is optional here: without it
 * only the CLI's own checks run. A selection without a candidate is reported
 * as such, never treated as "not selected".
 */
function selectedRuntime(
  env: Readonly<Record<string, string | undefined>>
): NativeRuntimeSelection | "incomplete" | null {
  try {
    return resolveNativeRuntimeSelection(env);
  } catch {
    return "incomplete";
  }
}

function composeName(document: unknown): string | null {
  return isRecord(document) ? (getString(document, "name") ?? null) : null;
}

const SETTINGS_BLOCKER = { severity: "blocker", gate: "cli" } as const;

/**
 * `hack doctor --native-preflight`: list every blocker and note for running
 * this Compose project on the native backend. Read-only for the project.
 *
 * Exit status follows the findings, not the review: 0 when no blocker or outstanding consent was
 * found, 1 otherwise. A skipped or unavailable review is not a blocker, so it
 * exits 0 with `ready: false`. `--json` prints the report in the standard
 * `ok: true` envelope either way: the command worked, and `ready` and
 * `blockers`/`consent_needed` carry the verdict.
 */
export async function runNativePreflightCommand(opts: {
  readonly startDir: string;
  readonly json: boolean;
  readonly profiles: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<number> {
  const report = await collectProjectNativePreflight(opts);
  if (opts.json) {
    emitCliResult({ result: okResult({ data: report }) });
  } else {
    process.stdout.write(renderNativePreflightReport(report));
  }
  return report.blockers.length === 0 && report.consent_needed.length === 0
    ? 0
    : 1;
}

/**
 * The native preflight report for the project at `startDir`, without
 * printing it. `runtimeReview: false` skips the native runtime's own review
 * (it runs the native binary and writes a temporary directory), leaving
 * only the in-process checks (HACK-2189 upgrade check).
 */
export async function collectProjectNativePreflight(opts: {
  readonly startDir: string;
  readonly profiles: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runtimeReview?: boolean;
}): Promise<Awaited<ReturnType<typeof collectNativePreflight>>> {
  const env = opts.env ?? process.env;
  const project = await findProjectContext(opts.startDir).catch(
    (error: unknown) => {
      // Native project inputs (alone, or beside legacy ones) take another
      // admission path; this report would judge the wrong one.
      if (error instanceof ProjectInputSelectionError) {
        throw new CliUsageError(
          "Native preflight covers Compose-file projects. This project has native project inputs (a native project file or an adopted Compose file), which take another admission path; check a native project file with hack config validate."
        );
      }
      throw error;
    }
  );
  if (!project) {
    throw new CliUsageError(
      "Native preflight checks one project. Run it inside a project or pass --path <project root>."
    );
  }
  const settings: NativePreflightFinding[] = [];
  const composeBytes = await readNativePreflightCompose(project.composeFile);
  const compose =
    composeBytes === null
      ? undefined
      : parseNativePreflightCompose(composeBytes);
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    settings.push({
      ...SETTINGS_BLOCKER,
      code: "project_config_invalid",
      message: "The project configuration file is not valid.",
      fix: "Fix .hack/hack.config.json; hack doctor shows the parse error.",
    });
  }
  // The effective env selects the per-env adaptation and dependency files, as
  // native start does. Reading the selection decrypts and resolves nothing.
  const effectiveEnv = await resolveProjectEnvSelection({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
  }).then(
    (selection) => selection.effectiveEnv,
    () => {
      settings.push({
        ...SETTINGS_BLOCKER,
        code: "managed_env_unreadable",
        message: "The project's Hack managed env selection could not be read.",
        fix: "Run hack env list to see the problem.",
      });
      return null;
    }
  );
  let sharedSource = false;
  let hasHostDependencies = false;
  let hasDefaultDependencyFile = false;
  // An unreadable Compose file is reported as `compose_file_unreadable`; the
  // settings lookup needs its project name, so it is skipped then.
  let settingsReadable = false;
  if (composeBytes !== null) {
    try {
      const host = await resolveNativeHostSettings({
        env,
        projectName: await resolveComposeProjectName({
          project,
          cfg,
          composeName: composeName(compose),
        }),
        projectRoot: project.projectRoot,
      });
      settingsReadable = true;
      sharedSource = host.sharedSource;
      hasDefaultDependencyFile = host.dependencyFile !== undefined;
      hasHostDependencies =
        selectNativeEnvFile({
          selection: {
            file: host.dependencyFile,
            fileByEnv: host.dependencyFileByEnv,
          },
          envName: effectiveEnv,
        }) !== undefined;
    } catch {
      settings.push({
        ...SETTINGS_BLOCKER,
        code: "native_settings_invalid",
        message:
          "The native machine settings for this project, or a native setting in the environment, could not be read.",
        fix: "Run hack doctor for the native settings check. The settings file must be private to you (directory 0700, file 0600) and list this project root.",
      });
    }
  }
  let adaptationFile: string | undefined;
  let adaptationCandidates: readonly (string | undefined)[] = [undefined];
  let adaptationSelected = true;
  try {
    const selection = await resolveNativeAdaptationSelection({
      env,
      projectDir: project.projectDir,
    });
    adaptationFile = selectNativeEnvFile({ selection, envName: effectiveEnv });
    adaptationCandidates = nativeAdaptationCandidates({
      selection,
      requestedEnvName: undefined,
    });
  } catch {
    adaptationSelected = false;
    settings.push({
      ...SETTINGS_BLOCKER,
      code: "native_adaptation_invalid",
      message: "The project's native adaptation selection could not be read.",
      fix: "Check the files under .hack/native/, or the file HACK_NATIVE_ADAPTATION names.",
    });
  }
  let internalHosts: Readonly<Record<string, string>> | null = null;
  let internalHostSources: Readonly<Record<string, NativeHostAliasSource>> = {};
  if (!cfg.parseError) {
    const resolved = await resolveNativeInternalExtraHostSelection({
      project,
      cfg,
    }).catch(() => null);
    internalHosts = resolved ? resolved.hosts : null;
    internalHostSources = resolved ? resolved.sources : {};
  }
  const report = await collectNativePreflight({
    composeBytes,
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    composeFile: project.composeFile,
    settings,
    adaptationFile,
    adaptationCandidates,
    adaptationSelected,
    // An invalid configuration is already reported; do not report its hosts too.
    internalHosts: cfg.parseError ? {} : internalHosts,
    internalHostSources,
    buildsEnabled: nativeBuildsEnabled(),
    // Unreadable settings are their own blocker; do not also ask for the grant.
    sharedSource: sharedSource || !settingsReadable,
    hasHostDependencies,
    hasDefaultDependencyFile,
    effectiveEnvName: effectiveEnv,
    profiles: opts.profiles,
    runtime: opts.runtimeReview === false ? null : selectedRuntime(env),
  });
  return report;
}
