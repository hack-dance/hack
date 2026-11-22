import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { YAML } from "bun";
import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { canPrompt } from "./interactivity.ts";
import { composeServiceEnvironmentKeys } from "./project-env-config.ts";
import type {
  ProjectPrerequisite,
  ProjectPrerequisiteConfig,
  ProjectPrerequisiteValidation,
} from "./project-remotes-config.ts";
import { findExecutableInPath } from "./shell.ts";

const UNQUOTED_ARG = /^[a-zA-Z0-9_.:/@%+=,-]+$/;
const TOOL_KEY_PUNCTUATION = /[^A-Z0-9]/g;
const CHECK_TIMEOUT_MS = 10_000;

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
  | { readonly state: "timeout" };

function resolveExecutable(bin: string): string | null {
  const key = bin.toUpperCase().replace(TOOL_KEY_PUNCTUATION, "_");
  const override = process.env[`HACK_TOOL_${key}_PATH`];
  if (override && isAbsolute(override)) {
    const executable = findExecutableInPath(override);
    if (executable) {
      return executable;
    }
  }
  const path = findExecutableInPath(bin);
  return path && isAbsolute(path) ? path : null;
}

function findMissingTool(
  requirement: ProjectPrerequisite,
  tools: ProjectPrerequisiteConfig["tools"]
): CheckState | undefined {
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
  cwd: string
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
  const child = Bun.spawn([executable, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    env: { ...process.env, AWS_CLI_AUTO_PROMPT: "off" },
  });
  let timedOut = false;
  const endGroup = (): void => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group can already have exited.
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    endGroup();
  }, CHECK_TIMEOUT_MS);
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) {
    process.once(signal, endGroup);
  }
  try {
    const exitCode = await child.exited;
    if (timedOut) {
      return { state: "timeout" };
    }
    const signal = child.signalCode ?? undefined;
    if (signal) {
      endGroup();
    }
    return exitCode === 0 && !signal
      ? { state: "ok" }
      : { state: "failed", exitCode, signal };
  } finally {
    clearTimeout(deadline);
    for (const signal of signals) {
      process.removeListener(signal, endGroup);
    }
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
  cwd: string
): Promise<string | null> {
  const [bin, ...args] = requirement.login;
  const executable = resolveExecutable(bin);
  if (!executable) {
    return `login executable ${bin} not found`;
  }
  const child = Bun.spawn([executable, ...args], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
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
}): Promise<boolean> {
  const { name, requirement, consumer, json, tools, cwd } = opts;
  let result = await checkPrerequisite(requirement, tools, cwd);
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
  const loginFailure = await login(requirement, cwd);
  if (loginFailure) {
    process.stderr.write(
      `! ${name}  ${loginFailure} (E_PREREQUISITE_CHECK_FAILED). Retry: ${displayArgv(requirement.login)}\n`
    );
    return false;
  }
  result = await checkPrerequisite(requirement, tools, cwd);
  if (result.state === "ok") {
    return true;
  }
  error = blocker(name, requirement, consumer, result);
  process.stderr.write(`${error.message}\n`);
  return false;
}

async function selectedEnvironmentNames(
  composeFile: string,
  services: readonly string[]
): Promise<ReadonlySet<string> | null> {
  if (services.length === 0) {
    return null;
  }
  let model: unknown;
  try {
    model = YAML.parse(await Bun.file(composeFile).text());
  } catch {
    return null;
  }
  if (!(isRecord(model) && isRecord(model.services))) {
    return null;
  }
  const names = new Set<string>();
  for (const service of services) {
    const definition = model.services[service];
    if (
      !isRecord(definition) ||
      definition.extends !== undefined ||
      model.include !== undefined
    ) {
      return null;
    }
    const keys = composeServiceEnvironmentKeys(definition.environment);
    if (!keys) {
      return null;
    }
    for (const key of keys) {
      names.add(key);
    }
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
          selection.composeFile,
          selection.services
        )
      : null;
  const passed = new Set<string>();
  for (const selection of config.selected) {
    if (names && !selection.envNames.some((name) => names.has(name))) {
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
      });
      if (!allowed) {
        return false;
      }
      passed.add(name);
    }
  }
  return true;
}

export async function inspectProjectPrerequisites(
  config: ProjectPrerequisiteConfig,
  cwd: string
): Promise<readonly { name: string; state: CheckState; login: string }[]> {
  const results: { name: string; state: CheckState; login: string }[] = [];
  for (const [name, requirement] of config.requires) {
    results.push({
      name,
      state: await checkPrerequisite(requirement, config.tools, cwd),
      login: displayArgv(requirement.login),
    });
  }
  return results;
}
