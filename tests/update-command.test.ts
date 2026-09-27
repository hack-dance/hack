import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/run.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

const ENV_KEYS = [
  "HACK_RUNTIME_BACKEND",
  "HACK_NATIVE_BINARY",
  "HACK_NATIVE_HOME",
  "HACK_HOME",
  "HACK_ASSETS_DIR",
] as const;
const STABLE_BYTES = "unrelated standalone stable Hack sentinel\n";
const refuseNetwork: typeof globalThis.fetch = Object.assign(
  () => {
    throw new Error("unexpected release fetch");
  },
  {
    preconnect: () => {
      throw new Error("unexpected release preconnect");
    },
  }
);
let root: string;
let stable: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  root = await mkdtemp(join(tmpdir(), "hack-update-command-"));
  const stableBin = join(root, "stable-bin");
  await mkdir(stableBin);
  stable = join(stableBin, "hack");
  await writeFile(stable, STABLE_BYTES, { mode: 0o755 });
  process.env.HACK_HOME = join(root, "global-state");
  process.env.HACK_ASSETS_DIR = join(root, "assets");
  process.env.HACK_RUNTIME_BACKEND = "native";
  process.env.HACK_NATIVE_BINARY = join(root, "candidate", "hack-native");
  process.env.HACK_NATIVE_HOME = join(root, "candidate-home");
});

afterEach(async () => {
  mock.restore();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function stableIdentity() {
  const metadata = await stat(stable);
  return {
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

async function capturedRun(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  try {
    return { exitCode: await runCli(args), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

test.each([
  true,
  false,
])("native update --yes refuses before lookup or fetch (complete selection: %s)", async (completeSelection) => {
  if (!completeSelection) {
    Reflect.deleteProperty(process.env, "HACK_NATIVE_BINARY");
    Reflect.deleteProperty(process.env, "HACK_NATIVE_HOME");
  }
  const before = await stableIdentity();
  const fetch = spyOn(globalThis, "fetch").mockImplementation(refuseNetwork);
  const lookup = spyOn(Bun, "which").mockImplementation(() => {
    throw new Error("unexpected stable binary lookup");
  });
  const result = await capturedRun(["update", "--yes", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: false,
    error:
      "Refusing to self-update the opt-in native candidate. Install a separately reviewed candidate bundle to update it.",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(await readFile(stable, "utf8")).toBe(STABLE_BYTES);
  expect(await stableIdentity()).toEqual(before);
  for (const path of [process.env.HACK_HOME, process.env.HACK_ASSETS_DIR]) {
    expect(
      await access(path ?? "").then(
        () => true,
        () => false
      )
    ).toBe(false);
  }
});

test("native update --check --tag also refuses with a human diagnostic", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(refuseNetwork);
  const lookup = spyOn(Bun, "which").mockImplementation(() => {
    throw new Error("unexpected stable binary lookup");
  });
  const result = await capturedRun(["update", "--check", "--tag", "v999.0.0"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "Refusing to self-update the opt-in native candidate"
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(await readFile(stable, "utf8")).toBe(STABLE_BYTES);
});

test.each([
  "compose",
  undefined,
])("ordinary update --check retains stable release lookup (backend: %s)", async (backend) => {
  if (backend === undefined) {
    Reflect.deleteProperty(process.env, "HACK_RUNTIME_BACKEND");
  } else {
    process.env.HACK_RUNTIME_BACKEND = backend;
  }
  const before = await stableIdentity();
  const lookup = spyOn(Bun, "which").mockReturnValue(stable);
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ tag_name: `v${CLI_SPEC.version}`, assets: [] })
  );
  const result = await capturedRun(["update", "--check", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    current: CLI_SPEC.version,
    latest: CLI_SPEC.version,
    installed: false,
    updateAvailable: false,
    binaryPath: stable,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith("hack");
  expect(await readFile(stable, "utf8")).toBe(STABLE_BYTES);
  expect(await stableIdentity()).toEqual(before);
});
