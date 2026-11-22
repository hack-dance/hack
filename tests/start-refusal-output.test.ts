import { expect, spyOn, test } from "bun:test";
import { handleRunCliError } from "../src/cli/run.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

const cases = [
  [
    "E_LIFECYCLE_FAILED",
    "! lifecycle  hook failed\n  fix the failing hook and retry this start. run:\n  hack up\n",
  ],
  [
    "E_NATIVE_SETUP_REQUIRED",
    "! native runtime  setup required\n  this start needs the native runtime. run:\n  hack native setup\n",
  ],
  [
    "E_DOCKER_UNAVAILABLE",
    "! docker  engine or compose unavailable\n  this start needs a working docker installation. run:\n  docker compose version && docker info\n",
  ],
  [
    "E_PROJECT_NOT_FOUND",
    "! project  not found\n  this start needs a configured project. run:\n  hack init\n",
  ],
  [
    "E_INTERACTIVE_REQUIRED",
    "! terminal  interaction required\n  this start needs confirmation from an interactive terminal. run:\n  hack up\n",
  ],
  [
    "E_STARTUP_INCOMPLETE",
    "! project  already running with a different selection\n  this start needs the running instance stopped first. run:\n  hack down --branch demo\n",
  ],
] as const;

test.each(
  cases
)("%s preserves the JSON envelope and prints three human lines", async (code, expected) => {
  const error = new HackCliError({
    code,
    message: "Original message.",
    detail: { sample: true },
    startBlocker:
      code === "E_STARTUP_INCOMPLETE"
        ? {
            thing: "project",
            problem: "already running with a different selection",
            needs: "this start needs the running instance stopped first",
            command: "hack down --branch demo",
          }
        : undefined,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = spyOn(process.stdout, "write").mockImplementation(
    (line) => stdout.push(String(line)) > 0
  );
  const err = spyOn(process.stderr, "write").mockImplementation(
    (line) => stderr.push(String(line)) > 0
  );
  try {
    expect(
      await handleRunCliError({
        error,
        jsonRequested: false,
        handlerPath: ["up"],
      })
    ).toBe(1);
    expect(stderr.join("")).toBe(expected);
    expect(stdout).toEqual([]);
    stderr.length = 0;
    expect(
      await handleRunCliError({
        error,
        jsonRequested: true,
        handlerPath: ["up"],
      })
    ).toBe(1);
    expect(stdout.join("")).toBe(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code,
            message: "Original message.",
            detail: { sample: true },
          },
        },
        null,
        2
      )}\n`
    );
    expect(stderr).toEqual([]);
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
});
