import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

test("an existing machine-local layer keeps its own mode (HACK-1680)", async () => {
  const repo = await layersRepo();
  const layer = resolve(repo.projectDir, "hack.env.local.yaml");
  await writeFile(layer, LAYER_TEXT);
  await chmod(layer, 0o640);
  await withUmask(0o022, async () => {
    await setProjectEnvValue({
      ...repo,
      envName: null,
      scope: "global",
      key: "KEEP_MODE",
      value: "synthetic-keep-mode",
      secret: false,
      local: true,
    });
  });
  expect((await stat(layer)).mode & 0o777).toBe(0o640);
});
