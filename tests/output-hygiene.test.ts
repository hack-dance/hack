import { afterEach, beforeEach, expect, test } from "bun:test";

import { buildGumRenderEnv } from "../src/ui/gum.ts";
import { logger, setLoggerBackendOverride } from "../src/ui/logger.ts";
import { isColorDisabledByEnv, isColorEnabled } from "../src/ui/terminal.ts";

const ANSI_ESCAPE = "[";

let originalNoColor: string | undefined;
let originalHackNoColor: string | undefined;
let originalForceColor: string | undefined;

beforeEach(() => {
  originalNoColor = process.env.NO_COLOR;
  originalHackNoColor = process.env.HACK_NO_COLOR;
  originalForceColor = process.env.FORCE_COLOR;
  Reflect.deleteProperty(process.env, "NO_COLOR");
  Reflect.deleteProperty(process.env, "HACK_NO_COLOR");
  Reflect.deleteProperty(process.env, "FORCE_COLOR");
});

afterEach(() => {
  setLoggerBackendOverride({ backend: null });
  restoreEnv("NO_COLOR", originalNoColor);
  restoreEnv("HACK_NO_COLOR", originalHackNoColor);
  restoreEnv("FORCE_COLOR", originalForceColor);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

test("isColorDisabledByEnv honors NO_COLOR (any non-empty value)", () => {
  expect(isColorDisabledByEnv()).toBe(false);
  process.env.NO_COLOR = "1";
  expect(isColorDisabledByEnv()).toBe(true);
  process.env.NO_COLOR = "yes-anything";
  expect(isColorDisabledByEnv()).toBe(true);
});

test("isColorDisabledByEnv honors HACK_NO_COLOR truthy values", () => {
  process.env.HACK_NO_COLOR = "true";
  expect(isColorDisabledByEnv()).toBe(true);
});

test("isColorEnabled is false when NO_COLOR is set even on a TTY", () => {
  process.env.NO_COLOR = "1";
  expect(isColorEnabled()).toBe(false);
});

test("buildGumRenderEnv forces plain output for non-TTY or NO_COLOR runs", () => {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "3";
  const env = buildGumRenderEnv();
  expect(env.NO_COLOR).toBe("1");
  expect("FORCE_COLOR" in env).toBe(false);
  expect("CLICOLOR_FORCE" in env).toBe(false);
});

test("console logger backend writes plain lines to stderr (no ANSI)", () => {
  setLoggerBackendOverride({ backend: "console" });

  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    logger.info({ message: "hello automation" });
    logger.error({ message: "something failed", fields: { code: 7 } });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  expect(stdout).toBe("");
  expect(stderr).toContain("INFO: hello automation");
  expect(stderr).toContain("ERROR: something failed (code=7)");
  expect(stderr).not.toContain(ANSI_ESCAPE);
});

test("piped root help output carries no ANSI escapes", async () => {
  let stdout = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const exitCode = await runCli(["--help"]);
    expect(exitCode).toBe(0);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  expect(stdout.length).toBeGreaterThan(0);
  expect(stdout).not.toContain(ANSI_ESCAPE);
});
