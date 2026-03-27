import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import { upsertDotEnvValue } from "../src/lib/hack-env.ts";
import { readProjectDefaultEnvConfig } from "../src/lib/project.ts";
import {
  materializeProjectEnv,
  migrateLegacyProjectEnv,
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  process.env.HACK_SECRETS_FILE_KEY = undefined;
});

async function createRepo(): Promise<{
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
  readonly configFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-project-env-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  const composeFile = resolve(projectDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(projectDir, PROJECT_CONFIG_FILENAME);
  await writeFile(composeFile, "services:\n  api: {}\n  web: {}\n");
  await writeFile(
    configFile,
    `${JSON.stringify(
      {
        name: "project-env-test",
        dev_host: "project-env.hack",
      },
      null,
      2
    )}\n`
  );
  return { projectRoot, projectDir, composeFile, configFile };
}

test("readProjectDefaultEnvConfig prefers env.defaultOverlay", async () => {
  const repo = await createRepo();
  await writeFile(
    repo.configFile,
    `${JSON.stringify(
      {
        name: "project-env-test",
        dev_host: "project-env.hack",
        defaultEnvConfig: "legacy",
        env: {
          defaultOverlay: "docker",
        },
      },
      null,
      2
    )}\n`
  );

  const defaultOverlay = await readProjectDefaultEnvConfig({
    projectDir: repo.projectDir,
  });
  expect(defaultOverlay).toBe("docker");
});

test("setProjectEnvValue creates project key, gitignore entry, and service-scoped secret config", async () => {
  const repo = await createRepo();
  await writeFile(
    resolve(repo.projectRoot, ".gitignore"),
    ".hack/.internal/\n"
  );

  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "secret-token",
    secret: true,
  });
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    envName: "qa",
    scope: "global",
    key: "API_BASE_URL",
    value: "https://qa.example.com",
    secret: false,
  });

  const keyPath = resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME);
  const keyText = await readFile(keyPath, "utf8");
  expect(keyText.trim().length).toBeGreaterThan(10);

  const gitignoreText = await readFile(
    resolve(repo.projectRoot, ".gitignore"),
    "utf8"
  );
  expect(gitignoreText).toContain(PROJECT_ENV_KEY_FILENAME);

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    serviceNames: ["api", "web"],
  });
  expect(resolved).not.toBeNull();
  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe("secret-token");
  expect(resolved?.globalEnv.API_BASE_URL).toBe("https://qa.example.com");
});

test("materializeProjectEnv writes selected service env without touching runtime selection", async () => {
  const repo = await createRepo();
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "1",
    secret: false,
  });
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    envName: null,
    scope: "api",
    key: "PORT",
    value: "4000",
    secret: false,
  });

  const result = await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceName: "api",
    serviceNames: ["api", "web"],
  });
  expect(result.changed).toBe(true);

  const envText = await readFile(
    resolve(repo.projectDir, PROJECT_ENV_FILENAME),
    "utf8"
  );
  expect(envText).toContain("GLOBAL_FLAG=1");
  expect(envText).toContain("PORT=4000");
});

test("migrateLegacyProjectEnv converts legacy base and overlay values into new config files", async () => {
  const repo = await createRepo();
  process.env.HACK_SECRETS_FILE_KEY = "legacy-migrate-key";
  await writeFile(
    repo.configFile,
    `${JSON.stringify(
      {
        name: "project-env-test",
        dev_host: "project-env.hack",
        defaultEnvConfig: "qa",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            storePlaintextInBackend: true,
            encryptedFile: {
              path: resolve(repo.projectRoot, "legacy-secrets.enc.json"),
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resolve(repo.projectDir, PROJECT_ENV_CONTRACT_FILENAME),
    `${JSON.stringify(
      {
        version: 1,
        vars: [
          { key: "API_BASE_URL", source: "plain_env", services: ["api"] },
          { key: "SERVICE_TOKEN", source: "keychain", services: ["api"] },
        ],
      },
      null,
      2
    )}\n`
  );
  await upsertDotEnvValue({
    envFile: resolve(repo.projectDir, PROJECT_ENV_FILENAME),
    key: "API_BASE_URL",
    value: "https://base.example.com",
  });
  await upsertDotEnvValue({
    envFile: resolve(repo.projectDir, ".env.qa"),
    key: "API_BASE_URL",
    value: "https://qa.example.com",
  });
  const secretStore = await resolveSecretStore({
    projectName: "project-env-test",
    projectDir: repo.projectDir,
  });
  await secretStore.set({
    key: "SERVICE_TOKEN",
    value: "base-secret",
  });
  await secretStore.set({
    key: "env.qa.SERVICE_TOKEN",
    value: "qa-secret",
  });

  const migrated = await migrateLegacyProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "project-env-test",
    serviceNames: ["api", "web"],
    materialize: false,
  });
  expect(migrated.legacyDetected).toBe(true);

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    serviceNames: ["api", "web"],
  });
  expect(resolved?.serviceEnv.api?.API_BASE_URL).toBe("https://qa.example.com");
  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe("qa-secret");
});
