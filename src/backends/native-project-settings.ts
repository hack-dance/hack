import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { sanitizeProjectSlug } from "../lib/project.ts";
import { isNativeAwsSelector } from "./native-aws-environment.ts";
import {
  type NativePreparedBase,
  parseNativePreparedBase,
} from "./native-prepared-base.ts";
import {
  parseNativeAllowedHosts,
  validateNativeAllowedHosts,
} from "./native-project-network.ts";
import {
  type NativeEnvSelectedFile,
  readNativeSelection,
  selectNativeEnvFile,
} from "./native-project-selection.ts";
import {
  type NativeHttpsSelection,
  parseNativeHttpsSelection,
} from "./native-project-start.ts";

/**
 * Native image-project settings from three places, resolved once per command.
 *
 * - **Project intent** is committed in the project: `.hack/native/adaptation.json` and
 *   optional `.hack/native/adaptation.<env>.json`. It has the same authority as the
 *   Compose file it adapts and grants nothing.
 * - **Machine settings** live outside every project share, in
 *   `${XDG_CONFIG_HOME:-$HOME/.config}/hack/native/<project>/settings.json`. They hold
 *   grants and host authority: the source-share grant, the AWS profile, host dependency
 *   files, HTTPS, prepared base and approved hosts. Because any checkout can claim a
 *   project name, a record applies only to the canonical project roots it lists in
 *   `projectRoots`; any other checkout is refused with `E_PERMISSION`.
 * - **Environment variables** (`HACK_NATIVE_*`) override either, per setting.
 *
 * Precedence is per setting and whole-value: a variable that is set wins entirely, then
 * the machine file, then the project file; nothing is merged. Resolution reads only and
 * writes no state, so cancellation needs no cleanup. A file that is present but invalid
 * refuses with one closed `E_CONFIG_INVALID` line; there is no fallback.
 */
export type NativeSettingOrigin = "env" | "machine" | "project" | "unset";

/** The settings `hack doctor` reports, in a fixed order. */
export const NATIVE_SETTING_KEYS = [
  "adaptation",
  "sharedSource",
  "dependencies",
  "allowHosts",
  "preparedBase",
  "https",
  "aws",
] as const;
export type NativeSettingKey = (typeof NATIVE_SETTING_KEYS)[number];

/** The committed project settings directory inside `.hack/`. */
export const NATIVE_PROJECT_SETTINGS_DIRNAME = "native";
const ADAPTATION_FILE = /^adaptation(?:\.([a-z0-9]+(?:-[a-z0-9]+)*))?\.json$/;
const MACHINE_FILENAME = "settings.json";
const MACHINE_KEYS = new Set([
  "version",
  "projectRoots",
  "sharedSource",
  "dependencies",
  "dependenciesByEnv",
  "allowHosts",
  "preparedBase",
  "https",
  "aws",
]);
const ENV_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIBLING_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const PROJECT_ENTRY_LIMIT = 64;
const PROJECT_ROOT_LIMIT = 16;
const CONTROL = /[\x00-\x1f\x7f]/;
const ENV_OVERLAY_LIMIT = 32;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * A variable that is present selects its setting, even when empty, so every existing
 * script keeps its exact behavior (an empty path or list still refuses).
 */
function set(env: Environment, name: string): boolean {
  return env[name] !== undefined;
}

/** HOME and the AWS profile keep their non-empty meaning. */
function nonEmpty(env: Environment, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== "";
}

function projectRefused(): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native project settings in .hack/native/ must be a real directory of bounded regular adaptation files; values omitted.",
  });
}

function machineRefused(detail: string): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `Native machine settings ${detail}; values omitted.`,
  });
}

function fieldRefused(key: string): HackCliError {
  return machineRefused(`field ${key} is invalid`);
}

function machineNotGranted(detail: string): HackCliError {
  return new HackCliError({
    code: "E_PERMISSION",
    message: `Native machine settings ${detail}. To grant this checkout, add its absolute path to "projectRoots" in \${XDG_CONFIG_HOME:-$HOME/.config}/hack/native/<project>/settings.json; values omitted.`,
  });
}

/**
 * The machine record is keyed by project name, which any checkout can claim. Refuse it,
 * before any other field is read, unless `projectRoots` lists this canonical project
 * root. Listed roots are canonicalized too, so a symbolic link to a granted root (or a
 * granted path that is itself a link) matches; a root that no longer exists is skipped.
 */
