import { constants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { YAML } from "bun";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_ENV_CONFIG_FILENAME_PREFIX,
  PROJECT_ENV_CONFIG_FILENAME_SUFFIX,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_STATE_FILENAME,
} from "../constants.ts";
import { assertAutostartCheckoutTrusted } from "./autostart-checkout-trust.ts";
import { hasOnlyEngineManagedMounts } from "./autostart-compose-mounts.ts";
import { assertAutostartPathAclsTrusted } from "./autostart-path-acl.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import { inspectLegacyComposeAdoptionSelection } from "./native-compose-adoption-marker.ts";
import { checkReplaceableChain } from "./path-trust.ts";
import {
  findProjectContextAtRoot,
  type ProjectDirName,
  parseProjectConfigRecord,
} from "./project.ts";

export type AutostartStartPolicyReason =
  | "host_commands_require_manual_start"
  | "image_build_requires_manual_start"
  | "command_provider_requires_manual_start"
  | "compose_inputs_require_manual_start"
  | "checkout_untrusted"
  | "pending_env_migration"
  | "adopted_project_requires_manual_start";
export type AutostartStartPolicyOptions = {
  readonly repoRoot: string;
  readonly projectDir: string;
  readonly projectDirName: ProjectDirName;
  /** Explicit-path seam; production reads the owned machine configuration. */
  readonly globalConfigPath?: string;
};
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_INPUT_BYTES;
const MAX_ENV_FILES = 64;
const HOST_CONTROL_ENV_KEY =
  /^(?:COMPOSE_|GIT_|DOCKER_|HACK_|XDG_|LD_|DYLD_|BUN_|HOME$|USER$|LOGNAME$|TMPDIR$|TMP$|TEMP$|SHELL$|PATH$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELLOPTS$|IFS$|CDPATH$|GCONV_PATH$|PYTHON(?:PATH|HOME|STARTUP|INSPECT)$|RUBYOPT$|RUBYLIB$|PERL5OPT$|PERL5LIB$)/;
const DEPENDENCY_INSTALL =
  /(?:^|\s)(?:bun|npm|pnpm|yarn|uv|pip)(?:\s+run)?\s+(?:install|ci|sync)(?:\s|$)/i;
type Budget = { remaining: number; readonly checked: Set<string> };

/** Read-only unattended admission. It never resolves a secret, provider or command. */
export async function autostartStartPolicyRefusal(
  opts: AutostartStartPolicyOptions
): Promise<AutostartStartPolicyReason | null> {
  try {
    assertAutostartCheckoutTrusted(opts);
  } catch {
    return "checkout_untrusted";
  }
  try {
    const adoption = await inspectLegacyComposeAdoptionSelection({
      projectRoot: opts.repoRoot,
    });
    if (["active", "pending"].includes(adoption ?? "")) {
      return "adopted_project_requires_manual_start";
    }
    if (
      resolve(opts.repoRoot, opts.projectDirName) !== resolve(opts.projectDir)
    ) {
      return "compose_inputs_require_manual_start";
    }
    const context = await findProjectContextAtRoot({
      projectRoot: opts.repoRoot,
      projectDirName: opts.projectDirName,
    });
    if (!context) {
      return "compose_inputs_require_manual_start";
    }
    const budget = { remaining: MAX_TOTAL_BYTES, checked: new Set<string>() };
    const { raw, path } = await readProjectPolicyConfig(opts, budget);
    const config = parseProjectConfigRecord(raw, path);
    if (config.parseError || !isRecord(raw)) {
      return "compose_inputs_require_manual_start";
    }
    if (hasHostCommands(raw)) {
      return "host_commands_require_manual_start";
    }
    const globalText = await readPolicyText(
      opts.globalConfigPath ?? resolveGlobalConfigPath(),
      budget
    );
    const global: unknown = globalText === null ? {} : JSON.parse(globalText);
    if (!isRecord(global)) {
      return "compose_inputs_require_manual_start";
    }
    if (hasUnsupportedProvider(raw) || hasUnsupportedProvider(global)) {
      return "command_provider_requires_manual_start";
    }
    const composeText = await readPolicyText(
      resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
      budget
    );
    if (composeText === null) {
      return "compose_inputs_require_manual_start";
    }
    const compose: unknown = YAML.parse(composeText);
    const composeReason = composePolicyReason(compose);
    if (composeReason) {
      return composeReason;
    }
    const envReason = await envPolicyReason({ ...opts, budget });
    await assertAutostartPathAclsTrusted(budget.checked);
    return envReason;
  } catch {
    return "compose_inputs_require_manual_start";
  }
}

