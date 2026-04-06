import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  assertValidProjectEnvScopeName,
  ensureProjectEnvSecretKey,
  inspectLegacyComposeEnvFileReferences,
  materializeProjectEnv,
  migrateLegacyProjectEnv,
  parseProjectEnvTarget,
  repairLegacyComposeEnvFileReferences,
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
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
  process.env.HACK_ENV_SECRET_KEY = undefined;
});

async function createRepo(): Promise<{
  readonly tempRoot: string;
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
  return { tempRoot: root, projectRoot, projectDir, composeFile, configFile };
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
    projectDir: repo.projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "secret-token",
    secret: true,
  });
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
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
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "1",
    secret: false,
  });
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
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

test("materializeProjectEnv rejects unknown service scopes", async () => {
  const repo = await createRepo();
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "1",
    secret: false,
  });

  await expect(
    materializeProjectEnv({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceName: "typo_service",
      serviceNames: ["api", "web"],
    })
  ).rejects.toThrow("Unknown env scope: typo_service");
});

test("project env scopes accept compose-compatible underscores and dots", () => {
  expect(
    assertValidProjectEnvScopeName({
      scopeName: "api_worker.v2",
    })
  ).toBe("api_worker.v2");
  expect(
    parseProjectEnvTarget({
      keyOrPath: "api_worker.v2.SERVICE_TOKEN",
    })
  ).toEqual({
    scope: "api_worker.v2",
    key: "SERVICE_TOKEN",
  });
});

test("resolveProjectEnvConfig falls back to HACK_ENV_SECRET_KEY when the key file is missing", async () => {
  const repo = await createRepo();

  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "super-secret-token",
    secret: true,
  });

  const keyPath = resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME);
  const keyText = (await readFile(keyPath, "utf8")).trim();
  await unlink(keyPath);
  process.env.HACK_ENV_SECRET_KEY = keyText;

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });

  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe("super-secret-token");
});

test("linked worktrees inherit the primary checkout env key", async () => {
  const repo = await createRepo();
  await writeFile(
    resolve(repo.projectRoot, ".gitignore"),
    ".hack.secret.key\n"
  );

  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "super-secret-token",
    secret: true,
  });

  const primaryKeyPath = resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME);
  const primaryKeyText = (await readFile(primaryKeyPath, "utf8")).trim();

  await initializeGitRepo({ projectRoot: repo.projectRoot });
  const worktreeRoot = resolve(repo.tempRoot, "repo-worktree");
  await createGitWorktree({
    projectRoot: repo.projectRoot,
    worktreeRoot,
    branch: "feature/env-key",
  });

  const ensured = await ensureProjectEnvSecretKey({
    projectRoot: worktreeRoot,
  });
  expect(ensured.created).toBe(false);
  expect((await readFile(ensured.keyPath, "utf8")).trim()).toBe(primaryKeyText);

  const resolved = await resolveProjectEnvConfig({
    projectRoot: worktreeRoot,
    projectDir: resolve(worktreeRoot, ".hack"),
    envName: null,
    serviceNames: ["api", "web"],
  });

  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe("super-secret-token");
});

test("host target only applies explicit host overrides on top of service values", async () => {
  const repo = await createRepo();

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    DATABASE_URL: "mysql://global"',
      '    SHARED_HOST: "redis"',
      "  api:",
      '    DATABASE_URL: "mysql://api"',
      '    PORT: "3000"',
      "  host:",
      '    SHARED_HOST: "127.0.0.1"',
      "",
    ].join("\n")
  );

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });

  expect(resolved).not.toBeNull();
  if (!resolved) {
    throw new Error("Expected resolved env config.");
  }

  expect(
    selectProjectEnvValuesForExecutionTarget({
      resolved,
      scopeName: "api",
      target: "host",
    })
  ).toEqual({
    DATABASE_URL: "mysql://api",
    PORT: "3000",
    SHARED_HOST: "127.0.0.1",
  });
});