async function requireMachineProjectRoot(opts: {
  readonly value: unknown;
  readonly projectRoot: string;
}): Promise<void> {
  if (!(isRecord(opts.value) && opts.value.version === 1)) {
    throw machineRefused("require version 1");
  }
  const roots = opts.value.projectRoots;
  if (roots === undefined) {
    throw machineNotGranted("are not bound to a project root");
  }
  if (
    !(
      Array.isArray(roots) &&
      roots.length > 0 &&
      roots.length <= PROJECT_ROOT_LIMIT &&
      roots.every(
        (root) =>
          typeof root === "string" &&
          root.length <= 4096 &&
          isAbsolute(root) &&
          !CONTROL.test(root)
      )
    )
  ) {
    throw fieldRefused("projectRoots");
  }
  for (const root of roots as readonly string[]) {
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      continue;
    }
    if (canonical === opts.projectRoot) {
      return;
    }
  }
  throw machineNotGranted("do not grant this project root");
}

/** The adaptation native start applies: one explicit file, or the committed files. */
export interface NativeAdaptationSelection extends NativeEnvSelectedFile {
  readonly origin: Exclude<NativeSettingOrigin, "machine">;
}

/**
 * Resolve the adaptation selection. `HACK_NATIVE_ADAPTATION`, when set, wins whole;
 * otherwise `.hack/native/adaptation.json` and `adaptation.<env>.json` are discovered.
 * Discovery lists names only; files are read with the bounded selection reader when a
 * command applies them, which refuses links, hard links and changed files.
 */
export async function resolveNativeAdaptationSelection(opts: {
  readonly env: Environment;
  readonly projectDir: string;
}): Promise<NativeAdaptationSelection> {
  if (set(opts.env, "HACK_NATIVE_ADAPTATION")) {
    return {
      origin: "env",
      file: opts.env.HACK_NATIVE_ADAPTATION,
      fileByEnv: {},
    };
  }
  const directory = join(opts.projectDir, NATIVE_PROJECT_SETTINGS_DIRNAME);
  let names: string[];
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory()) {
      throw projectRefused();
    }
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { origin: "unset", fileByEnv: {} };
    }
    throw error instanceof HackCliError ? error : projectRefused();
  }
  if (names.length > PROJECT_ENTRY_LIMIT) {
    throw projectRefused();
  }
  let file: string | undefined;
  const fileByEnv: Record<string, string> = {};
  for (const name of names.sort()) {
    const match = ADAPTATION_FILE.exec(name);
    if (!match) {
      continue;
    }
    const envName = match[1];
    if (envName === undefined) {
      file = join(directory, name);
    } else {
      fileByEnv[envName] = join(directory, name);
    }
  }
  if (Object.keys(fileByEnv).length > ENV_OVERLAY_LIMIT) {
    throw projectRefused();
  }
  return {
    origin:
      file === undefined && Object.keys(fileByEnv).length === 0
        ? "unset"
        : "project",
    ...(file === undefined ? {} : { file }),
    fileByEnv,
  };
}

/**
 * Every adaptation file a command could apply. With an explicit `--env` this is exactly
 * the selected file; without one the effective env is not known until the managed env is
 * prepared (it may be the project default or a retained run's env), so every candidate is
 * returned, with `undefined` for "no adaptation". A caller that needs one answer for all
 * candidates (the Compose-backend pre-check) must take the most restrictive one.
 */
export function nativeAdaptationCandidates(opts: {
  readonly selection: NativeAdaptationSelection;
  readonly requestedEnvName: string | null | undefined;
}): readonly (string | undefined)[] {
  if (opts.requestedEnvName !== undefined) {
    return [
      selectNativeEnvFile({
        selection: opts.selection,
        envName: opts.requestedEnvName,
      }),
    ];
  }
  return [
    opts.selection.file,
    ...Object.values(opts.selection.fileByEnv ?? {}),
  ];
}

/** Grants and host authority, resolved from the environment and machine settings. */
export interface NativeHostSettings {
  readonly sharedSource: boolean;
  readonly dependencyFile?: string;
  readonly dependencyFileByEnv?: Readonly<Record<string, string>>;
  readonly allowedHosts: readonly string[];
  readonly preparedBase?: NativePreparedBase;
  readonly https?: NativeHttpsSelection;
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly origins: Readonly<
    Record<Exclude<NativeSettingKey, "adaptation">, NativeSettingOrigin>
  >;
  /** Canonical settings file path when one was read. */
  readonly machineFile?: string;
}

