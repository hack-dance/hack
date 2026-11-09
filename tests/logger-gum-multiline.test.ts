import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  type GumRunRequest,
  resetGumPathCacheForTests,
  setGumRunnerForTests,
} from "../src/ui/gum.ts";
import { logger, setLoggerBackendOverride } from "../src/ui/logger.ts";

// Never spawned: every invocation goes through the recording runner below.
const FAKE_GUM = "/nonexistent/hack-test/gum";

let calls: GumRunRequest[] = [];
let gumExitCode = 0;
let previousGumPath: string | undefined;

beforeEach(() => {
  calls = [];
  gumExitCode = 0;
  previousGumPath = process.env.HACK_GUM_PATH;
  process.env.HACK_GUM_PATH = FAKE_GUM;
  resetGumPathCacheForTests();
  setLoggerBackendOverride({ backend: "gum" });
  setGumRunnerForTests({
    runner: {
      runSync(request) {
        calls.push(request);
        return gumExitCode;
      },
      run(request) {
        calls.push(request);
        return Promise.resolve({ exitCode: gumExitCode, stdout: "" });
      },
    },
  });
});

afterEach(() => {
  setGumRunnerForTests({ runner: null });
  setLoggerBackendOverride({ backend: null });
  if (previousGumPath === undefined) {
    Reflect.deleteProperty(process.env, "HACK_GUM_PATH");
  } else {
    process.env.HACK_GUM_PATH = previousGumPath;
  }
  resetGumPathCacheForTests();
});

function captureStderr<T>(body: () => T): { result: T; text: string } {
  const writes: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      );
      return true;
    }
  );
  try {
    return { result: body(), text: writes.join("") };
  } finally {
    spy.mockRestore();
  }
}

test("gum logs a single-line message unchanged and writes nothing else", () => {
  const { text } = captureStderr(() =>
    logger.info({ message: "Native DNS available for *.example.test" })
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.cmd.at(-1)).toBe("Native DNS available for *.example.test");
  expect(text).toBe("");
});

test("gum keeps every line break of a multi-line message", () => {
  const { text } = captureStderr(() =>
    logger.info({
      message: [
        "Native DNS available for *.example.test",
        "dnsmasq: /prefix/etc/dnsmasq.d/hack-native-example.test.conf",
        "",
        "resolver: /etc/resolver/example.test",
      ].join("\n"),
    })
  );
  // gum joins embedded newlines into one line, so only the first line goes
  // through it; the rest keeps its own lines on gum's stream (stderr).
  expect(calls).toHaveLength(1);
  const cmd = calls[0]?.cmd ?? [];
  expect(cmd.at(-1)).toBe("Native DNS available for *.example.test");
  expect(cmd.some((arg) => arg.includes("\n"))).toBe(false);
  expect(text).toBe(
    [
      "     dnsmasq: /prefix/etc/dnsmasq.d/hack-native-example.test.conf",
      "",
      "     resolver: /etc/resolver/example.test",
      "",
    ].join("\n")
  );
});

test("gum splits CRLF messages too", () => {
  const { text } = captureStderr(() =>
    logger.warn({ message: "first\r\nsecond" })
  );
  expect(calls[0]?.cmd.at(-1)).toBe("first");
  expect(text).toBe("     second\n");
});

test("a failed gum call falls back to clack with the whole message", () => {
  gumExitCode = 1;
  const writes: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      );
      return true;
    }
  );
  let stderr = "";
  try {
    stderr = captureStderr(() =>
      logger.info({ message: "first line\nsecond line" })
    ).text;
  } finally {
    spy.mockRestore();
  }
  expect(stderr).toBe("");
  const stdout = writes.join("");
  expect(stdout).toContain("first line");
  expect(stdout).toContain("second line");
  expect(stdout.indexOf("second line")).toBeGreaterThan(
    stdout.indexOf("first line")
  );
});