test("host service scopes keep their existing meaning when the repo has a host service", async () => {
  const repo = await createRepo();

  await writeFile(repo.composeFile, "services:\n  api: {}\n  host: {}\n");
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    SHARED_HOST: "global"',
      "  api:",
      '    DATABASE_URL: "mysql://api"',
      "  host:",
      '    SHARED_HOST: "service-host"',
      '    HOST_ONLY: "host-service-scope"',
      "",
    ].join("\n")
  );

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "host"],
  });

  expect(resolved).not.toBeNull();
  if (!resolved) {
    throw new Error("Expected resolved env config.");
  }

  expect(resolved.hostEnv).toEqual({});
  expect(
    selectProjectEnvValuesForExecutionTarget({
      resolved,
      scopeName: "api",
      target: "host",
    })
  ).toEqual({
    DATABASE_URL: "mysql://api",
    SHARED_HOST: "global",
  });
  expect(resolved.serviceEnv.host).toEqual({
    HOST_ONLY: "host-service-scope",
    SHARED_HOST: "service-host",
  });
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
  expect(migrated.updatedProjectConfig).toBe(true);
  expect(migrated.cleanupCandidates).toEqual([
    resolve(repo.projectDir, PROJECT_ENV_FILENAME),
    resolve(repo.projectDir, ".env.qa"),
    resolve(repo.projectDir, PROJECT_ENV_CONTRACT_FILENAME),
    resolve(repo.projectRoot, "legacy-secrets.enc.json"),
  ]);

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    serviceNames: ["api", "web"],
  });
  expect(resolved?.serviceEnv.api?.API_BASE_URL).toBe("https://qa.example.com");
  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe("qa-secret");

  const configText = await readFile(repo.configFile, "utf8");
  const config = JSON.parse(configText) as Record<string, unknown>;
  expect(config.defaultEnvConfig).toBeUndefined();
  expect(config.env).toEqual({
    defaultOverlay: "qa",
  });
  expect(config.controlPlane).toBeUndefined();
});

test("migrateLegacyProjectEnv blocks cleanup for compose-referenced legacy env files and can repair compose", async () => {
  const repo = await createRepo();
  await writeFile(
    repo.composeFile,
    [
      "services:",
      "  db-ops:",
      "    image: alpine:3.20",
      "    env_file:",
      "      - .env",
      "      - ../.env.docker",
      "      - path: .env.production",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, PROJECT_ENV_CONTRACT_FILENAME),
    `${JSON.stringify(
      {
        version: 1,
        vars: [{ key: "API_BASE_URL", source: "plain_env" }],
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
    envFile: resolve(repo.projectDir, ".env.production"),
    key: "API_BASE_URL",
    value: "https://prod.example.com",
  });

  const migrated = await migrateLegacyProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "project-env-test",
    serviceNames: ["db-ops"],
    materialize: false,
  });
  expect(migrated.composeEnvFileReferences).toEqual([
    {
      service: "db-ops",
      configuredPath: ".env",
      resolvedPath: resolve(repo.projectDir, PROJECT_ENV_FILENAME),
    },
    {
      service: "db-ops",
      configuredPath: ".env.production",
      resolvedPath: resolve(repo.projectDir, ".env.production"),
    },
  ]);
  expect(migrated.cleanupCandidates).toEqual([
    resolve(repo.projectDir, PROJECT_ENV_CONTRACT_FILENAME),
  ]);
  expect(migrated.blockedCleanupCandidates).toEqual([
    resolve(repo.projectDir, PROJECT_ENV_FILENAME),
    resolve(repo.projectDir, ".env.production"),
  ]);

  const inspected = await inspectLegacyComposeEnvFileReferences({
    composeFile: repo.composeFile,
    projectDir: repo.projectDir,
  });
  expect(inspected).toEqual(migrated.composeEnvFileReferences);

  const repaired = await repairLegacyComposeEnvFileReferences({
    composeFile: repo.composeFile,
    projectDir: repo.projectDir,
  });
  expect(repaired.changed).toBe(true);
  expect(repaired.removed).toEqual(migrated.composeEnvFileReferences);

  const composeText = await readFile(repo.composeFile, "utf8");
  expect(composeText).not.toContain("- .env\n");
  expect(composeText).not.toContain("path: .env.production");
  expect(composeText).toContain("- ../.env.docker");
});

async function initializeGitRepo(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  await writeFile(resolve(opts.projectRoot, "README.md"), "# env test\n");
  runGit({ cwd: opts.projectRoot, args: ["init"] });
  runGit({
    cwd: opts.projectRoot,
    args: ["config", "user.email", "test@example.com"],
  });
  runGit({
    cwd: opts.projectRoot,
    args: ["config", "user.name", "Test User"],
  });
  runGit({ cwd: opts.projectRoot, args: ["add", "."] });
  runGit({
    cwd: opts.projectRoot,
    args: ["commit", "-m", "test: seed env fixture"],
  });
  runGit({ cwd: opts.projectRoot, args: ["branch", "-M", "main"] });
}

async function createGitWorktree(opts: {
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly branch: string;
}): Promise<void> {
  runGit({
    cwd: opts.projectRoot,
    args: ["worktree", "add", "-b", opts.branch, opts.worktreeRoot],
  });
}

function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): string {
  const result = Bun.spawnSync(["git", "-C", opts.cwd, ...opts.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args.join(" ")} failed\n${Buffer.from(result.stderr).toString("utf8")}`
    );
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}
