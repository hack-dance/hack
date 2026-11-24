import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { YAML } from "bun";
import {
  PROJECT_ENV_CONFIG_FILENAME_PREFIX,
  PROJECT_ENV_CONFIG_FILENAME_SUFFIX,
} from "../constants.ts";
import { childEnvironment } from "./child-environment.ts";
import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { canPrompt } from "./interactivity.ts";
import { waitForOwnedProcessGroupSettlement } from "./process-group-settlement.ts";
import { composeServiceEnvironmentKeys } from "./project-env-config.ts";
import type {
  ProjectPrerequisite,
  ProjectPrerequisiteConfig,
  ProjectPrerequisiteValidation,
} from "./project-remotes-config.ts";
import { findExecutableInPath } from "./shell.ts";
import { resolvePrimaryLocalProjectDir } from "./worktree-local-config.ts";

const UNQUOTED_ARG = /^[a-zA-Z0-9_.:/@%+=,-]+$/;
const COMPOSE_VARIABLE = /\$\$|\$\{?([a-zA-Z_][a-zA-Z0-9_]*)/g;
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_SETTLEMENT_TIMEOUT_MS = 5000;

type CheckState =
  | { readonly state: "ok" }
  | {
      readonly state: "missing";
      readonly bin: string;
      readonly tool: string;
      readonly hint?: string;
    }
  | {
      readonly state: "failed";
      readonly exitCode: number;
      readonly signal?: NodeJS.Signals | number;
    }
  | { readonly state: "timeout" }
  | {
      readonly state: "cancelled";
      readonly signal: "SIGINT" | "SIGTERM";
      readonly stopUnconfirmed?: boolean;
    }
  | { readonly state: "cleanup pending" };

function resolveExecutable(bin: string): string | null {
  const path = findExecutableInPath(bin);
  return path && isAbsolute(path) ? path : null;
}

function withinProject(path: string, projectRoot: string): boolean {
  const location = relative(projectRoot, path);
  return (
    location !== ".." &&
    !location.startsWith(`..${sep}`) &&
    !isAbsolute(location)
  );
}

function isProjectExecutable(path: string, projectRoot: string): boolean {
  if (withinProject(path, projectRoot)) {
    return true;
  }
  try {
    return withinProject(realpathSync(path), realpathSync(projectRoot));
  } catch {
    return false;
  }
}

type ExecutableNotice = (bin: string, path: string) => void;

function findMissingTool(
  requirement: ProjectPrerequisite,
  tools: ProjectPrerequisiteConfig["tools"]
): Extract<CheckState, { state: "missing" }> | undefined {
  for (const name of requirement.tools) {
    const tool = tools.get(name);
    const missing = tool?.bins.find((bin) => !resolveExecutable(bin));
    if (missing) {
      return {
        state: "missing",
        bin: missing,
        tool: name,
        hint: tool?.install,
      };
    }
  }
  return undefined;
}

async function checkPrerequisite(
  requirement: ProjectPrerequisite,
  tools: ProjectPrerequisiteConfig["tools"],
  cwd: string,
  notice?: ExecutableNotice
): Promise<CheckState> {
  const missing = findMissingTool(requirement, tools);
  if (missing) {
    return missing;
  }
  const [bin, ...args] = requirement.check;
  const executable = resolveExecutable(bin);
  if (!executable) {
    return { state: "missing", bin, tool: bin };
  }
  let child: Bun.Subprocess | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let stopRequested = false;
  const endGroup = (): void => {
    if (!child || stopRequested) {
      return;
    }
    stopRequested = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group can already have exited.
    }
  };
  let cancelledBy: "SIGINT" | "SIGTERM" | undefined;
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    cancelledBy ??= signal;
    endGroup();
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    notice?.(bin, executable);
    if (cancelledBy) {
      return { state: "cancelled", signal: cancelledBy };
    }
    child = Bun.spawn([executable, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      env: childEnvironment(process.env, { AWS_CLI_AUTO_PROMPT: "off" }),
    });
    // A handler invoked during spawn records cancellation before it has a PID.
    if (cancelledBy) {
      endGroup();
    }
    deadline = setTimeout(() => {
      timedOut = true;
      endGroup();
    }, CHECK_TIMEOUT_MS);
    const exitCode = await child.exited;
    endGroup();
    const settled = await waitForOwnedProcessGroupSettlement({
      processGroupId: child.pid,
      timeoutMs: CHECK_SETTLEMENT_TIMEOUT_MS,
    });
    if (cancelledBy) {
      return {
        state: "cancelled",
        signal: cancelledBy,
        stopUnconfirmed: !settled,
      };
    }
    if (!settled) {
      return { state: "cleanup pending" };
    }
    if (timedOut) {
      return { state: "timeout" };
    }
    const signal = child.signalCode ?? undefined;
    return exitCode === 0 && !signal
      ? { state: "ok" }
      : { state: "failed", exitCode, signal };
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

function displayArgv(argv: readonly string[]): string {
  return argv
    .map((arg) =>
      UNQUOTED_ARG.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`
    )
    .join(" ");
}

function blocker(
  name: string,
  requirement: ProjectPrerequisite,
  consumer: string,
  result: Exclude<CheckState, { state: "ok" }>
): { message: string; code: HackErrorCode } {
  if (result.state === "missing") {
    return {
      code: "E_PREREQUISITE_TOOL_MISSING",
      message: `! ${result.bin}  not found (${result.tool})\n  ${consumer} needs it.${result.hint ? ` run:\n  ${result.hint}` : ""}`,
    };
  }
  if (result.state === "cancelled") {
    return {
      code: "E_CANCELLED",
      message: `! ${name}  sign-in check cancelled by ${result.signal}${result.stopUnconfirmed ? "\n  Could not confirm that the check process group stopped." : ""}`,
    };
  }
  if (result.state === "cleanup pending") {
    return {
      code: "E_PREREQUISITE_CHECK_FAILED",
      message: `! ${name}  could not confirm that the check process group stopped\n  ${consumer} needs it. Retry the command.`,
    };
  }
  const timedOut = result.state === "timeout";
  const signInReason =
    !timedOut && result.signal
      ? `sign-in check ended by ${result.signal}`
      : "sign-in expired";
  const reason = timedOut ? "sign-in check timed out" : signInReason;
  return {
    code: timedOut
      ? "E_PREREQUISITE_CHECK_TIMEOUT"
      : "E_PREREQUISITE_CHECK_FAILED",
    message: `! ${name}  ${reason}${requirement.preset ? ` (${requirement.preset})` : ""}\n  ${consumer} needs it. run:\n  ${displayArgv(requirement.login)}`,
  };
}

async function login(
  requirement: ProjectPrerequisite,
  cwd: string,
  notice: ExecutableNotice
): Promise<string | null> {
  const [bin, ...args] = requirement.login;
  const executable = resolveExecutable(bin);
  if (!executable) {
    return `login executable ${bin} not found`;
  }
  notice(bin, executable);
  const child = Bun.spawn([executable, ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnvironment(),
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const code = await child.exited;
    if (child.signalCode) {
      return `login interrupted (${child.signalCode})`;
    }
    return code === 0 ? null : `login failed (exit ${code})`;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

async function confirmLogin(): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "  run it now? [y/n] ",
  });
  try {
    terminal.prompt();
    for await (const line of terminal) {
      const answer = line.trim().toLowerCase();
      return answer === "y" || answer === "yes";
    }
    return false;
  } finally {
    terminal.close();
  }
}

async function allowPrerequisite(opts: {
  readonly name: string;
  readonly requirement: ProjectPrerequisite;
  readonly tools: ProjectPrerequisiteConfig["tools"];
  readonly consumer: string;
  readonly json: boolean;
  readonly cwd: string;
  readonly notice: ExecutableNotice;
}): Promise<boolean> {
  const { name, requirement, consumer, json, tools, cwd, notice } = opts;
  let result = await checkPrerequisite(requirement, tools, cwd, notice);
  if (result.state === "ok") {
    return true;
  }
  let error = blocker(name, requirement, consumer, result);
  if (json) {
    throw new HackCliError({
      ...error,
      detail:
        result.state === "failed"
          ? {
              exitCode: result.exitCode,
              ...(result.signal ? { signal: result.signal } : {}),
            }
          : undefined,
    });
  }
  process.stderr.write(`${error.message}\n`);
  if (result.state !== "failed" || result.signal || !canPrompt()) {
    return false;
  }
  const confirmed = await confirmLogin();
  if (!confirmed) {
    return false;
  }
  const loginFailure = await login(requirement, cwd, notice);
  if (loginFailure) {
    process.stderr.write(
      `! ${name}  ${loginFailure} (E_PREREQUISITE_CHECK_FAILED). Retry: ${displayArgv(requirement.login)}\n`
    );
    return false;
  }
  result = await checkPrerequisite(requirement, tools, cwd, notice);
  if (result.state === "ok") {
    return true;
  }
  error = blocker(name, requirement, consumer, result);
  process.stderr.write(`${error.message}\n`);
  return false;
}

function dependencyNames(
  service: Record<string, unknown>
): readonly string[] | null {
  // Fall back to every prerequisite for dependency forms outside this scan.
  if (
    [service.links, service.volumes_from, service.extends].some(
      (value) => value !== undefined
    ) ||
    [service.network_mode, service.ipc, service.pid].some(
      (value) => typeof value === "string" && value.startsWith("service:")
    )
  ) {
    return null;
  }
  const dependencies = service.depends_on;
  if (dependencies === undefined) {
    return [];
  }
  if (
    Array.isArray(dependencies) &&
    dependencies.every((name) => typeof name === "string")
  ) {
    return dependencies;
  }
  return isRecord(dependencies) ? Object.keys(dependencies) : null;
}

async function mayInjectManagedEnv(
  projectRoot: string,
  projectDir: string
): Promise<boolean> {
  try {
    const primary = await resolvePrimaryLocalProjectDir({
      projectRoot,
      projectDir,
    });
    const directories = primary === null ? [projectDir] : [projectDir, primary];
    for (const directory of directories) {
      const names = await readdir(directory);
      if (
        names.some(
          (name) =>
            name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
            name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)
        )
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function collectComposeReferences(value: unknown, names: Set<string>): void {
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (const match of next.matchAll(COMPOSE_VARIABLE)) {
        if (match[1]) {
          names.add(match[1]);
        }
      }
    } else if (
      next !== null &&
      typeof next === "object" &&
      !visited.has(next)
    ) {
      visited.add(next);
      for (const entry of Object.values(next)) {
        pending.push(entry);
      }
    }
  }
}

async function selectedEnvironmentNames(
  projectRoot: string,
  composeFile: string,
  services: readonly string[]
): Promise<ReadonlySet<string> | null> {
  if (
    services.length === 0 ||
    (await mayInjectManagedEnv(projectRoot, dirname(composeFile)))
  ) {
    return null;
  }
  let model: unknown;
  try {
    model = YAML.parse(await Bun.file(composeFile).text());
  } catch {
    return null;
  }
  if (
    !(isRecord(model) && isRecord(model.services)) ||
    model.include !== undefined
  ) {
    return null;
  }
  const names = new Set<string>();
  const visited = new Set<string>();
  const pending = [...services];
  for (
    let service = pending.pop();
    service !== undefined;
    service = pending.pop()
  ) {
    if (visited.has(service)) {
      continue;
    }
    visited.add(service);
    const definition = model.services[service];
    if (!isRecord(definition)) {
      return null;
    }
    // Compose resolves these files with its own precedence and interpolation.
    // An inline-only scan cannot establish that a remote is unused.
    if (definition.env_file !== undefined) {
      return null;
    }
    const keys = composeServiceEnvironmentKeys(definition.environment);
    const dependencies = dependencyNames(definition);
    if (!(keys && dependencies)) {
      return null;
    }
    for (const key of keys) {
      names.add(key);
    }
    collectComposeReferences(definition, names);
    pending.push(...dependencies);
  }
  return names;
}

/** Check each prerequisite used by this invocation once before Compose hooks. */
export async function enforceProjectPrerequisites(
  validation: ProjectPrerequisiteValidation | undefined,
  json: boolean,
  cwd: string,
  selection?: {
    readonly composeFile: string;
    readonly services: readonly string[];
  }
): Promise<boolean> {
  if (validation?.error) {
    throw validation.error;
  }
  const config = validation?.config;
  if (!config) {
    return true;
  }
  const names =
    selection && config.selected.length > 0
      ? await selectedEnvironmentNames(
          cwd,
          selection.composeFile,
          selection.services
        )
      : null;
  const passed = new Set<string>();
  let notified = false;
  const notice: ExecutableNotice = (bin, path) => {
    if (!notified && isProjectExecutable(path, cwd)) {
      process.stderr.write(
        `Prerequisite executable ${bin}: ${path} · PATH · in project\n`
      );
      notified = true;
    }
  };
  for (const selection of config.selected) {
    if (
      names &&
      !Object.keys(selection.bindings).some((name) => names.has(name))
    ) {
      continue;
    }
    for (const name of selection.requires) {
      const requirement = config.requires.get(name);
      if (!requirement || passed.has(name)) {
        continue;
      }
      const allowed = await allowPrerequisite({
        name,
        requirement,
        tools: config.tools,
        consumer: `${selection.remote} (${selection.target})`,
        json,
        cwd,
        notice,
      });
      if (!allowed) {
        return false;
      }
      passed.add(name);
    }
  }
  return true;
}

type DoctorPrerequisiteState = CheckState | { readonly state: "not checked" };

async function inspectPrerequisite(
  requirement: ProjectPrerequisite,
  tools: ProjectPrerequisiteConfig["tools"],
  cwd: string
): Promise<DoctorPrerequisiteState> {
  if (requirement.preset) {
    return await checkPrerequisite(requirement, tools, cwd);
  }
  const missing = findMissingTool(requirement, tools);
  if (missing) {
    return missing;
  }
  const [bin] = requirement.check;
  return resolveExecutable(bin)
    ? { state: "not checked" }
    : { state: "missing", bin, tool: bin };
}

export interface PrerequisiteToolPath {
  readonly bin: string;
  readonly path: string | null;
  readonly source: "PATH";
  readonly inProject: boolean;
}

function inspectPrerequisiteTool(
  bin: string,
  cwd: string
): PrerequisiteToolPath {
  const path = resolveExecutable(bin);
  return {
    bin,
    path,
    source: "PATH",
    inProject: path !== null && isProjectExecutable(path, cwd),
  };
}

interface DoctorPrerequisite {
  readonly name: string;
  readonly state: DoctorPrerequisiteState;
  readonly check?: string;
  readonly login: string;
  readonly tools: readonly PrerequisiteToolPath[];
}

/** Doctor can describe custom checks without executing checkout-provided argv. */
export async function inspectProjectPrerequisites(
  config: ProjectPrerequisiteConfig,
  cwd: string
): Promise<readonly DoctorPrerequisite[]> {
  const results: DoctorPrerequisite[] = [];
  for (const [name, requirement] of config.requires) {
    const bins = new Set([requirement.check[0], requirement.login[0]]);
    for (const tool of requirement.tools) {
      for (const bin of config.tools.get(tool)?.bins ?? []) {
        bins.add(bin);
      }
    }
    results.push({
      name,
      state: await inspectPrerequisite(requirement, config.tools, cwd),
      ...(requirement.preset ? {} : { check: displayArgv(requirement.check) }),
      login: displayArgv(requirement.login),
      tools: [...bins].map((bin) => inspectPrerequisiteTool(bin, cwd)),
    });
  }
  return results;
}
