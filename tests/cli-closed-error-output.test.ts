import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import { checkNativeHttpsPort } from "../src/backends/native-https-port.ts";
import { NativeHttpsStartupError } from "../src/backends/native-https-startup-failure.ts";
import { nativeHttpsVerificationError } from "../src/backends/native-project-https.ts";
import { NativePartialShutdownError } from "../src/backends/native-project-interrupted-cleanup.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { CliUsageError } from "../src/cli/command.ts";
import { handleRunCliError } from "../src/cli/run.ts";
import { ClosedCliError, HackCliError } from "../src/lib/cli-result.ts";
import { refuseUnsupportedNativeUpOptions } from "../src/lib/native-up-refusals.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * The top-level handler prints a known error's closed message only; its stack
 * is shown with HACK_DEBUG=1. Unexpected exceptions keep their stack.
 */

const STACK_FRAME = /^\s+at /m;
let output = "";
let restoreWrites: () => void = () => undefined;
const savedDebug = process.env.HACK_DEBUG;

beforeEach(() => {
  output = "";
  Reflect.deleteProperty(process.env, "HACK_DEBUG");
  setLoggerBackendOverride({ backend: "console" });
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    output +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  restoreWrites = () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
});

afterEach(() => {
  restoreWrites();
  setLoggerBackendOverride({ backend: null });
  restoreEnv("HACK_DEBUG", savedDebug);
});

function nativeRefusal(): NativeRuntimeRequestError {
  return new NativeRuntimeRequestError({
    message:
      "Native runtime request failed (graph_journal_incomplete); inspect owned state before retrying.",
    nativeCode: "graph_journal_incomplete",
  });
}

test("a closed native refusal prints its message once and no stack", async () => {
  const error = nativeRefusal();
  expect(error).toBeInstanceOf(ClosedCliError);
  expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
  expect(output).toBe(`ERROR: ${error.message}\n`);
  expect(output).not.toMatch(STACK_FRAME);
});

test("HACK_DEBUG=1 adds the stack to closed and coded errors", async () => {
  process.env.HACK_DEBUG = "1";
  expect(
    await handleRunCliError({ error: nativeRefusal(), jsonRequested: false })
  ).toBe(1);
  expect(output).toMatch(STACK_FRAME);
  output = "";
  const coded = new HackCliError({
    code: "E_LIFECYCLE_FAILED",
    message: "Closed lifecycle refusal.",
  });
  expect(await handleRunCliError({ error: coded, jsonRequested: false })).toBe(
    1
  );
  expect(output).toContain(
    "ERROR: E_LIFECYCLE_FAILED: Closed lifecycle refusal."
  );
  expect(output).toMatch(STACK_FRAME);
});

test("a coded error prints no stack without HACK_DEBUG", async () => {
  const coded = new HackCliError({
    code: "E_LIFECYCLE_FAILED",
    message: "Closed lifecycle refusal.",
  });
  expect(await handleRunCliError({ error: coded, jsonRequested: false })).toBe(
    1
  );
  expect(output).toBe("ERROR: E_LIFECYCLE_FAILED: Closed lifecycle refusal.\n");
});

test("an unexpected exception keeps its stack", async () => {
  const error = new TypeError("unexpected internal failure");
  expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
  expect(output).toContain("unexpected internal failure");
  expect(output).toMatch(STACK_FRAME);
});

test("a coded native refusal also names its closed boundary without --json", async () => {
  const coded = new HackCliError({
    code: "E_COMPOSE_FAILED",
    message: "Native Compose operation failed. Values omitted.",
    detail: {
      native_compose_effect_refusal: {
        stage: "storage-helper-start",
        reason: "probe-timeout",
      },
    },
  });
  expect(await handleRunCliError({ error: coded, jsonRequested: false })).toBe(
    1
  );
  expect(output).toBe(
    "ERROR: E_COMPOSE_FAILED: Native Compose operation failed. Values omitted.\nERROR: Refusal boundary: storage-helper-start (probe-timeout); values omitted.\n"
  );
});

test("unknown or accessor-backed boundary detail prints nothing extra", async () => {
  const canary = "private-boundary-canary";
  for (const detail of [
    {
      native_compose_effect_refusal: { stage: canary, reason: "probe-timeout" },
    },
    {
      native_compose_effect_refusal: {
        stage: "storage-target",
        reason: canary,
      },
    },
    { native_compose_effect_refusal: "storage-target" },
    {
      native_compose_effect_refusal: {
        get stage() {
          return "storage-target";
        },
        reason: "unclassified",
      },
    },
    { other: { stage: "storage-target", reason: "unclassified" } },
    canary,
  ]) {
    output = "";
    const coded = new HackCliError({
      code: "E_COMPOSE_FAILED",
      message: "Closed refusal.",
      detail,
    });
    expect(
      await handleRunCliError({ error: coded, jsonRequested: false })
    ).toBe(1);
    expect(output).toBe("ERROR: E_COMPOSE_FAILED: Closed refusal.\n");
  }
});

