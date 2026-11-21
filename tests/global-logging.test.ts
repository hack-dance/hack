import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseLoggingEnabled,
  resolveAndSaveGlobalLogging,
  resolveGlobalLogging,
  resolveLoggingFlag,
} from "../src/lib/global-logging.ts";

let root = "";
let savedConfigPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-global-logging-"));
  savedConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "hack.config.json");
});

afterEach(async () => {
  if (savedConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = savedConfigPath;
  }
  await rm(root, { recursive: true, force: true });
});

const compose = () => join(root, "logging", "docker-compose.yml");

async function setConfig(value: unknown): Promise<void> {
  await writeFile(
    join(root, "hack.config.json"),
    `${JSON.stringify({ logging: { enabled: value } })}\n`
  );
}

async function writeCompose(): Promise<void> {
  await mkdir(dirname(compose()), { recursive: true });
  await writeFile(compose(), "services: {}\n");
}

test("unset: off for a new home, on for a home that already has the stack", async () => {
  expect(await resolveGlobalLogging({ loggingCompose: compose() })).toEqual({
    enabled: false,
    source: "default",
  });
  await writeCompose();
  expect(await resolveGlobalLogging({ loggingCompose: compose() })).toEqual({
    enabled: true,
    source: "existing-home",
  });
});

test("the config decides when set, whatever files the home has", async () => {
  await writeCompose();
  await setConfig(false);
  expect(await resolveGlobalLogging({ loggingCompose: compose() })).toEqual({
    enabled: false,
    source: "config",
  });
  await rm(compose());
  await setConfig(true);
  expect(await resolveGlobalLogging({ loggingCompose: compose() })).toEqual({
    enabled: true,
    source: "config",
  });
});

test("the value is a boolean, or the strings true/false that `hack config set` may store", async () => {
  expect(parseLoggingEnabled(true)).toBe(true);
  expect(parseLoggingEnabled("false")).toBe(false);
  await setConfig("yes");
  await expect(
    resolveGlobalLogging({ loggingCompose: compose() })
  ).rejects.toThrow("logging.enabled must be true or false");
});

test("--logging and --no-logging map to the setting; both together conflict", () => {
  expect(resolveLoggingFlag({})).toBeNull();
  expect(resolveLoggingFlag({ logging: true })).toBe(true);
  expect(resolveLoggingFlag({ noLogging: true })).toBe(false);
  expect(resolveLoggingFlag({ logging: true, noLogging: true })).toBe(
    "conflict"
  );
});

test("the marker is the logging directory: a compose file moved aside does not turn a home off", async () => {
  await mkdir(dirname(compose()), { recursive: true });
  expect(await resolveGlobalLogging({ loggingCompose: compose() })).toEqual({
    enabled: true,
    source: "existing-home",
  });
});

test("an existing home's choice is saved once; a new or decided home saves nothing", async () => {
  const saved: boolean[] = [];
  const save = (value: boolean) => {
    saved.push(value);
    return Promise.resolve();
  };
  expect(
    await resolveAndSaveGlobalLogging({ loggingCompose: compose(), save })
  ).toEqual({ enabled: false, source: "default", saved: false });
  await writeCompose();
  expect(
    await resolveAndSaveGlobalLogging({ loggingCompose: compose(), save })
  ).toEqual({ enabled: true, source: "config", saved: true });
  await setConfig(false);
  expect(
    await resolveAndSaveGlobalLogging({ loggingCompose: compose(), save })
  ).toEqual({ enabled: false, source: "config", saved: false });
  expect(saved).toEqual([true]);
});