/**
 * The machine settings directory for a project, or undefined when no home is known.
 * `XDG_CONFIG_HOME` counts only when absolute, as the XDG base directory rules say.
 */
export function nativeMachineSettingsDirectory(opts: {
  readonly env: Environment;
  readonly projectName: string;
}): string | undefined {
  const xdg = opts.env.XDG_CONFIG_HOME;
  let configHome: string | undefined;
  if (xdg !== undefined && isAbsolute(xdg)) {
    configHome = xdg;
  } else {
    const home = nonEmpty(opts.env, "HOME") ? opts.env.HOME : safeHomedir();
    configHome =
      home !== undefined && isAbsolute(home)
        ? join(home, ".config")
        : undefined;
  }
  return configHome === undefined
    ? undefined
    : join(configHome, "hack", "native", sanitizeProjectSlug(opts.projectName));
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    !(path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path))
  );
}

/**
 * Locate and read the machine settings file. Absent directory or file means no machine
 * settings. A present file requires a real, current-user-owned directory without group
 * or other bits, outside the project root (so no project share can reach it), and an
 * owner-only regular file whose `projectRoots` grants this project root; anything else
 * refuses.
 */
async function readMachineSettings(opts: {
  readonly env: Environment;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly uid: number | undefined;
}): Promise<
  | {
      readonly directory: string;
      readonly file: string;
      readonly value: unknown;
    }
  | undefined
> {
  const directory = nativeMachineSettingsDirectory(opts);
  if (directory === undefined) {
    return undefined;
  }
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(directory);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw machineRefused("directory is unreadable");
  }
  const uid = opts.uid;
  if (
    uid === undefined ||
    !stats.isDirectory() ||
    stats.uid !== uid ||
    (stats.mode & 0o077) !== 0
  ) {
    throw machineRefused(
      "directory must be a real directory owned by the current user with mode 0700"
    );
  }
  let canonical: string;
  let root: string;
  try {
    canonical = await realpath(directory);
    root = await realpath(opts.projectRoot);
  } catch {
    throw machineRefused("directory is unreadable");
  }
  if (inside(root, canonical) || inside(canonical, root)) {
    throw machineRefused("directory must be outside the project root");
  }
  const file = join(canonical, MACHINE_FILENAME);
  try {
    await lstat(file);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw machineRefused("file is unreadable");
  }
  let value: unknown;
  try {
    value = await readNativeSelection(file, { privateToUid: uid });
  } catch {
    throw machineRefused(
      "file must be a bounded owner-only (mode 0600) regular JSON file"
    );
  }
  await requireMachineProjectRoot({ value, projectRoot: root });
  return { directory: canonical, file, value };
}

function siblingFile(directory: string, value: unknown, key: string): string {
  if (
    typeof value !== "string" ||
    !SIBLING_FILE.test(value) ||
    value === MACHINE_FILENAME
  ) {
    throw fieldRefused(key);
  }
  return join(directory, value);
}

function machineDependencies(
  directory: string,
  settings: Record<string, unknown>
) {
  const file =
    settings.dependencies === undefined
      ? undefined
      : siblingFile(directory, settings.dependencies, "dependencies");
  const byEnvValue = settings.dependenciesByEnv;
  const fileByEnv: Record<string, string> = {};
  if (byEnvValue !== undefined) {
    if (
      !isRecord(byEnvValue) ||
      Object.keys(byEnvValue).length > ENV_OVERLAY_LIMIT
    ) {
      throw fieldRefused("dependenciesByEnv");
    }
    for (const [envName, name] of Object.entries(byEnvValue)) {
      if (!ENV_NAME.test(envName)) {
        throw fieldRefused("dependenciesByEnv");
      }
      fileByEnv[envName] = siblingFile(directory, name, "dependenciesByEnv");
    }
  }
  return { file, fileByEnv };
}

function machineAllowedHosts(value: unknown): readonly string[] {
  if (
    !(Array.isArray(value) && value.every((host) => typeof host === "string"))
  ) {
    throw fieldRefused("allowHosts");
  }
  try {
    return validateNativeAllowedHosts(value);
  } catch {
    throw fieldRefused("allowHosts");
  }
}

