import type { HackErrorCode } from "../lib/cli-result.ts";
import { isColorDisabledByEnv } from "./terminal.ts";
import { createTextOutput } from "./text-output.ts";

export type StartBlocker = Omit<
  Parameters<ReturnType<typeof createTextOutput>["blocker"]>[0],
  "prompt"
>;

const setupBlocker: StartBlocker = {
  thing: "native runtime",
  problem: "setup required",
  needs: "this start needs the native runtime",
  command: "hack native setup",
};

const blockers: Partial<Record<HackErrorCode, StartBlocker>> = {
  E_NATIVE_SETUP_REQUIRED: setupBlocker,
  E_PROJECT_NOT_FOUND: {
    thing: "project",
    problem: "not found",
    needs: "this start needs a configured project",
    command: "hack init",
  },
  E_DOCKER_UNAVAILABLE: {
    thing: "docker",
    problem: "engine or compose unavailable",
    needs: "this start needs a working docker installation",
    command: "docker compose version && docker info",
  },
  E_INTERACTIVE_REQUIRED: {
    thing: "terminal",
    problem: "interaction required",
    needs: "this start needs confirmation from an interactive terminal",
    command: "hack up",
  },
  E_LIFECYCLE_FAILED: {
    thing: "lifecycle",
    problem: "hook failed",
    needs: "fix the failing hook and retry this start",
    command: "hack up",
  },
};

export function writeStartBlocker(input: StartBlocker): void {
  createTextOutput({
    color: !isColorDisabledByEnv(),
    tty: process.stderr.isTTY === true,
    write: (line) => process.stderr.write(line),
  }).blocker(input);
}

export function startRefusalBlocker(
  code: HackErrorCode
): StartBlocker | undefined {
  return blockers[code];
}

export function writeUpHookBlocker(
  phase: "before" | "after",
  exitCode?: number
): void {
  writeStartBlocker({
    thing: "lifecycle",
    problem: "hook failed",
    which: exitCode === undefined ? phase : `${phase}, exit ${exitCode}`,
    needs: "fix the failing hook and retry this start",
    command: "hack up",
  });
}
