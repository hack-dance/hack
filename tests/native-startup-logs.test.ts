import { expect, test } from "bun:test";
import {
  formatNativeStartupLogReport,
  NATIVE_STARTUP_LOG_STREAM_BYTES,
  readNativeStartupLogs,
  redactNativeStartupLog,
} from "../src/backends/native-startup-logs.ts";

const tail = (overrides: Record<string, unknown> = {}) => ({
  service: "web",
  stdout: "",
  stderr: "",
  truncated: false,
  ...overrides,
});

test("only the versioned bounded reply contract is accepted, whole or not at all", () => {
  expect(
    readNativeStartupLogs({ version: 1, services: [tail({ stdout: "ok" })] })
  ).toEqual([tail({ stdout: "ok" })]);
  for (const value of [
    undefined,
    { version: 2, services: [tail()] },
    { version: 1, services: [] },
    { version: 1, services: [tail(), tail()] },
    {
      version: 1,
      services: ["a", "b", "c", "d"].map((service) => tail({ service })),
    },
    { version: 1, services: [tail({ service: "../web" })] },
    { version: 1, services: [tail({ extra: true })] },
    { version: 1, services: [tail({ truncated: "no" })] },
    {
      version: 1,
      services: [
        tail({ stderr: "x".repeat(NATIVE_STARTUP_LOG_STREAM_BYTES + 1) }),
      ],
    },
    { version: 1, services: [tail()], extra: 1 },
  ]) {
    expect(readNativeStartupLogs(value)).toBeUndefined();
  }
});

test("every managed value is redacted, including substrings, escaped forms and lines", () => {
  const key = "-----BEGIN KEY-----\nc3ludGhldGlj\n-----END KEY-----";
  const values = ["synthetic-secret", "s3cr3t-token", key];
  const text = [
    "token=synthetic-secret",
    "prefix-synthetic-secretsuffix",
    'json {"value":"-----BEGIN KEY-----\\nc3ludGhldGlj\\n-----END KEY-----"}',
    "partial c3ludGhldGlj",
    "styled \u001b[31ms3cr3t\u001b[0m-token",
  ].join("\n");
  const redacted = redactNativeStartupLog(text, values);
  for (const value of ["synthetic-secret", "c3ludGhldGlj", "s3cr3t"]) {
    expect(redacted).not.toContain(value);
  }
  expect(redacted).toContain("token=[REDACTED]");
  expect(redacted).toContain("prefix-[REDACTED]suffix");
  expect(redacted).toContain("partial [REDACTED]");
  expect(redacted).not.toContain("\u001b");
});

test("values shorter than four characters are redacted only as whole tokens", () => {
  const redacted = redactNativeStartupLog(
    "FLAG=on at 1 of 10 retries; connection 1a2 ok; mode on.",
    ["on", "1"]
  );
  expect(redacted).toBe(
    "FLAG=[REDACTED] at [REDACTED] of 10 retries; connection 1a2 ok; mode [REDACTED]."
  );
  // Short lines of a multi-line value are never matched on their own.
  expect(redactNativeStartupLog("done {a:1}", ["{\na:1\n}"])).toBe(
    "done {a:1}"
  );
});

test("remaining control characters cannot reach the terminal", () => {
  expect(redactNativeStartupLog("bell\u0007 tab\tback\b", [])).toBe(
    "bell� tab\tback�"
  );
});

test("the report redacts values of every service and names omitted lines", () => {
  const report = formatNativeStartupLogReport({
    logs: [
      tail({
        stdout: "starting",
        stderr: "error: invalid token synthetic-secret",
        truncated: true,
      }),
      tail({ service: "worker" }),
    ],
    managedEnvironment: {
      api: { TOKEN: "synthetic-secret" },
      web: { MODE: "" },
    },
  });
  expect(report).toBe(
    [
      "Last output of failed services (at most 64 lines each; managed values redacted; not saved):",
      "--- web stdout ---",
      "starting",
      "--- web stderr ---",
      "error: invalid token [REDACTED]",
      "(lines over the size bound were omitted)",
      "--- worker ---",
      "(no output)",
    ].join("\n")
  );
  expect(
    formatNativeStartupLogReport({ logs: [], managedEnvironment: {} })
  ).toBe("");
});