function machinePreparedBase(value: unknown): NativePreparedBase | undefined {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).every((key) => key === "mode" || key === "store") &&
      typeof value.mode === "string" &&
      (value.store === undefined || typeof value.store === "string")
    )
  ) {
    throw fieldRefused("preparedBase");
  }
  try {
    return parseNativePreparedBase({
      HACK_NATIVE_PREPARED_BASE: value.mode,
      HACK_NATIVE_PREPARED_BASE_STORE: value.store,
    });
  } catch {
    throw fieldRefused("preparedBase");
  }
}

function machineHttps(value: unknown): NativeHttpsSelection | undefined {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).every((key) =>
        ["caddyBinary", "caddySha256", "port"].includes(key)
      ) &&
      typeof value.caddyBinary === "string" &&
      typeof value.caddySha256 === "string" &&
      typeof value.port === "number" &&
      Number.isSafeInteger(value.port)
    )
  ) {
    throw fieldRefused("https");
  }
  try {
    return parseNativeHttpsSelection({
      HACK_NATIVE_CADDY_BINARY: value.caddyBinary,
      HACK_NATIVE_CADDY_SHA256: value.caddySha256,
      HACK_NATIVE_HTTPS_PORT: String(value.port),
    });
  } catch {
    throw fieldRefused("https");
  }
}

function machineAws(value: unknown): {
  readonly profile: string;
  readonly region?: string;
} {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).every(
        (key) => key === "profile" || key === "region"
      ) &&
      typeof value.profile === "string" &&
      (value.region === undefined || typeof value.region === "string") &&
      isNativeAwsSelector({
        profile: value.profile,
        ...(value.region === undefined ? {} : { region: value.region }),
      })
    )
  ) {
    throw fieldRefused("aws");
  }
  return {
    profile: value.profile,
    ...(value.region === undefined ? {} : { region: value.region }),
  };
}

function validMachineRecord(value: unknown): Record<string, unknown> {
  if (!(isRecord(value) && value.version === 1)) {
    throw machineRefused("require version 1");
  }
  if (!Object.keys(value).every((key) => MACHINE_KEYS.has(key))) {
    throw machineRefused("contain an unsupported field");
  }
  if (
    value.sharedSource !== undefined &&
    typeof value.sharedSource !== "boolean"
  ) {
    throw fieldRefused("sharedSource");
  }
  return value;
}

type MachineValues = {
  readonly sharedSource?: boolean;
  readonly dependencies: ReturnType<typeof machineDependencies>;
  readonly allowHosts?: readonly string[];
  readonly preparedBase?: NativePreparedBase;
  /** `preparedBase: {"mode":"off"}` is a machine choice that selects nothing. */
  readonly preparedBaseSet: boolean;
  readonly https?: NativeHttpsSelection;
  readonly aws?: { readonly profile: string; readonly region?: string };
};

/** Validate every machine value, even ones a variable overrides. */
function machineValues(
  machine: { readonly directory: string; readonly value: unknown } | undefined
): MachineValues {
  if (!machine) {
    return {
      dependencies: { file: undefined, fileByEnv: {} },
      preparedBaseSet: false,
    };
  }
  const settings = validMachineRecord(machine.value);
  return {
    ...(typeof settings.sharedSource === "boolean"
      ? { sharedSource: settings.sharedSource }
      : {}),
    dependencies: machineDependencies(machine.directory, settings),
    ...(settings.allowHosts === undefined
      ? {}
      : { allowHosts: machineAllowedHosts(settings.allowHosts) }),
    ...(settings.preparedBase === undefined
      ? {}
      : { preparedBase: machinePreparedBase(settings.preparedBase) }),
    preparedBaseSet: settings.preparedBase !== undefined,
    ...(settings.https === undefined
      ? {}
      : { https: machineHttps(settings.https) }),
    ...(settings.aws === undefined ? {} : { aws: machineAws(settings.aws) }),
  };
}

/** The AWS variables, refused here when native AWS adaptation would refuse them. */
function envAws(env: Environment): {
  readonly profile: string;
  readonly region?: string;
} {
  const selected = {
    profile: env.HACK_NATIVE_AWS_PROFILE ?? "",
    region: env.HACK_NATIVE_AWS_REGION,
  };
  if (!isNativeAwsSelector(selected)) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "HACK_NATIVE_AWS_PROFILE or HACK_NATIVE_AWS_REGION is not a valid AWS selector; values omitted.",
    });
  }
  return selected;
}

