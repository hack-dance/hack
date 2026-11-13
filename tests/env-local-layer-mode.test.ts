import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_COMPOSE_FILENAME } from "../src/constants.ts";
import {
  hydrateProjectEnvLocalLayer,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * HACK-1680: machine-local env layers can hold plaintext values, so the
 * commands that create them make them private (0600) from creation, whatever
 * the umask. Temp HOME and project, synthetic values, no git or Docker.
 */

const LAYER_TEXT =
  "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n";
let root: string | null = null;
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.HOME;
  root = await mkdtemp(join(tmpdir(), "hack-env-local-layer-mode-"));
  process.env.HOME = resolve(root, "home");
  await mkdir(process.env.HOME, { recursive: true });
});

afterEach(async () => {
  restoreEnv("HOME", savedHome);
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

async function layersRepo(): Promise<{
  readonly projectRoot: string;
  readonly projectDir: string;
}> {
  if (!root) {
    throw new Error("root not set");
  }
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api: {}\n"
  );
  await writeFile(resolve(projectDir, "hack.env.default.yaml"), LAYER_TEXT);
  return { projectRoot, projectDir };
}

async function withUmask<T>(mask: number, run: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await run();
  } finally {
    process.umask(previous);
  }
}

test("env set --local creates a machine-local layer as 0600 under umask 022 (HACK-1680)", async () => {
  const repo = await layersRepo();
  await withUmask(0o022, async () => {
    for (const envName of [null, "qa"] as const) {
      const result = await setProjectEnvValue({
        ...repo,
        envName,
        scope: "global",
        key: "LOCAL_ONLY",
        value: ["synthetic", "local", "4b4b"].join("-"),
        secret: false,
        local: true,
      });
      expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    }
    // A tracked layer keeps the umask default.
    const tracked = await setProjectEnvValue({
      ...repo,
      envName: "shared",
      scope: "global",
      key: "SHARED",
      value: "synthetic-shared",
      secret: false,
    });
    expect((await stat(tracked.filePath)).mode & 0o777).toBe(0o644);
  });
});

test("env hydrate creates a machine-local layer as 0600 under umask 022 (HACK-1680)", async () => {
  const repo = await layersRepo();
  await withUmask(0o022, async () => {
    const result = await hydrateProjectEnvLocalLayer({
      ...repo,
      envName: null,
      scope: "global",
      entries: new Map([["HYDRATED", ["synthetic", "hydrated"].join("-")]]),
      secret: false,
    });
    expect(result.changed).toBe(true);
    expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
  });
});

// HACK-1680 kept an existing layer's mode; HACK-2165 tightens one that
// predates private creation (or was made by hand) on its next write.
test.each([
  [0o644, 0o600],
  [0o640, 0o600],
  [0o600, 0o600],
  [0o700, 0o700],
])("an existing machine-local layer at %o is %o after a write (HACK-2165)", async (before, after) => {
  const repo = await layersRepo();
  const layer = resolve(repo.projectDir, "hack.env.local.yaml");
  await writeFile(layer, LAYER_TEXT);
  await chmod(layer, before);
  await withUmask(0o022, async () => {
    await setProjectEnvValue({
      ...repo,
      envName: null,
      scope: "global",
      key: "TIGHTEN_MODE",
      value: "synthetic-tighten-mode",
      secret: false,
      local: true,
    });
  });
  expect((await stat(layer)).mode & 0o777).toBe(after);
});

test("a write that changes nothing still tightens a loose machine-local layer (HACK-2165)", async () => {
  const repo = await layersRepo();
  const layer = resolve(repo.projectDir, "hack.env.local.yaml");
  const write = () =>
    setProjectEnvValue({
      ...repo,
      envName: null,
      scope: "global",
      key: "SAME_VALUE",
      value: "synthetic-same-value",
      secret: false,
      local: true,
    });
  await write();
  await chmod(layer, 0o644);
  const before = await readFile(layer, "utf8");
  await write();
  expect((await stat(layer)).mode & 0o777).toBe(0o600);
  expect(await readFile(layer, "utf8")).toBe(before);
});

test("a tracked (shared) layer keeps its mode on a write", async () => {
  const repo = await layersRepo();
  const layer = resolve(repo.projectDir, "hack.env.yaml");
  await writeFile(layer, LAYER_TEXT);
  await chmod(layer, 0o644);
  await setProjectEnvValue({
    ...repo,
    envName: null,
    scope: "global",
    key: "SHARED_MODE",
    value: "synthetic-shared-mode",
    secret: false,
    local: false,
  });
  expect((await stat(layer)).mode & 0o777).toBe(0o644);
});
