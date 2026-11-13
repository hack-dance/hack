import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import {
  PROJECT_ENV_SECRET_KEY_ENV,
  resolveProjectEnvConfig,
  resolveProjectEnvConfigPath,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * HACK-2169 (audit F8): writing a secret never creates a key that shadows the
 * one readers use, and never mixes keys in a layer. Every value is a
 * synthetic test string.
 */

const FIRST = "synthetic-first-c3a1";
const LATER = "synthetic-later-5b7e";
const tempDirs = new Set<string>();
const previousEnvKey = process.env[PROJECT_ENV_SECRET_KEY_ENV];

afterEach(async () => {
  restoreEnv(PROJECT_ENV_SECRET_KEY_ENV, previousEnvKey);
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envFile: string;
  readonly keyFile: string;
};

async function createRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-key-integrity-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "env-key-integrity", dev_host: "env-key-integrity.hack" }, null, 2)}\n`
  );
  await writeFile(
    resolve(projectRoot, ".gitignore"),
    `${PROJECT_ENV_KEY_FILENAME}\n`
  );
  return {
    projectRoot,
    projectDir,
    envFile: resolveProjectEnvConfigPath({ projectDir, envName: null }),
    keyFile: resolve(projectRoot, PROJECT_ENV_KEY_FILENAME),
  };
}

async function setValue(
  repo: Repo,
  key: string,
  value: string,
  secret: boolean
) {
  return await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key,
    value,
    secret,
  });
}

async function resolved(repo: Repo, key: string): Promise<string | undefined> {
  const config = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  return config?.globalEnv[key];
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false
  );
}

test("a secret write with only HACK_ENV_SECRET_KEY never creates a shadowing key file", async () => {
  // A CI-like checkout: the committed layer's secrets open through the
  // environment key, and there is no key file.
  const repo = await createRepo();
  await setValue(repo, "API_TOKEN", FIRST, true);
  const keyText = (await readFile(repo.keyFile, "utf8")).trim();
  await rm(repo.keyFile);
  process.env[PROJECT_ENV_SECRET_KEY_ENV] = keyText;
  expect(await resolved(repo, "API_TOKEN")).toBe(FIRST);
  const layerBefore = await readFile(repo.envFile, "utf8");

  await expect(setValue(repo, "NEW_TOKEN", LATER, true)).rejects.toThrow(
    `${PROJECT_ENV_SECRET_KEY_ENV} is set but no ${PROJECT_ENV_KEY_FILENAME} exists`
  );
  // Nothing was written: no new key file, the layer unchanged, and the
  // existing secret still opens.
  expect(await exists(repo.keyFile)).toBe(false);
  expect(await readFile(repo.envFile, "utf8")).toBe(layerBefore);
  expect(await resolved(repo, "API_TOKEN")).toBe(FIRST);

  // The documented fix: store the same key in the key file.
  await writeFile(repo.keyFile, `${keyText}\n`, { mode: 0o600 });
  await setValue(repo, "NEW_TOKEN", LATER, true);
  expect(await resolved(repo, "NEW_TOKEN")).toBe(LATER);
  expect(await resolved(repo, "API_TOKEN")).toBe(FIRST);
});

test("a secret write never mints a key while the layer holds secrets no available key opens", async () => {
  const repo = await createRepo();
  await setValue(repo, "API_TOKEN", FIRST, true);
  await rm(repo.keyFile);
  const layerBefore = await readFile(repo.envFile, "utf8");

  await expect(setValue(repo, "NEW_TOKEN", LATER, true)).rejects.toThrow(
    "does not decrypt under the project env key, or no key is available"
  );
  expect(await exists(repo.keyFile)).toBe(false);
  expect(await readFile(repo.envFile, "utf8")).toBe(layerBefore);
  // A plain value needs no key and is still written.
  await setValue(repo, "PLAIN", "synthetic-plain-1d2f", false);
  expect(await exists(repo.keyFile)).toBe(false);
});
