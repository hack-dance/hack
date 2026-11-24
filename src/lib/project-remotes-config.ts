import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { HACK_VERSION } from "./hack-version.ts";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_TEMPLATE = /^(?:[^{}]|\{host\}|\{port\})+$/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
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

export type ProjectRemoteAddress =
  | { readonly kind: "service"; readonly service: string }
  | { readonly kind: "hostname"; readonly hostname: string }
  | { readonly kind: "env_ref"; readonly name: string };

export interface ProjectRemoteTarget {
  readonly address: ProjectRemoteAddress;
  readonly port: number;
  readonly confirm: boolean;
  readonly via?: "aws-ssm";
  readonly requires: readonly string[];
}

export interface SelectedProjectRemote extends ProjectRemoteTarget {
  readonly remote: string;
  readonly target: string;
  readonly targets: ReadonlyMap<string, ProjectRemoteTarget>;
  readonly bindings: Readonly<Record<string, string>>;
}

export interface ProjectPrerequisiteConfig {
  readonly tools: ReadonlyMap<string, ProjectHostTool>;
  readonly requires: ReadonlyMap<string, ProjectPrerequisite>;
  readonly selected: readonly SelectedProjectRemote[];
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
    if (
      config.requires !== undefined ||
      config.remotes !== undefined ||
      config.tools !== undefined
    ) {
      fail(
        "E_MIN_CLI_VERSION_REQUIRED",
        "requires, remotes and tools need min_cli_version."
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

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function optionalFlag(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
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
    !onlyKeys(value, [
      "bins",
      "version",
      "optional",
      "lose",
      "os",
      "install",
      "always",
    ]) ||
    !optionalText(value.version) ||
    !optionalText(value.install) ||
    !optionalText(value.lose) ||
    !optionalFlag(value.optional) ||
    !optionalFlag(value.always)
  ) {
    fail("E_INVALID_HOST_TOOL", "Invalid host tool declaration.");
  }
  let bins = value.bins;
  let install = value.install;
  for (const [platform, override] of entries(value.os, "E_INVALID_HOST_TOOL")) {
    if (
      !(
        isRecord(override) && onlyKeys(override, ["bins", "version", "install"])
      ) ||
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
  if (
    value.kind === "aws-sso" &&
    isName(value.profile) &&
    onlyKeys(value, ["kind", "profile", "tools"])
  ) {
    return {
      tools,
      check: ["aws", "sts", "get-caller-identity", "--profile", value.profile],
      login: ["aws", "sso", "login", "--profile", value.profile],
      preset: `aws-sso, ${value.profile}`,
    };
  }
  if (value.kind === "gcloud-adc" && onlyKeys(value, ["kind", "tools"])) {
    return {
      tools,
      check: ["gcloud", "auth", "application-default", "print-access-token"],
      login: ["gcloud", "auth", "application-default", "login"],
      preset: "gcloud-adc",
    };
  }
  if (
    !(
      onlyKeys(value, ["check", "login", "tools"]) &&
      isArgv(value.check) &&
      isArgv(value.login)
    )
  ) {
    fail(
      "E_INVALID_PREREQUISITE",
      "Expected a known preset or check and login argv arrays."
    );
  }
  return { tools, check: value.check, login: value.login };
}

function parseTargetAddress(
  entry: Record<string, unknown>
): ProjectRemoteAddress | null {
  if (entry.service !== undefined) {
    return isName(entry.service) &&
      entry.hostname === undefined &&
      entry.via === undefined
      ? { kind: "service", service: entry.service }
      : null;
  }
  const hostname = entry.hostname;
  if (typeof hostname === "string" && HOSTNAME.test(hostname)) {
    return { kind: "hostname", hostname };
  }
  if (
    isRecord(hostname) &&
    onlyKeys(hostname, ["env_ref"]) &&
    typeof hostname.env_ref === "string" &&
    ENV_NAME.test(hostname.env_ref)
  ) {
    return { kind: "env_ref", name: hostname.env_ref };
  }
  return null;
}

function validateVia(
  value: unknown,
  tools: ProjectPrerequisiteConfig["tools"]
): ProjectRemoteTarget["via"] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !(
      isRecord(value) &&
      onlyKeys(value, ["kind", "instance", "region", "listen", "tools"])
    ) ||
    value.kind !== "aws-ssm" ||
    !isName(value.instance) ||
    !isName(value.region) ||
    !isPort(value.listen)
  ) {
    fail("E_INVALID_REMOTE", "Invalid remote tunnel declaration.");
  }
  toolReferences(value.tools, tools);
  return value.kind;
}

function parseRemoteTarget(opts: {
  readonly remote: string;
  readonly target: string;
  readonly entry: unknown;
  readonly requires: ProjectPrerequisiteConfig["requires"];
  readonly tools: ProjectPrerequisiteConfig["tools"];
}): ProjectRemoteTarget {
  const { remote, target, entry, requires, tools } = opts;
  if (
    !(
      isRecord(entry) &&
      onlyKeys(entry, [
        "service",
        "hostname",
        "port",
        "requires",
        "confirm",
        "via",
        "intercept",
      ]) &&
      isPort(entry.port) &&
      optionalFlag(entry.confirm) &&
      optionalFlag(entry.intercept)
    ) ||
    (entry.requires !== undefined && !isNameList(entry.requires))
  ) {
    fail("E_INVALID_REMOTE", `Invalid target ${remote} (${target}).`);
  }
  const address = parseTargetAddress(entry);
  if (!address) {
    fail("E_INVALID_REMOTE", `Invalid address for ${remote} (${target}).`);
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
  const via = validateVia(entry.via, tools);
  return {
    address,
    port: entry.port,
    confirm: entry.confirm === true,
    requires: names,
    via,
  };
}

function remoteEnvBindings(value: unknown): Readonly<Record<string, string>> {
  const bindings: Record<string, string> = Object.create(null);
  for (const [name, template] of entries(value, "E_INVALID_REMOTE")) {
    if (
      !ENV_NAME.test(name) ||
      typeof template !== "string" ||
      !ARGUMENT.test(template) ||
      !ENV_TEMPLATE.test(template)
    ) {
      fail("E_INVALID_REMOTE", "Invalid remote environment mapping.");
    }
    bindings[name] = template;
  }
  return bindings;
}

function selectedPrerequisites(
  value: unknown,
  requires: ProjectPrerequisiteConfig["requires"],
  tools: ProjectPrerequisiteConfig["tools"]
): ProjectPrerequisiteConfig["selected"] {
  return entries(value, "E_INVALID_REMOTE").map(([remote, config]) => {
    if (
      !(
        isRecord(config) &&
        onlyKeys(config, ["default", "targets", "env"]) &&
        isName(config.default)
      )
    ) {
      fail("E_INVALID_REMOTE", `Invalid remote ${remote}.`);
    }
    const references = new Map(
      entries(config.targets, "E_INVALID_REMOTE").map(([target, entry]) => [
        target,
        parseRemoteTarget({ remote, target, entry, requires, tools }),
      ])
    );
    const selected = references.get(config.default);
    if (!selected) {
      fail(
        "E_UNKNOWN_REMOTE_TARGET",
        `Remote ${remote} has no target named ${config.default}.`
      );
    }
    if (selected.confirm) {
      fail(
        "E_INVALID_REMOTE",
        `Remote ${remote} cannot default to a target that requires confirmation.`
      );
    }
    const bindings = remoteEnvBindings(config.env);
    return {
      remote,
      target: config.default,
      ...selected,
      targets: references,
      bindings,
    };
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
