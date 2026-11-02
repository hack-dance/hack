import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  GUM_END_OF_OPTIONS,
  type GumRunRequest,
  gumChooseMany,
  gumConfirm,
  gumFile,
  gumFilterMany,
  gumFormat,
  gumInput,
  gumJoin,
  gumPager,
  gumSpin,
  gumStyle,
  gumTable,
  gumVersionCheck,
  gumWrite,
  resetGumPathCacheForTests,
  setGumRunnerForTests,
  tryGumLog,
} from "../src/ui/gum.ts";
import { logger, setLoggerBackendOverride } from "../src/ui/logger.ts";

// Never spawned: every invocation goes through the recording runner below.
const FAKE_GUM = "/nonexistent/hack-test/gum";
const DASH_TEXT = "--value-stdin requires --env";
const SHORT_DASH_TEXT = "-n is not a number";

let calls: GumRunRequest[] = [];
let previousGumPath: string | undefined;

beforeEach(() => {
  calls = [];
  previousGumPath = process.env.HACK_GUM_PATH;
  process.env.HACK_GUM_PATH = FAKE_GUM;
  resetGumPathCacheForTests();
  setGumRunnerForTests({
    runner: {
      runSync(request) {
        calls.push(request);
        return 0;
      },
      run(request) {
        calls.push(request);
        return Promise.resolve({ exitCode: 0, stdout: "picked\n" });
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

function onlyCall(): readonly string[] {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) {
    throw new Error("expected one gum invocation");
  }
  return call.cmd;
}

/**
 * Asserts every listed text is a positional after the end-of-options marker
 * and that nothing before the marker is free text (only `--flag[=value]`).
 */
function expectTextAfterMarker({
  cmd,
  subcommand,
  text,
}: {
  readonly cmd: readonly string[];
  readonly subcommand: string;
  readonly text: readonly string[];
}): void {
  expect(cmd.slice(0, 2)).toEqual([FAKE_GUM, subcommand]);
  const marker = cmd.indexOf(GUM_END_OF_OPTIONS);
  expect(marker).toBeGreaterThan(1);
  expect(cmd.slice(marker + 1)).toEqual([...text]);
  for (const arg of cmd.slice(2, marker)) {
    expect(arg.startsWith("--")).toBe(true);
  }
}

test("tryGumLog puts a dash-leading message and fields after the marker", () => {
  expect(
    tryGumLog({
      level: "warn",
      message: DASH_TEXT,
      fields: { flag: "--force", b: SHORT_DASH_TEXT },
    })
  ).toBe(true);

  const cmd = onlyCall();
  expect(cmd).toEqual([
    FAKE_GUM,
    "log",
    "--level=warn",
    "--structured",
    GUM_END_OF_OPTIONS,
    DASH_TEXT,
    "b",
    SHORT_DASH_TEXT,
    "flag",
    "--force",
  ]);
  expect(calls[0]?.stdin).toBe("ignore");
});

test("tryGumLog without fields still ends options before the message", () => {
  tryGumLog({ level: "info", message: DASH_TEXT });
  expect(onlyCall()).toEqual([
    FAKE_GUM,
    "log",
    "--level=info",
    GUM_END_OF_OPTIONS,
    DASH_TEXT,
  ]);
});

test("logger selected as gum passes a dash-leading message after the marker", () => {
  setLoggerBackendOverride({ backend: "gum" });
  logger.error({ message: DASH_TEXT });
  logger.success({ message: SHORT_DASH_TEXT });

  expect(calls).toHaveLength(2);
  expect(calls[0]?.cmd).toEqual([
    FAKE_GUM,
    "log",
    "--level=error",
    GUM_END_OF_OPTIONS,
    DASH_TEXT,
  ]);
  expect(calls[1]?.cmd).toEqual([
    FAKE_GUM,
    "log",
    "--level=info",
    "--structured",
    GUM_END_OF_OPTIONS,
    SHORT_DASH_TEXT,
    "status",
    "success",
  ]);
});

test("gumStyle and gumJoin pass text blocks after the marker", async () => {
  await gumStyle({ text: [DASH_TEXT, "-"], bold: true, padding: "0 1" });
  expectTextAfterMarker({
    cmd: onlyCall(),
    subcommand: "style",
    text: [DASH_TEXT, "-"],
  });
  expect(calls[0]?.cmd).toContain("--padding=0 1");

  calls = [];
  await gumJoin({ text: [SHORT_DASH_TEXT, DASH_TEXT], horizontal: true });
  expectTextAfterMarker({
    cmd: onlyCall(),
    subcommand: "join",
    text: [SHORT_DASH_TEXT, DASH_TEXT],
  });
});

test("gumConfirm passes the prompt after the marker and binds button labels", async () => {
  const res = await gumConfirm({
    prompt: DASH_TEXT,
    affirmative: "--yes",
    negative: "-no",
    timeout: "5s",
  });
  expect(res).toEqual({ ok: true, value: true });

  const cmd = onlyCall();
  expectTextAfterMarker({ cmd, subcommand: "confirm", text: [DASH_TEXT] });
  expect(cmd).toContain("--affirmative=--yes");
  expect(cmd).toContain("--negative=-no");
});

test("gumConfirm without a prompt adds no marker", async () => {
  await gumConfirm({ default: true });
  expect(onlyCall()).toEqual([FAKE_GUM, "confirm", "--default"]);
});

test("gumChooseMany and gumFilterMany pass options after the marker", async () => {
  const chosen = await gumChooseMany({
    options: [DASH_TEXT, "-a"],
    header: "--pick one",
    selected: [DASH_TEXT],
  });
  expect(chosen).toEqual({ ok: true, value: ["picked"] });
  let cmd = onlyCall();
  expectTextAfterMarker({ cmd, subcommand: "choose", text: [DASH_TEXT, "-a"] });
  expect(cmd).toContain("--header=--pick one");
  expect(cmd).toContain(`--selected=${DASH_TEXT}`);

  calls = [];
  await gumFilterMany({
    options: ["-x", DASH_TEXT],
    placeholder: "-search",
    prompt: "--> ",
    value: "-",
  });
  cmd = onlyCall();
  expectTextAfterMarker({ cmd, subcommand: "filter", text: ["-x", DASH_TEXT] });
  expect(cmd).toContain("--placeholder=-search");
  expect(cmd).toContain("--prompt=--> ");
  expect(cmd).toContain("--value=-");
});

test("text prompts bind dash-leading values to their flags", async () => {
  await gumInput({ header: DASH_TEXT, placeholder: "-p", value: "--v" });
  let cmd = onlyCall();
  expect(cmd.slice(0, 2)).toEqual([FAKE_GUM, "input"]);
  expect(cmd).toEqual([
    FAKE_GUM,
    "input",
    "--placeholder=-p",
    `--header=${DASH_TEXT}`,
    "--value=--v",
  ]);

  calls = [];
  await gumWrite({ header: DASH_TEXT, prompt: "-> ", width: 40 });
  cmd = onlyCall();
  expect(cmd).toEqual([
    FAKE_GUM,
    "write",
    "--width=40",
    `--header=${DASH_TEXT}`,
    "--prompt=-> ",
  ]);
});

test("gumFile, gumPager and gumFormat pass content after the marker", async () => {
  await gumFile({ path: "-dir", header: "--h" });
  expectTextAfterMarker({
    cmd: onlyCall(),
    subcommand: "file",
    text: ["-dir"],
  });

  calls = [];
  await gumPager({ content: DASH_TEXT, softWrap: true });
  expectTextAfterMarker({
    cmd: onlyCall(),
    subcommand: "pager",
    text: [DASH_TEXT],
  });

  calls = [];
  await gumFormat({ template: [DASH_TEXT], type: "template" });
  expectTextAfterMarker({
    cmd: onlyCall(),
    subcommand: "format",
    text: [DASH_TEXT],
  });

  calls = [];
  await gumFormat({ input: DASH_TEXT, type: "markdown" });
  expect(onlyCall()).toEqual([FAKE_GUM, "format", "--type=markdown"]);
  expect(calls[0]?.stdin).toEqual({ text: DASH_TEXT });
});

test("gumSpin ends gum options before the wrapped command", async () => {
  await gumSpin({ cmd: ["bun", "--version"], title: "-loading" });
  const cmd = onlyCall();
  expectTextAfterMarker({
    cmd,
    subcommand: "spin",
    text: ["bun", "--version"],
  });
  expect(cmd).toContain("--title=-loading");
});

test("gumTable feeds rows on stdin and binds flag values", async () => {
  await gumTable({
    input: `${DASH_TEXT}\n`,
    columns: ["-a", "b"],
    print: true,
  });
  expect(onlyCall()).toEqual([FAKE_GUM, "table", "--columns=-a,b", "--print"]);
  expect(calls[0]?.stdin).toEqual({ text: `${DASH_TEXT}\n` });
});

test("gumVersionCheck passes the constraint after the marker", async () => {
  await gumVersionCheck({ constraint: "-1" });
  expectTextAfterMarker({
    cmd: onlyCall(),
    subcommand: "version-check",
    text: ["-1"],
  });
});
