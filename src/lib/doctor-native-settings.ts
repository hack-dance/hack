import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { YAML } from "bun";
import {
  readNativeSelection,
  selectNativeEnvFile,
} from "../backends/native-project-selection.ts";
import {
  NATIVE_PROJECT_SETTINGS_DIRNAME,
  NATIVE_SETTING_KEYS,
  type NativeAdaptationSelection,
  type NativeSettingKey,
  type NativeSettingOrigin,
  nativeMachineSettingsDirectory,
  resolveNativeAdaptationSelection,
  resolveNativeHostSettings,
} from "../backends/native-project-settings.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveComposeProjectName } from "./compose-project-name.ts";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  type ProjectConfig,
  type ProjectContext,
  readProjectDefaultEnvConfig,
} from "./project.ts";

/** Doctor check id for the native settings report. */
export const NATIVE_SETTINGS_CHECK = "native settings";

/**
 * Closed warnings for configuration that native `up` would refuse or silently not
 * apply. Each names a class of input, never an authored value or a service name.
 */
export type NativeSettingsWarning =
  | "shared_source_not_granted"
  | "internal_dns_tls_not_applied"
  | "internal_extra_hosts_not_applied"
  | "routes_without_probes"
  | "compose_profiles_ignored"
  | "aws_region_without_profile"
  | "unread_project_settings_files";

/** Value-free JSON payload of the native settings check. */
export type NativeSettingsReport = {
  readonly origins: Readonly<Record<NativeSettingKey, NativeSettingOrigin>>;
  /** Project-relative committed adaptation files, e.g. `.hack/native/adaptation.json`. */
  readonly adaptationFiles: readonly string[];
  /** The per-machine settings file, with the home directory shown as `~`. */
  readonly machineSettings: {
    readonly path: string;
    readonly present: boolean;
  } | null;
  readonly warnings: readonly NativeSettingsWarning[];
  /** Number of routed services without a native HTTP probe after adaptation. */
  readonly routesWithoutProbes?: number;
};

const WARNING_TEXT: Readonly<Record<NativeSettingsWarning, string>> = {
  shared_source_not_granted:
    "the project share is not granted (set sharedSource in the machine settings or HACK_NATIVE_SHARED_SOURCE=1), so native up and restart refuse",
  internal_dns_tls_not_applied:
    "hack.config.json internal DNS and container CA trust are not applied on native, so containers cannot reach routes by their HTTPS names",
  internal_extra_hosts_not_applied:
    "hack.config.json internal.extra_hosts is not applied on native (declare additionalHostAliases with host dependency bindings instead)",
  routes_without_probes:
    "routed service(s) have no native HTTP probe (add httpProbes to the adaptation)",
  compose_profiles_ignored:
    "COMPOSE_PROFILES is ignored on native (pass --profile)",
  aws_region_without_profile:
    "HACK_NATIVE_AWS_REGION is ignored without HACK_NATIVE_AWS_PROFILE",
  unread_project_settings_files:
    "files in .hack/native/ other than adaptation*.json are not read (grants and host settings belong in the machine settings file)",
};

const ROUTE_LABELS = new Set(["caddy", "caddy.reverse_proxy", "caddy.tls"]);
const ADAPTATION_FILE = /^adaptation(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.json$/;

type Environment = Readonly<Record<string, string | undefined>>;

function labelKeys(labels: unknown): string[] {
  if (isRecord(labels)) {
    return Object.keys(labels);
  }
  if (Array.isArray(labels)) {
    return labels
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.split("=", 1)[0] ?? "");
  }
  return [];
}

/** Routed services in the raw Compose file that have no native probe after adaptation. */
async function countRoutesWithoutProbes(opts: {
  readonly composeFile: string;
  readonly adaptationFile: string | undefined;
}): Promise<number> {
  const text = await readTextFile(opts.composeFile);
  if (text === null) {
    return 0;
  }
  let compose: unknown;
  try {
    compose = YAML.parse(text);
  } catch {
    return 0;
  }
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return 0;
  }
  let probes: Readonly<Record<string, unknown>> = {};
  if (opts.adaptationFile !== undefined) {
    const selection = await readNativeSelection(opts.adaptationFile);
    if (isRecord(selection) && isRecord(selection.httpProbes)) {
      probes = selection.httpProbes;
    }
  }
  let count = 0;
  for (const [name, service] of Object.entries(compose.services)) {
    if (!isRecord(service)) {
      continue;
    }
    if (!labelKeys(service.labels).some((key) => ROUTE_LABELS.has(key))) {
      continue;
    }
    const probed =
      (isRecord(service.healthcheck) &&
        service.healthcheck["x-hack-http"] !== undefined) ||
      Object.hasOwn(probes, name);
    if (!probed) {
      count += 1;
    }
  }
  return count;
}

async function unreadProjectSettingsFiles(
  projectDir: string
): Promise<boolean> {
  try {
    const names = await readdir(
      join(projectDir, NATIVE_PROJECT_SETTINGS_DIRNAME)
    );
    return names.some((name) => !ADAPTATION_FILE.test(name));
  } catch {
    return false;
  }
}

