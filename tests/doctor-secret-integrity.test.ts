import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import { inspectSecretIntegrity } from "../src/lib/doctor-secret-integrity.ts";
import {
  PROJECT_ENV_SECRET_KEY_ENV,
  resolveProjectEnvConfigPath,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * HACK-2169: `hack doctor` reports stores and env layers whose secrets cannot
 * all be read, with recovery steps and never a value. Synthetic values only.
 */

const tempDirs = new Set<string>();
const previousEnvKey = process.env[PROJECT_ENV_SECRET_KEY_ENV];
const previousStoreKey = process.env.HACK_SECRETS_FILE_KEY;

afterEach(async () => {
  restoreEnv(PROJECT_ENV_SECRET_KEY_ENV, previousEnvKey);
  restoreEnv("HACK_SECRETS_FILE_KEY", previousStoreKey);
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

async function createRepo(config: Record<string, unknown> = {}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-secret-integrity-"));
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
    `${JSON.stringify({ name: "integrity", dev_host: "integrity.hack", ...config }, null, 2)}\n`
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

async function setSecret(repo: Repo, key: string, value: string) {
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key,
    value,
    secret: true,
  });
}

async function inspect(repo: Repo) {
  return await inspectSecretIntegrity({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "integrity",
  });
}

function globalValues(text: string): Record<string, unknown> {
  const parsed = YAML.parse(text) as {
    values?: { global?: Record<string, unknown> };
  };
  return parsed.values?.global ?? {};
}

test("a layer holding secrets under two keys is reported, value-free", async () => {
  // The F8 aftermath: one secret under the current key, one under another.
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-a19c");
  const other = await createRepo();
  await setSecret(other, "SECOND", "synthetic-second-77d0");
  const text = await readFile(repo.envFile, "utf8");
  const parsed = YAML.parse(text) as {
    values: { global: Record<string, unknown> };
  };
  parsed.values.global.SECOND = globalValues(
    await readFile(other.envFile, "utf8")
  ).SECOND;
  await writeFile(repo.envFile, YAML.stringify(parsed));

  const findings = await inspect(repo);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.status).toBe("error");
  expect(findings[0]?.message).toContain("more than one key: 1 of 2");
  expect(findings[0]?.message).toContain("hack env set <name> --secret");
  const keyText = (await readFile(repo.keyFile, "utf8")).trim();
  for (const secret of [
    "synthetic-first-a19c",
    "synthetic-second-77d0",
    keyText,
  ]) {
    expect(findings[0]?.message).not.toContain(secret);
  }
});

test("a layer whose key is missing, or the wrong one, is reported", async () => {
  const repo = await createRepo();
  await setSecret(repo, "FIRST", "synthetic-first-0b4e");
  expect(await inspect(repo)).toEqual([]);
  await rm(repo.keyFile);
  const missing = await inspect(repo);
  expect(missing[0]?.message).toContain("no project env key is available here");
  process.env[PROJECT_ENV_SECRET_KEY_ENV] = "synthetic-unrelated-key-material";
  const wrong = await inspect(repo);
  expect(wrong[0]?.message).toContain("None of the 1 secret(s)");
});

test("an unreadable store and a store whose key is missing are reported", async () => {
  if (process.getuid?.() === 0) {
    return;
  }
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  const repo = await createRepo({
    controlPlane: {
      secrets: {
        backend: "encrypted_file",
        encryptedFile: {
          path: ".hack-secrets.enc.json",
          keyPath: ".hack-secrets-file.key",
        },
      },
    },
  });
  const store = await resolveSecretStore({
    projectName: "integrity",
    projectDir: repo.projectDir,
  });
  await store.set({ key: "TOKEN", value: "synthetic-store-5e61" });
  expect(await inspect(repo)).toEqual([]);
  const storePath = resolve(repo.projectRoot, ".hack-secrets.enc.json");
  const keyPath = resolve(repo.projectRoot, ".hack-secrets-file.key");

  await chmod(storePath, 0o000);
  try {
    const unreadable = await inspect(repo);
    expect(unreadable[0]?.message).toContain(
      ".hack-secrets.enc.json exists but cannot be read"
    );
  } finally {
    await chmod(storePath, 0o600);
  }

  const keyText = await readFile(keyPath, "utf8");
  await rm(keyPath);
  const keyMissing = await inspect(repo);
  expect(keyMissing[0]?.message).toContain(
    "its key .hack-secrets-file.key is missing"
  );
  for (const secret of ["synthetic-store-5e61", keyText.trim()]) {
    expect(keyMissing[0]?.message).not.toContain(secret);
  }
});