/** Whole-value precedence for one setting: a set variable, else the machine value. */
function pick<T>(opts: {
  readonly envSet: boolean;
  readonly fromEnv: () => T;
  readonly machineSet: boolean;
  readonly machine: T;
}): { readonly value: T; readonly origin: NativeSettingOrigin } {
  if (opts.envSet) {
    return { value: opts.fromEnv(), origin: "env" };
  }
  return { value: opts.machine, origin: opts.machineSet ? "machine" : "unset" };
}

/**
 * Resolve grants and host authority for native `up` and `restart`. Every machine value
 * is validated here even when a variable overrides it, so a broken file never waits for
 * the day its override is removed. A non-empty `HACK_NATIVE_AWS_PROFILE` alone selects
 * the AWS variables, as before; `HACK_NATIVE_AWS_REGION` without it is ignored.
 */
export async function resolveNativeHostSettings(opts: {
  readonly env: Environment;
  readonly projectName: string;
  readonly projectRoot: string;
  /** Defaults to the current process user; tests inject it. */
  readonly uid?: number;
}): Promise<NativeHostSettings> {
  const env = opts.env;
  const machine = await readMachineSettings({
    env,
    projectName: opts.projectName,
    projectRoot: opts.projectRoot,
    uid:
      opts.uid ??
      (typeof process.getuid === "function" ? process.getuid() : undefined),
  });
  const values = machineValues(machine);
  const sharedSource = pick({
    envSet: set(env, "HACK_NATIVE_SHARED_SOURCE"),
    fromEnv: () => env.HACK_NATIVE_SHARED_SOURCE === "1",
    machineSet: values.sharedSource !== undefined,
    machine: values.sharedSource === true,
  });
  const dependencies = pick<{
    readonly file?: string;
    readonly fileByEnv: Readonly<Record<string, string>>;
  }>({
    envSet: set(env, "HACK_NATIVE_DEPENDENCIES"),
    fromEnv: () => ({ file: env.HACK_NATIVE_DEPENDENCIES, fileByEnv: {} }),
    machineSet:
      values.dependencies.file !== undefined ||
      Object.keys(values.dependencies.fileByEnv).length > 0,
    machine: values.dependencies,
  });
  const allowHosts = pick({
    envSet: set(env, "HACK_NATIVE_ALLOW_HOSTS"),
    fromEnv: () => parseNativeAllowedHosts(env.HACK_NATIVE_ALLOW_HOSTS),
    machineSet: values.allowHosts !== undefined,
    machine: values.allowHosts ?? [],
  });
  const preparedBase = pick({
    envSet:
      set(env, "HACK_NATIVE_PREPARED_BASE") ||
      set(env, "HACK_NATIVE_PREPARED_BASE_STORE"),
    fromEnv: () => parseNativePreparedBase(env),
    machineSet: values.preparedBaseSet,
    machine: values.preparedBase,
  });
  const https = pick({
    envSet:
      set(env, "HACK_NATIVE_CADDY_BINARY") ||
      set(env, "HACK_NATIVE_CADDY_SHA256") ||
      set(env, "HACK_NATIVE_HTTPS_PORT"),
    fromEnv: () => parseNativeHttpsSelection(env),
    machineSet: values.https !== undefined,
    machine: values.https,
  });
  const aws = pick<NativeHostSettings["aws"]>({
    envSet: nonEmpty(env, "HACK_NATIVE_AWS_PROFILE"),
    fromEnv: () => envAws(env),
    machineSet: values.aws !== undefined,
    machine: values.aws,
  });
  return {
    sharedSource: sharedSource.value,
    ...(dependencies.value.file === undefined
      ? {}
      : { dependencyFile: dependencies.value.file }),
    dependencyFileByEnv: dependencies.value.fileByEnv,
    allowedHosts: allowHosts.value,
    ...(preparedBase.value === undefined
      ? {}
      : { preparedBase: preparedBase.value }),
    ...(https.value === undefined ? {} : { https: https.value }),
    ...(aws.value === undefined ? {} : { aws: aws.value }),
    origins: {
      sharedSource: sharedSource.origin,
      dependencies: dependencies.origin,
      allowHosts: allowHosts.origin,
      preparedBase: preparedBase.origin,
      https: https.origin,
      aws: aws.origin,
    },
    ...(machine ? { machineFile: machine.file } : {}),
  };
}
