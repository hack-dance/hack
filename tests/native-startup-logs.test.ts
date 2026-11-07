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

// Synthetic dummy credential material only; nothing here is a real key or token.
// Built at runtime so the synthetic PEM framing is not a key-shaped literal.
const PEM_BEGIN = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const PEM_END = ["-----END", "PRIVATE", "KEY-----"].join(" ");
const syntheticAdc = {
  type: "service_account",
  client_id: "000000000000000000000",
  client_secret: "synthetic-client-secret-value",
  refresh_token: "1//synthetic-refresh-token-value",
  private_key_id: "0123456789abcdef0123456789abcdef01234567",
  private_key: `${PEM_BEGIN}\nU1lOVEhFVElDLURVTU1ZLUtFWS1MSU5FLU9ORQ==\nU1lOVEhFVElDLURVTU1ZLUtFWS1MSU5FLVRXTw==\n${PEM_END}\n`,
};
const adcFile = (content: Buffer) => ({
  name: "gcloud-adc.json",
  target: "/config/adc.json",
  content,
});

test("credential file values are redacted from every service's output", () => {
  const echoed = [
    `refresh=${syntheticAdc.refresh_token}`,
    `secret "${syntheticAdc.client_secret}"`,
    `key id ${syntheticAdc.private_key_id}`,
    syntheticAdc.private_key.trimEnd(),
    `quoted ${JSON.stringify(syntheticAdc.private_key)}`,
  ].join("\n");
  const report = formatNativeStartupLogReport({
    logs: [
      tail({ stderr: echoed }),
      tail({ service: "worker", stdout: echoed }),
    ],
    managedEnvironment: {},
    managedFiles: {
      web: [adcFile(Buffer.from(JSON.stringify(syntheticAdc, null, 2)))],
    },
  });
  for (const secret of [
    syntheticAdc.refresh_token,
    syntheticAdc.client_secret,
    syntheticAdc.private_key_id,
    "U1lOVEhFVElDLURVTU1ZLUtFWS1MSU5FLU9ORQ==",
    "U1lOVEhFVElDLURVTU1ZLUtFWS1MSU5FLVRXTw==",
    "synthetic",
  ]) {
    expect(report).not.toContain(secret);
  }
  expect(report).toContain("refresh=[REDACTED]");
  expect(report).toContain("--- worker stdout ---");
});

test("a credential file that cannot be redacted withholds its service's output", () => {
  for (const content of [
    Buffer.from([0xff, 0xfe, 0x00, 0x73, 0x79, 0x6e]),
    Buffer.from('{"refresh_token": "synthetic-unclosed'),
  ]) {
    const report = formatNativeStartupLogReport({
      logs: [
        tail({ stderr: "synthetic-unparsed-secret-output" }),
        tail({ service: "worker", stdout: "worker ok" }),
      ],
      managedEnvironment: {},
      managedFiles: { web: [adcFile(content)] },
    });
    expect(report).not.toContain("synthetic-unparsed-secret-output");
    expect(report).toContain(
      "--- web ---\n(output withheld: this service received credential files that could not be redacted; run hack logs web to read it)"
    );
    // Only the service holding the file is withheld.
    expect(report).toContain("--- worker stdout ---\nworker ok");
  }
});
