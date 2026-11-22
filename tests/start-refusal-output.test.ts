import { expect, spyOn, test } from "bun:test";
import { handleRunCliError } from "../src/cli/run.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { printedShellCommand } from "../src/lib/printed-shell-command.ts";
import { writeUpHookBlocker } from "../src/ui/start-refusal-output.ts";

const cases = [
  [
    "E_LIFECYCLE_FAILED",
    "! lifecycle  hook failed\n  fix the failing hook and retry this start. run:\n  hack up\n",
  ],
  [
    "E_NATIVE_SETUP_REQUIRED",
    "! native runtime  setup required\n  this start needs the native runtime. run:\n  hack native setup --accept-downloads\n",
  ],
  [
    "E_DOCKER_UNAVAILABLE",
    "! docker  engine unavailable · start docker or select a running engine\n",
  ],
  [
    "E_PROJECT_NOT_FOUND",
    "! project  not found\n  this start needs a configured project. run:\n  hack init --auto\n",
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
)("%s preserves the JSON envelope and prints at most three human lines", async (code, expected) => {
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

test("a persistent hook startup refusal keeps the reason in one blocker", () => {
  const lines: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  try {
    writeUpHookBlocker(
      "before",
      1,
      "worker",
      "hack up",
      "session already exists"
    );
    expect(lines.join("")).toBe(
      "! lifecycle  hook could not start (before, worker, session already exists)\n  resolve the startup refusal and retry this start. run:\n  hack up\n"
    );
  } finally {
    stderr.mockRestore();
  }
});

test.each([
  "a'quote",
  "a\\backslash",
  "$(printf injected)",
  "-leading",
  "x".repeat(300),
  "line\nbreak",
  "trailing\n",
  "a\r\t b",
])("printed recovery values round-trip through POSIX sh: %j", (value) => {
  const command = printedShellCommand(["printf", "%s", value]);
  expect(command).toBe(command.split("\n")[0]);
  const result = Bun.spawnSync(["/bin/sh", "-c", command], { stdout: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(value);
});
