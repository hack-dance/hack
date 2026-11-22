import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { HACK_VERSION } from "./hack-version.ts";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ARGUMENT = /^[^\x00-\x1f\x7f]*$/;

export interface ProjectPrerequisite {
  readonly tools: readonly string[];
  readonly check: readonly [string, ...string[]];
  readonly login: readonly [string, ...string[]];
  readonly preset?: string;
}

export interface ProjectHostTool {
  readonly bins: readonly string[];
  readonly install?: string;
}

export interface ProjectPrerequisiteConfig {
  readonly tools: ReadonlyMap<string, ProjectHostTool>;
  readonly requires: ReadonlyMap<string, ProjectPrerequisite>;
  readonly selected: readonly {
    readonly remote: string;
    readonly target: string;
    readonly requires: readonly string[];
  }[];
}

function fail(code: HackErrorCode, message: string): never {
  throw new HackCliError({ code, message });
}

function isName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isName);
}

function isArgv(value: unknown): value is [string, ...string[]] {
  return (
    Array.isArray(value) &&
    isName(value[0]) &&
    value.every((arg) => typeof arg === "string" && ARGUMENT.test(arg))
  );
}

function entries(value: unknown, code: HackErrorCode): [string, unknown][] {
  if (value === undefined) {
    return [];
  }
  if (!(isRecord(value) && Object.keys(value).every(isName))) {
    fail(code, "Expected an object keyed by configuration names.");
  }
  return Object.entries(value);
}

function validateMinimumVersion(config: Record<string, unknown>): void {
  const version = config.min_cli_version;
  if (version === undefined) {
    if (config.requires !== undefined || config.remotes !== undefined) {
      fail(
        "E_MIN_CLI_VERSION_REQUIRED",
        "requires and remotes need min_cli_version."
      );
    }
    return;
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    fail(
      "E_INVALID_MIN_CLI_VERSION",
      "min_cli_version must be a SemVer version."
    );
  }
  if (Bun.semver.order(HACK_VERSION, version) < 0) {
    fail(
      "E_CLI_VERSION_TOO_OLD",
      `This project requires Hack ${version} or later.`
    );
  }
}

function optionalText(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && ARGUMENT.test(value))
  );
}

function parseTool(value: unknown): ProjectHostTool {
  if (
    !(isRecord(value) && isNameList(value.bins)) ||
    value.bins.length === 0 ||
    !optionalText(value.version) ||
    !optionalText(value.install) ||
    !optionalText(value.lose) ||
    (value.optional !== undefined && typeof value.optional !== "boolean") ||
    (value.always !== undefined && typeof value.always !== "boolean")
  ) {
    fail("E_INVALID_HOST_TOOL", "Invalid host tool declaration.");
  }
  let bins = value.bins;
  let install = value.install;
  for (const [platform, override] of entries(value.os, "E_INVALID_HOST_TOOL")) {
    if (
      !isRecord(override) ||
      (override.bins !== undefined &&
        (!isNameList(override.bins) || override.bins.length === 0)) ||
      !optionalText(override.version) ||
      !optionalText(override.install)
    ) {
      fail("E_INVALID_HOST_TOOL", "Invalid host tool OS override.");
    }
    if (platform === process.platform) {
      bins = override.bins ?? bins;
      install = override.install ?? install;
    }
  }
  return { bins, install };
}

function toolReferences(
  value: unknown,
  tools: ReadonlyMap<string, ProjectHostTool>
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isNameList(value)) {
    fail("E_INVALID_HOST_TOOL", "Expected an array of host tool names.");
  }
  for (const name of value) {
    if (!tools.has(name)) {
      fail("E_UNKNOWN_HOST_TOOL", `Host tool ${name} is not declared.`);
    }
  }
  return value;
}

function parsePrerequisite(
  value: unknown,
  declared: ReadonlyMap<string, ProjectHostTool>
): ProjectPrerequisite {
  if (!isRecord(value)) {
    fail("E_INVALID_PREREQUISITE", "Expected a prerequisite object.");
  }
  const tools = toolReferences(value.tools, declared);
  if (value.kind === "aws-sso" && isName(value.profile)) {
    return {
      tools,
      check: ["aws", "sts", "get-caller-identity", "--profile", value.profile],
      login: ["aws", "sso", "login", "--profile", value.profile],
      preset: `aws-sso, ${value.profile}`,
    };
  }
  if (value.kind === "gcloud-adc") {
    return {
      tools,
      check: ["gcloud", "auth", "application-default", "print-access-token"],
      login: ["gcloud", "auth", "application-default", "login"],
      preset: "gcloud-adc",
    };
  }
  if (
    value.kind !== undefined ||
    !isArgv(value.check) ||
    !isArgv(value.login)
  ) {
    fail(
      "E_INVALID_PREREQUISITE",
      "Expected a known preset or check and login argv arrays."
    );
  }
  return { tools, check: value.check, login: value.login };
}

function selectedPrerequisites(
  value: unknown,
  requires: ReadonlyMap<string, ProjectPrerequisite>,
  tools: ReadonlyMap<string, ProjectHostTool>
): ProjectPrerequisiteConfig["selected"] {
  return entries(value, "E_INVALID_REMOTE").map(([remote, config]) => {
    if (!(isRecord(config) && isName(config.default))) {
      fail("E_INVALID_REMOTE", `Remote ${remote} needs a default target name.`);
    }
    const targets = entries(config.targets, "E_INVALID_REMOTE");
    const references = new Map<string, readonly string[]>();
    for (const [target, entry] of targets) {
      if (
        !isRecord(entry) ||
        (entry.requires !== undefined && !isNameList(entry.requires))
      ) {
        fail("E_INVALID_REMOTE", `Invalid target ${remote} (${target}).`);
      }
      const names = entry.requires ?? [];
      for (const name of names) {
        if (!requires.has(name)) {
          fail(
            "E_UNKNOWN_PREREQUISITE",
            `${remote} (${target}) refers to undeclared prerequisite ${name}.`
          );
        }
      }
      if (isRecord(entry.via)) {
        toolReferences(entry.via.tools, tools);
      }
      references.set(target, names);
    }
    const names = references.get(config.default);
    if (!names) {
      fail(
        "E_UNKNOWN_REMOTE_TARGET",
        `Remote ${remote} has no target named ${config.default}.`
      );
    }
    return { remote, target: config.default, requires: names };
  });
}

/** Validate the compatibility floor and the declarations needed before Compose starts. */
export function parseProjectPrerequisites(
  config: Record<string, unknown>
): ProjectPrerequisiteConfig {
  validateMinimumVersion(config);
  const tools = new Map(
    entries(config.tools, "E_INVALID_HOST_TOOL").map(([name, value]) => [
      name,
      parseTool(value),
    ])
  );
  const requires = new Map(
    entries(config.requires, "E_INVALID_PREREQUISITE").map(([name, value]) => [
      name,
      parsePrerequisite(value, tools),
    ])
  );
  return {
    tools,
    requires,
    selected: selectedPrerequisites(config.remotes, requires, tools),
  };
}

export type ProjectPrerequisiteValidation =
  | { readonly config: ProjectPrerequisiteConfig; readonly error?: never }
  | { readonly error: HackCliError; readonly config?: never };

export function validateProjectPrerequisites(
  value: Record<string, unknown>
): ProjectPrerequisiteValidation {
  try {
    return { config: parseProjectPrerequisites(value) };
  } catch (error) {
    if (!(error instanceof HackCliError)) {
      throw error;
    }
    return { error };
  }
}
