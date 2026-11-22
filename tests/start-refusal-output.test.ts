import { expect, spyOn, test } from "bun:test";
import { handleRunCliError } from "../src/cli/run.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  canPrintStartSelection,
  printedShellCommand,
} from "../src/lib/printed-shell-command.ts";
import { writeUpHookBlocker } from "../src/ui/start-refusal-output.ts";

import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

const cases = [
  [
    "E_LIFECYCLE_FAILED",
    "Fixture before hook input was unavailable.",
    "! lifecycle  E_LIFECYCLE_FAILED: Fixture before hook input was unavailable.\n  fix the failing hook and retry this start. run:\n  hack up\n",
  ],
  [
    "E_NATIVE_SETUP_REQUIRED",
    "Fixture installation needs a specific component.",
    "! native runtime  E_NATIVE_SETUP_REQUIRED: Fixture installation needs a specific component.\n  this start needs the native runtime. run:\n  hack native setup --accept-downloads\n",
  ],
  [
    "E_DOCKER_UNAVAILABLE",
    "Fixture engine socket could not be opened.",
    "! docker  E_DOCKER_UNAVAILABLE: Fixture engine socket could not be opened.\n",
  ],
  [
    "E_PROJECT_NOT_FOUND",
    "Fixture checkout has no project configuration.",
    "! project  E_PROJECT_NOT_FOUND: Fixture checkout has no project configuration.\n  this start needs a configured project. run:\n  hack init --auto\n",
  ],
  [
    "E_INTERACTIVE_REQUIRED",
    "Fixture confirmation requires --yes.",
    "! terminal  E_INTERACTIVE_REQUIRED: Fixture confirmation requires --yes.\n  this start needs confirmation from an interactive terminal. run:\n  hack up\n",
  ],
  [
    "E_STARTUP_INCOMPLETE",
    "Original message.",
    "! project  already running with a different selection\n  this start needs the running instance stopped first. run:\n  hack down --branch demo\n",
  ],
] as const;

test.each(
  cases
)("%s preserves the JSON envelope and prints at most three human lines", async (code, message, expected) => {
  const error = new HackCliError({
    code,
    message,
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
            message,
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
  expect(command).not.toContain("\n");
  const result = spawnSyncBounded(["/bin/sh", "-c", command], {
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(value);
});

test("retry text excludes pasted assignments and noncanonical project aliases", () => {
  expect(canPrintStartSelection({ project: "Demo_Private" })).toBe(false);
  expect(
    canPrintStartSelection({ project: "demo", branch: "TOKEN=value" })
  ).toBe(false);
  expect(canPrintStartSelection({ path: "TOKEN=value" })).toBe(false);
  expect(canPrintStartSelection({ services: ["TOKEN=value"] })).toBe(false);
  expect(
    canPrintStartSelection({
      project: "demo",
      branch: "feature/example",
      services: ["web"],
      path: "-fixture\n",
    })
  ).toBe(true);
});

test("generic start blockers retain multiline messages and the original detail summary", () => {
  const run = new URL("../src/cli/run.ts", import.meta.url);
  const errors = new URL("../src/lib/cli-result.ts", import.meta.url);
  const program = `
    import { handleRunCliError } from ${JSON.stringify(run.href)};
    import { HackCliError } from ${JSON.stringify(errors.href)};
    process.exitCode = await handleRunCliError({
      error: new HackCliError({
        code: "E_DOCKER_UNAVAILABLE",
        message: "Engine connection failed.\\nSecond line of the diagnostic.",
        detail: {
          native_compose_effect_refusal: {
            stage: "effect-entry",
            reason: "private-state",
          },
        },
      }),
      jsonRequested: false,
      handlerPath: ["up"],
    });
  `;
  const result = spawnSyncBounded([process.execPath, "--eval", program], {
    env: {
      ...process.env,
      HACK_LOGGER: "console",
      HACK_DEBUG: "0",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(
    [
      "! docker  E_DOCKER_UNAVAILABLE: Engine connection failed.",
      "ERROR: Second line of the diagnostic.",
      "ERROR: Refusal boundary: effect-entry (private-state); values omitted.",
      "",
    ].join("\n")
  );
});
