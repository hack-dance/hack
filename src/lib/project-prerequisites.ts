import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { canPrompt } from "./interactivity.ts";
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
  | { readonly state: "failed"; readonly exitCode: number }
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
    timeout: CHECK_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, AWS_CLI_AUTO_PROMPT: "off" },
  });
  const exitCode = await child.exited;
  if (child.signalCode === "SIGKILL") {
    return { state: "timeout" };
  }
  return exitCode === 0 ? { state: "ok" } : { state: "failed", exitCode };
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
      message: `! ${result.bin}  not found (${result.tool})\n  ${consumer} needs it. run:${result.hint ? `\n  ${result.hint}` : ""}`,
    };
  }
  const timedOut = result.state === "timeout";
  const reason = timedOut ? "sign-in check timed out" : "sign-in expired";
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
): Promise<boolean> {
  const [bin, ...args] = requirement.login;
  const executable = resolveExecutable(bin);
  if (!executable) {
    return false;
  }
  return (
    (await Bun.spawn([executable, ...args], {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited) === 0
  );
}

async function confirmLogin(): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "run it now? [y/n] ",
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
        result.state === "failed" ? { exitCode: result.exitCode } : undefined,
    });
  }
  process.stderr.write(`${error.message}\n`);
  if (result.state !== "failed" || !canPrompt()) {
    return false;
  }
  const confirmed = await confirmLogin();
  if (!(confirmed && (await login(requirement, cwd)))) {
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

/** Check each prerequisite used by this invocation once before Compose hooks. */
export async function enforceProjectPrerequisites(
  validation: ProjectPrerequisiteValidation | undefined,
  json: boolean,
  cwd: string
): Promise<boolean> {
  if (validation?.error) {
    throw validation.error;
  }
  const config = validation?.config;
  if (!config) {
    return true;
  }
  const passed = new Set<string>();
  for (const selection of config.selected) {
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