/** Refuse before effects with a fixed value-free reason that can release an unstarted claim. */
export async function assertAutostartStartPolicy(
  opts: AutostartStartPolicyOptions
): Promise<void> {
  const reason = await autostartStartPolicyRefusal(opts);
  if (reason) {
    throw new HackCliError({
      code:
        reason === "pending_env_migration"
          ? "E_CONFIG_INVALID"
          : "E_PERMISSION",
      message:
        reason === "pending_env_migration"
          ? "Autostart skipped: pending env migration. Run hack doctor --migrate-env-config."
          : "This project requires an explicit manual start. Run hack up manually; no further unattended startup effects ran. Values omitted.",
      detail: { reason },
    });
  }
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function hasHostCommands(raw: Record<string, unknown>): boolean {
  if (present(raw.startup)) {
    return true;
  }
  if (!isRecord(raw.lifecycle)) {
    return present(raw.lifecycle);
  }
  return [
    raw.lifecycle.up,
    raw.lifecycle.down,
    raw.lifecycle.processes,
    raw.lifecycle.sharedHelpers,
  ].some(present);
}

function hasUnsupportedProvider(raw: Record<string, unknown>): boolean {
  const controlPlane = isRecord(raw.controlPlane) ? raw.controlPlane : {};
  const secrets = isRecord(controlPlane.secrets) ? controlPlane.secrets : {};
  const env = isRecord(raw.env) ? raw.env : {};
  return (
    (secrets.backend !== undefined &&
      !["keychain", "encrypted_file"].includes(String(secrets.backend))) ||
    secrets.backend === "command" ||
    present(secrets.cloud) ||
    present(secrets.command) ||
    present(secrets.provider) ||
    present(env.command) ||
    present(env.providers) ||
    present(env.provider) ||
    present(raw.secretsprovider)
  );
}

function composePolicyReason(
  compose: unknown
): AutostartStartPolicyReason | null {
  if (
    !(isRecord(compose) && isRecord(compose.services)) ||
    Object.keys(compose.services).length === 0 ||
    compose.include !== undefined ||
    compose["<<"] !== undefined ||
    !hasOnlyEngineManagedMounts(compose)
  ) {
    return "compose_inputs_require_manual_start";
  }
  for (const service of Object.values(compose.services)) {
    const reason = servicePolicyReason(service);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function servicePolicyReason(
  service: unknown
): AutostartStartPolicyReason | null {
  if (!isRecord(service)) {
    return "compose_inputs_require_manual_start";
  }
  if (service.build !== undefined) {
    return "image_build_requires_manual_start";
  }
  if (service.extends !== undefined || service.env_file !== undefined) {
    return "compose_inputs_require_manual_start";
  }
  if (service.provider !== undefined) {
    return "command_provider_requires_manual_start";
  }
  const labels = service.labels;
  let names: readonly string[] = [];
  if (Array.isArray(labels)) {
    names = labels
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.split("=")[0] ?? "");
  } else if (isRecord(labels)) {
    names = Object.keys(labels);
  }
  if (names.some((name) => name.startsWith("hack.dependencies."))) {
    return "host_commands_require_manual_start";
  }
  const command = [service.entrypoint, service.command]
    .map(commandText)
    .join(" ");
  return DEPENDENCY_INSTALL.test(command)
    ? "host_commands_require_manual_start"
    : null;
}

function commandText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(" ");
  }
  return typeof value === "string" ? value : "";
}