test("--json keeps one envelope for a closed refusal", async () => {
  const error = nativeRefusal();
  expect(await handleRunCliError({ error, jsonRequested: true })).toBe(1);
  expect(JSON.parse(output)).toEqual({
    ok: false,
    error: { code: "E_UNEXPECTED", message: error.message },
  });
});

test("a handler's usage refusal prints its message and one hint line, not the help", async () => {
  const error = new CliUsageError(
    "Native run uses the started project's environment and profiles; restart with the requested selections first."
  );
  expect(
    await handleRunCliError({
      error,
      jsonRequested: false,
      handlerPath: ["run"],
    })
  ).toBe(1);
  expect(output).toBe(
    `ERROR: ${error.message}\nSee \`hack run --help\` for usage.\n`
  );
});

test("a usage error found while parsing still prints the help", async () => {
  const error = new CliUsageError("Unknown option(s): --bogus");
  expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
  expect(output).toStartWith(`ERROR: ${error.message}\n`);
  expect(output).toContain("hack <command> [options]");
});

test("a handler's usage refusal under --json stays one E_USAGE envelope", async () => {
  const error = new CliUsageError("Native exec does not support --env.");
  expect(
    await handleRunCliError({
      error,
      jsonRequested: true,
      handlerPath: ["exec"],
    })
  ).toBe(1);
  expect(JSON.parse(output)).toEqual({
    ok: false,
    error: { code: "E_USAGE", message: error.message },
  });
});

function thrownBy(action: () => void): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

test.each([
  {
    refusal: () =>
      refuseUnsupportedNativeUpOptions({ restart: false, detach: true }),
    text: "E_USAGE: Native `hack up` runs in the foreground only, so --detach is not supported. Run `hack up` without --detach in its own terminal and keep it open;",
  },
  {
    refusal: () =>
      refuseUnsupportedNativeUpOptions({ restart: true, json: true }),
    text: "E_USAGE: Native `hack restart` does not support --json",
  },
  {
    refusal: () =>
      refuseUnsupportedNativeUpOptions({ restart: false, target: "remote" }),
    text: "E_USAGE: Native `hack up` does not support --target;",
  },
  {
    refusal: () =>
      refuseUnsupportedNativeUpOptions({ restart: false, services: ["web"] }),
    text: "E_USAGE: Native `hack up` starts the whole project; service selection is not supported.",
  },
])("native up option refusal prints one closed line: $text", async ({
  refusal,
  text,
}) => {
  const error = thrownBy(refusal);
  expect(error).toBeInstanceOf(HackCliError);
  expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
  expect(output).toStartWith(`ERROR: ${text}`);
  expect(output.trimEnd().split("\n")).toHaveLength(1);
  expect(output).not.toMatch(STACK_FRAME);
});

test("supported native up options are not refused", () => {
  expect(
    thrownBy(() =>
      refuseUnsupportedNativeUpOptions({
        restart: false,
        detach: false,
        json: false,
        services: [],
      })
    )
  ).toBeUndefined();
});

test.each([
  () => new NativePartialShutdownError(),
  () => new NativeHttpsStartupError("frontend-start"),
])("native refusal class %# prints its closed message without a stack", async (make) => {
  const error = make();
  expect(error).toBeInstanceOf(ClosedCliError);
  expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
  expect(output).toBe(`ERROR: ${error.message}\n`);
});

/**
 * HTTPS verification and port refusals are raised inside the foreground
 * owner's readiness step, which a CLI spawn reaches only with a live serve
 * owner. Their real errors still render as one closed line here.
 */
test("a native HTTPS verification failure prints one closed line", async () => {
  const error = nativeHttpsVerificationError({ code: "ECONNREFUSED" });
  expect(error).toBeInstanceOf(ClosedCliError);
  expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
  expect(output).toBe(
    "ERROR: Native HTTPS verification failed (ECONNREFUSED); peer values omitted.\n"
  );
});

test("an occupied native HTTPS port prints one coded line without the port", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture has no TCP address");
    }
    const error = await checkNativeHttpsPort(address.port).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(HackCliError);
    expect(await handleRunCliError({ error, jsonRequested: false })).toBe(1);
    expect(output).toBe(
      "ERROR: E_CONFIG_INVALID: The selected native HTTPS port is already in use; the existing listener was left untouched. Select a free port.\n"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