function displayPath(path: string, env: Environment): string {
  let home = env.HOME;
  if (home === undefined || home === "") {
    try {
      home = homedir();
    } catch {
      return path;
    }
  }
  const rest = relative(home, path);
  return rest !== "" && !rest.startsWith("..") && !rest.startsWith(sep)
    ? `~/${rest}`
    : path;
}

function adaptationFiles(opts: {
  readonly selection: NativeAdaptationSelection;
  readonly projectRoot: string;
}): string[] {
  if (opts.selection.origin !== "project") {
    return [];
  }
  return [opts.selection.file, ...Object.values(opts.selection.fileByEnv ?? {})]
    .filter((file): file is string => file !== undefined)
    .map((file) => relative(opts.projectRoot, file));
}

function describe(report: NativeSettingsReport): string {
  const origins = NATIVE_SETTING_KEYS.map(
    (key) => `${key}: ${report.origins[key]}`
  ).join(", ");
  const machine = report.machineSettings
    ? ` Machine settings: ${report.machineSettings.path} (${report.machineSettings.present ? "read" : "absent"}).`
    : "";
  const warnings =
    report.warnings.length === 0
      ? ""
      : ` Native: ${report.warnings
          .map((warning) =>
            warning === "routes_without_probes"
              ? `${report.routesWithoutProbes ?? 0} ${WARNING_TEXT[warning]}`
              : WARNING_TEXT[warning]
          )
          .join("; ")}.`;
  return `Origins (${origins}).${machine}${warnings}`;
}

/**
 * Read-only native settings report for the current project: where each setting comes
 * from (`env`, `machine`, `project` or `unset`), never its value, and warnings for
 * configuration native start refuses or does not apply. It reads the same files native
 * `up` resolves without `--env`, so an invalid file is the same closed refusal, reported
 * as an error here. It runs no runtime request, export or network call.
 */
export async function checkNativeSettings(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly env: Environment;
  readonly uid?: number;
}): Promise<{
  readonly name: string;
  readonly status: "ok" | "warn" | "error";
  readonly message: string;
  readonly nativeSettings?: NativeSettingsReport;
}> {
  const { project, cfg, env } = opts;
  const projectName = await resolveComposeProjectName({ project, cfg });
  const machineDirectory = nativeMachineSettingsDirectory({ env, projectName });
  try {
    const adaptation = await resolveNativeAdaptationSelection({
      env,
      projectDir: project.projectDir,
    });
    const host = await resolveNativeHostSettings({
      env,
      projectName,
      projectRoot: project.projectRoot,
      uid: opts.uid,
    });
    const defaultEnv = await readProjectDefaultEnvConfig({
      projectDir: project.projectDir,
    });
    const routesWithoutProbes = await countRoutesWithoutProbes({
      composeFile: project.composeFile,
      adaptationFile: selectNativeEnvFile({
        selection: adaptation,
        envName: defaultEnv,
      }),
    });
    const warnings: NativeSettingsWarning[] = [];
    if (!host.sharedSource) {
      warnings.push("shared_source_not_granted");
    }
    if (cfg.internal?.dns !== false || cfg.internal?.tls !== false) {
      warnings.push("internal_dns_tls_not_applied");
    }
    if (Object.keys(cfg.internal?.extraHosts ?? {}).length > 0) {
      warnings.push("internal_extra_hosts_not_applied");
    }
    if (routesWithoutProbes > 0) {
      warnings.push("routes_without_probes");
    }
    if ((env.COMPOSE_PROFILES ?? "") !== "") {
      warnings.push("compose_profiles_ignored");
    }
    if (
      (env.HACK_NATIVE_AWS_REGION ?? "") !== "" &&
      (env.HACK_NATIVE_AWS_PROFILE ?? "") === ""
    ) {
      warnings.push("aws_region_without_profile");
    }
    if (await unreadProjectSettingsFiles(project.projectDir)) {
      warnings.push("unread_project_settings_files");
    }
    const nativeSettings: NativeSettingsReport = {
      origins: { adaptation: adaptation.origin, ...host.origins },
      adaptationFiles: adaptationFiles({
        selection: adaptation,
        projectRoot: project.projectRoot,
      }),
      machineSettings:
        machineDirectory === undefined
          ? null
          : {
              path: displayPath(join(machineDirectory, "settings.json"), env),
              present: host.machineFile !== undefined,
            },
      warnings,
      ...(routesWithoutProbes > 0 ? { routesWithoutProbes } : {}),
    };
    return {
      name: NATIVE_SETTINGS_CHECK,
      status: warnings.length > 0 ? "warn" : "ok",
      message: describe(nativeSettings),
      nativeSettings,
    };
  } catch (error: unknown) {
    return {
      name: NATIVE_SETTINGS_CHECK,
      status: "error",
      message:
        error instanceof HackCliError
          ? `${error.code}: ${error.message}`
          : "Native settings could not be read; values omitted.",
    };
  }
}