async function envPolicyReason(
  opts: AutostartStartPolicyOptions & { readonly budget: Budget }
): Promise<AutostartStartPolicyReason | null> {
  for (const directory of new Set([opts.repoRoot, opts.projectDir])) {
    const entries = await readdir(directory);
    const inputs = entries.filter(isEnvironmentInput);
    if (inputs.length > MAX_ENV_FILES) {
      return "compose_inputs_require_manual_start";
    }
    for (const name of inputs) {
      const text = await readPolicyText(resolve(directory, name), opts.budget);
      if (text === null) {
        return "compose_inputs_require_manual_start";
      }
      const reason = environmentInputReason({ name, text });
      if (reason) {
        return reason;
      }
    }
  }
  return null;
}

function isEnvironmentInput(name: string): boolean {
  return (
    (name.startsWith(".env") && name !== PROJECT_ENV_STATE_FILENAME) ||
    name === PROJECT_ENV_CONTRACT_FILENAME ||
    (name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
      name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX))
  );
}

function environmentInputReason(opts: {
  readonly name: string;
  readonly text: string;
}): AutostartStartPolicyReason | null {
  if (!opts.name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)) {
    return opts.text.trim() === "" ? null : "pending_env_migration";
  }
  const layer: unknown = YAML.parse(opts.text);
  if (!isRecord(layer) || layer.secretsprovider !== "project_key") {
    return "command_provider_requires_manual_start";
  }
  if (layer.version !== 1 || !isRecord(layer.values)) {
    return "compose_inputs_require_manual_start";
  }
  if (
    present(layer.providers) ||
    present(layer.command) ||
    present(layer.provider) ||
    present(layer.cloud)
  ) {
    return "command_provider_requires_manual_start";
  }
  for (const values of Object.values(layer.values)) {
    const reason = environmentScopeReason(values);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function environmentScopeReason(
  values: unknown
): AutostartStartPolicyReason | null {
  if (!isRecord(values)) {
    return "compose_inputs_require_manual_start";
  }
  for (const [key, value] of Object.entries(values)) {
    if (HOST_CONTROL_ENV_KEY.test(key)) {
      return "compose_inputs_require_manual_start";
    }
    if (
      isRecord(value) &&
      (Object.keys(value).length !== 1 || typeof value.secure !== "string")
    ) {
      return "command_provider_requires_manual_start";
    }
    if (Array.isArray(value)) {
      return "command_provider_requires_manual_start";
    }
  }
  return null;
}

async function readProjectPolicyConfig(
  opts: AutostartStartPolicyOptions,
  budget: Budget
) {
  const jsonPath = resolve(opts.projectDir, PROJECT_CONFIG_FILENAME);
  const json = await readPolicyText(jsonPath, budget);
  const path =
    json === null
      ? resolve(opts.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
      : jsonPath;
  const text = json ?? (await readPolicyText(path, budget));
  let raw: unknown = {};
  if (text !== null) {
    raw = json === null ? Bun.TOML.parse(text) : JSON.parse(text);
  }
  return { raw, path };
}

async function readPolicyText(
  path: string,
  budget: Budget
): Promise<string | null> {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    checkReplaceableChain({
      path: dirname(path),
      uid,
      hackHome: null,
      checked: budget.checked,
    }) !== null
  ) {
    throw new Error("Unsafe input parent");
  }
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    if (
      isRecord(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== uid ||
      (before.mode & 0o022) !== 0 ||
      before.size > MAX_INPUT_BYTES ||
      before.size > budget.remaining
    ) {
      throw new Error("Unsupported input");
    }
    const bytes = new Uint8Array(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length
      );
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    const after = await file.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Input changed");
    }
    budget.remaining -= length;
    budget.checked.add(path);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length)
    );
  } finally {
    await file.close();
  }
}
