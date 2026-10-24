import { afterEach, expect, spyOn, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
  PROJECT_ENV_STATE_FILENAME,
} from "../src/constants.ts";
import { resetHackGitInfoExcludeCacheForTests } from "../src/lib/git-info-exclude.ts";
import { upsertDotEnvValue } from "../src/lib/hack-env.ts";
import { readProjectDefaultEnvConfig } from "../src/lib/project.ts";
import {
  assertValidProjectEnvScopeName,
  ENV_SCOPE_UNKNOWN_MESSAGE,
  ensureHackDirGitignore,
  ensureProjectEnvSecretKey,
  HACK_DIR_GITIGNORE_READ_ONLY_WARNING,
  inspectLegacyComposeEnvFileReferences,
  inspectProjectEnvMaterialization,
  listProjectEnvOverlayNames,
  materializeProjectEnv,
  migrateLegacyProjectEnv,
  parseProjectEnvTarget,
  removeLegacyProjectEnvArtifacts,
  repairLegacyComposeEnvFileReferences,
  resolveProjectEnvConfig,
  resolveProjectEnvLocalConfigPath,
  resolveProjectEnvSharedKeyPath,
  selectProjectEnvValues,
  selectProjectEnvValuesForExecutionTarget,
  setProjectEnvValue,
  unknownProjectEnvScopeMessage,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
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

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    env: fixtureGitEnv(),
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await runGit(["init", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "Hack Test"], repoRoot);
  await runGit(["config", "user.email", "hack@example.com"], repoRoot);
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

test("inspectProjectEnvMaterialization reports clean state after materialize", async () => {
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

  await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });

  const inspected = await inspectProjectEnvMaterialization({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: undefined,
    serviceNames: ["api", "web"],
  });

  expect(inspected.status).toBe("ok");
  expect(inspected.message).toContain(
    "matches current env selection and inputs"
  );
  expect(inspected.issues).toEqual([]);
});

test("inspectProjectEnvMaterialization reports stale inputs after env config changes", async () => {
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

  await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "NEW_FLAG",
    value: "2",
    secret: false,
  });

  const inspected = await inspectProjectEnvMaterialization({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: undefined,
    serviceNames: ["api", "web"],
  });

  expect(inspected.status).toBe("warn");
  expect(inspected.message).toContain("changed since materialization");
  expect(inspected.message).toContain("hack env materialize");
});

test("inspectProjectEnvMaterialization reports selected service drift", async () => {
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
    key: "API_ONLY",
    value: "yes",
    secret: false,
  });

  await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceName: "api",
    serviceNames: ["api", "web"],
  });

  const inspected = await inspectProjectEnvMaterialization({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: undefined,
    serviceNames: ["api", "web"],
  });

  expect(inspected.status).toBe("warn");
  expect(inspected.message).toContain(
    "materialized service scope api does not match effective service scope none"
  );
  expect(inspected.message).toContain("hack env materialize");
});

test("inspectProjectEnvMaterialization reports missing state for materialized env output", async () => {
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

  await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });
  await unlink(resolve(repo.projectDir, PROJECT_ENV_STATE_FILENAME));

  const inspected = await inspectProjectEnvMaterialization({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: undefined,
    serviceNames: ["api", "web"],
  });

  expect(inspected.status).toBe("warn");
  expect(inspected.message).toContain("missing");
  expect(inspected.message).toContain("hack env materialize");
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

  const error = await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceName: "typo_service",
    serviceNames: ["api", "web"],
  }).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  // Configured scope names come from compose/env files and may be listed;
  // the requested argument never is.
  expect(message).toBe(
    `${ENV_SCOPE_UNKNOWN_MESSAGE} Configured scopes: global, api, web.`
  );
  expect(message).not.toContain("typo_service");
});

test("unknown-scope refusals list configured scopes but never the request", () => {
  const canary = "api_token=unknown-scope-canary-7c2e";
  const resolved = {
    globalEnv: {},
    serviceEnv: { web: {}, api: {} },
    hostTargetEnv: {},
  } as unknown as Parameters<typeof selectProjectEnvValues>[0]["resolved"];
  for (const scopeName of [canary, "constructor", "__proto__", "toString"]) {
    let message = "";
    try {
      selectProjectEnvValues({ resolved, scopeName });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `${ENV_SCOPE_UNKNOWN_MESSAGE} Configured scopes: global, api, web.`
    );
    expect(message).not.toContain(scopeName);
  }

  const many = unknownProjectEnvScopeMessage({
    configuredScopes: Array.from({ length: 30 }, (_, i) => `svc${i + 100}`),
  });
  expect(many).toContain("(and 11 more)");
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

test("env key and scope refusals never echo the rejected argument", async () => {
  const canary = "echo-canary-lib-5e1c";
  const refusal = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected a refusal");
  };
  const messages = [
    refusal(() => parseProjectEnvTarget({ keyOrPath: `API_TOKEN=${canary}` })),
    refusal(() =>
      parseProjectEnvTarget({ keyOrPath: `API_TOKEN=${canary}.tail` })
    ),
    refusal(() => parseProjectEnvTarget({ keyOrPath: canary })),
    refusal(() => parseProjectEnvTarget({ keyOrPath: `api.${canary}` })),
    refusal(() =>
      parseProjectEnvTarget({ keyOrPath: `Bad${canary}.API_TOKEN` })
    ),
    refusal(() =>
      assertValidProjectEnvScopeName({ scopeName: `Bad${canary}` })
    ),
  ];
  for (const message of messages) {
    expect(message).toMatch(/^Invalid env (key|scope): /);
    expect(message).not.toContain(canary);
    expect(message).not.toContain("API_TOKEN=");
  }

  const repo = await createRepo();
  const write = setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: `API_TOKEN=${canary}`,
    value: canary,
    secret: true,
  });
  await expect(write).rejects.toThrow("Invalid env key: keys must match");
  const error = await write.catch((caught: unknown) => caught);
  expect(error instanceof Error ? error.message : "").not.toContain(canary);
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

test("resolveProjectEnvConfig decrypts only effective values after overlays", async () => {
  const repo = await createRepo();
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "stale-secret",
    secret: true,
  });
  await unlink(resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME));
  await writeFile(
    resolve(repo.projectDir, "hack.env.qa.yaml"),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  api:",
      "    SERVICE_TOKEN: overlay-plain",
      "",
    ].join("\n")
  );

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    serviceNames: ["api", "web"],
  });

  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe("overlay-plain");
});

test("resolveProjectEnvConfig merges shared and worktree-local overlays in order", async () => {
  const repo = await createRepo();

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    SHARED_DEFAULT: shared-default",
      "    SHARED_OVERRIDE: shared-default",
      "  api:",
      "    API_ONLY: shared-api",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.qa.yaml"),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    SHARED_OVERRIDE: shared-qa",
      "    SHARED_QA: shared-qa",
      "",
    ].join("\n")
  );
  await writeFile(
    resolveProjectEnvLocalConfigPath({
      projectDir: repo.projectDir,
      envName: null,
    }),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    LOCAL_DEFAULT: local-default",
      "    SHARED_OVERRIDE: local-default",
      "",
    ].join("\n")
  );
  await writeFile(
    resolveProjectEnvLocalConfigPath({
      projectDir: repo.projectDir,
      envName: "qa",
    }),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    LOCAL_QA: local-qa",
      "    SHARED_OVERRIDE: local-qa",
      "",
    ].join("\n")
  );

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    serviceNames: ["api", "web"],
  });

  expect(resolved).not.toBeNull();
  expect(resolved?.globalEnv).toMatchObject({
    SHARED_DEFAULT: "shared-default",
    SHARED_QA: "shared-qa",
    LOCAL_DEFAULT: "local-default",
    LOCAL_QA: "local-qa",
    SHARED_OVERRIDE: "local-qa",
  });
  expect(resolved?.serviceEnv.api?.API_ONLY).toBe("shared-api");
  expect(resolved?.files).toEqual([
    resolve(repo.projectDir, "hack.env.default.yaml"),
    resolve(repo.projectDir, "hack.env.qa.yaml"),
    resolve(repo.projectDir, "hack.env.local.yaml"),
    resolve(repo.projectDir, "hack.env.qa.local.yaml"),
  ]);
});

test("legacy tracked local overlay remains selectable without acting as a local default", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    SHARED_DEFAULT: shared-default",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.yaml"),
    [
      "version: 1",
      "environment: local",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    LEGACY_LOCAL: legacy-local",
      "",
    ].join("\n")
  );
  await runGit(["add", "."], repo.projectRoot);

  expect(
    await listProjectEnvOverlayNames({ projectDir: repo.projectDir })
  ).toEqual(["local"]);

  const defaultResolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });
  expect(defaultResolved).not.toBeNull();
  expect(defaultResolved?.globalEnv).toEqual({
    SHARED_DEFAULT: "shared-default",
  });
  expect(defaultResolved?.files).toEqual([
    resolve(repo.projectDir, "hack.env.default.yaml"),
  ]);

  const localResolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "local",
    serviceNames: ["api", "web"],
  });
  expect(localResolved).not.toBeNull();
  expect(localResolved?.globalEnv).toEqual({
    LEGACY_LOCAL: "legacy-local",
    SHARED_DEFAULT: "shared-default",
  });
  expect(localResolved?.files).toEqual([
    resolve(repo.projectDir, "hack.env.default.yaml"),
    resolve(repo.projectDir, "hack.env.local.yaml"),
  ]);
});

test("legacy local overlays stay out of default resolution when git is unavailable", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    SHARED_DEFAULT: shared-default",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.yaml"),
    [
      "version: 1",
      "environment: local",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    LEGACY_LOCAL: legacy-local",
      "",
    ].join("\n")
  );
  await runGit(["add", "."], repo.projectRoot);

  const originalPath = process.env.PATH;
  process.env.PATH = resolve(repo.tempRoot, "missing-git-bin");

  try {
    const defaultResolved = await resolveProjectEnvConfig({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceNames: ["api", "web"],
    });
    expect(defaultResolved?.globalEnv).toEqual({
      SHARED_DEFAULT: "shared-default",
    });
    expect(defaultResolved?.files).toEqual([
      resolve(repo.projectDir, "hack.env.default.yaml"),
    ]);
  } finally {
    restoreEnv("PATH", originalPath);
  }
});

test("default local overrides still resolve when git is unavailable", async () => {
  const repo = await createRepo();

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    SHARED_DEFAULT: shared-default",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    LOCAL_DEFAULT: local-default",
      "",
    ].join("\n")
  );

  const originalPath = process.env.PATH;
  process.env.PATH = resolve(repo.tempRoot, "missing-git-bin");

  try {
    const defaultResolved = await resolveProjectEnvConfig({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceNames: ["api", "web"],
    });
    expect(defaultResolved?.globalEnv).toEqual({
      LOCAL_DEFAULT: "local-default",
      SHARED_DEFAULT: "shared-default",
    });
    expect(defaultResolved?.files).toEqual([
      resolve(repo.projectDir, "hack.env.default.yaml"),
      resolve(repo.projectDir, "hack.env.local.yaml"),
    ]);
  } finally {
    restoreEnv("PATH", originalPath);
  }
});

test("legacy tracked local overlay keeps default local mutations in a compatibility file", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    SHARED_DEFAULT: shared-default",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.yaml"),
    [
      "version: 1",
      "environment: local",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    LEGACY_LOCAL: legacy-local",
      "",
    ].join("\n")
  );
  await runGit(["add", "."], repo.projectRoot);

  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "LOCAL_ONLY",
    value: "true",
    secret: false,
    local: true,
  });

  const compatLocalDefaultPath = resolve(
    repo.projectDir,
    "hack.env.default.local.yaml"
  );
  expect(await readFile(compatLocalDefaultPath, "utf8")).toContain(
    'LOCAL_ONLY: "true"'
  );
  expect(
    await readFile(resolve(repo.projectDir, "hack.env.local.yaml"), "utf8")
  ).toContain("LEGACY_LOCAL: legacy-local");
  expect(
    await readFile(resolve(repo.projectDir, "hack.env.local.yaml"), "utf8")
  ).not.toContain("LOCAL_ONLY");

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });
  expect(resolved?.globalEnv).toEqual({
    LOCAL_ONLY: "true",
    SHARED_DEFAULT: "shared-default",
  });
  expect(resolved?.files).toEqual([
    resolve(repo.projectDir, "hack.env.default.yaml"),
    compatLocalDefaultPath,
  ]);

  const unset = await unsetProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "LOCAL_ONLY",
    local: true,
  });
  expect(unset.changed).toBe(true);
  expect(await readFile(compatLocalDefaultPath, "utf8")).not.toContain(
    "LOCAL_ONLY"
  );
});

test("setProjectEnvValue writes worktree-local overrides when requested", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);

  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    scope: "global",
    key: "LOCAL_ONLY",
    value: "true",
    secret: false,
    local: true,
  });

  const localOverlayPath = resolveProjectEnvLocalConfigPath({
    projectDir: repo.projectDir,
    envName: "qa",
  });
  const localOverlay = await readFile(localOverlayPath, "utf8");
  expect(localOverlay).toContain('LOCAL_ONLY: "true"');

  const nestedIgnoreText = await readFile(
    resolve(repo.projectDir, ".gitignore"),
    "utf8"
  );
  expect(nestedIgnoreText).toContain("hack.env.local.yaml");
  expect(nestedIgnoreText).toContain("hack.env.*.local.yaml");

  const excludeText = await readFile(
    resolve(repo.projectRoot, ".git", "info", "exclude"),
    "utf8"
  );
  expect(excludeText).not.toContain("hack.env");
});

test("setProjectEnvValue writes local override ignore rules to the committed .hack/.gitignore in a linked worktree", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-project-env-ignore-"));
  tempDirs.add(sandbox);

  const sourceRoot = resolve(sandbox, "source");
  await mkdir(resolve(sourceRoot, ".hack"), { recursive: true });
  await initGitRepo(sourceRoot);
  await writeFile(resolve(sourceRoot, "README.md"), "worktree fixture\n");
  await writeFile(
    resolve(sourceRoot, ".hack", PROJECT_COMPOSE_FILENAME),
    "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(sourceRoot, ".hack", PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      { name: "linked-ignore-test", dev_host: "linked-ignore.hack" },
      null,
      2
    )}\n`
  );
  await runGit(["add", "README.md", ".hack"], sourceRoot);
  await runGit(["commit", "-m", "init"], sourceRoot);

  const linkedRoot = resolve(sandbox, "linked");
  await runGit(["worktree", "add", linkedRoot], sourceRoot);

  await setProjectEnvValue({
    projectRoot: linkedRoot,
    projectDir: resolve(linkedRoot, ".hack"),
    envName: "qa",
    scope: "global",
    key: "LOCAL_ONLY",
    value: "true",
    secret: false,
    local: true,
  });

  const nestedIgnoreText = await readFile(
    resolve(linkedRoot, ".hack", ".gitignore"),
    "utf8"
  );
  expect(nestedIgnoreText).toContain("hack.env.local.yaml");
  expect(nestedIgnoreText).toContain("hack.env.*.local.yaml");

  const commonDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    linkedRoot
  );
  const excludeText = await readFile(
    resolve(commonDir, "info", "exclude"),
    "utf8"
  );
  expect(excludeText).not.toContain("hack.env");
});

test("setProjectEnvValue --local keeps a read-only outdated .hack/.gitignore and warns instead of failing (HACK-1363)", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);
  const gitignore = resolve(repo.projectDir, ".gitignore");
  await writeFile(gitignore, "my-own-entry\n");
  await chmod(gitignore, 0o444);
  // Captured from process.stderr, not a logger spy: the warning must bypass
  // the UI logger (whose clack backend prints to stdout), and another file's
  // scoped logger mock in the same Bun process would hide a logger spy.
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await setProjectEnvValue({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      scope: "global",
      key: "LOCAL_ONLY",
      value: "true",
      secret: false,
      local: true,
    });

    const localOverlay = await readFile(
      resolveProjectEnvLocalConfigPath({
        projectDir: repo.projectDir,
        envName: null,
      }),
      "utf8"
    );
    expect(localOverlay).toContain('LOCAL_ONLY: "true"');
    expect(await readFile(gitignore, "utf8")).toBe("my-own-entry\n");
    expect((await lstat(gitignore)).mode & 0o777).toBe(0o444);
    expect(
      stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((chunk) => chunk.includes(".hack/.gitignore"))
    ).toEqual([`WARN: ${HACK_DIR_GITIGNORE_READ_ONLY_WARNING}\n`]);
  } finally {
    stderr.mockRestore();
    await chmod(gitignore, 0o644);
  }
});

test("materializeProjectEnv keeps .hack/.env out of git status through info/exclude", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "1",
    secret: false,
  });
  resetHackGitInfoExcludeCacheForTests();
  const exclude = resolve(repo.projectRoot, ".git", "info", "exclude");
  expect(await readFile(exclude, "utf8")).not.toContain("/.hack/.env");

  await materializeProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });

  expect(
    await Bun.file(resolve(repo.projectDir, PROJECT_ENV_FILENAME)).exists()
  ).toBe(true);
  const excludeText = await readFile(exclude, "utf8");
  expect(excludeText).toContain("/.hack/.env\n");
  expect(excludeText).toContain("/.hack/.env.state.json\n");
  expect(await Bun.file(resolve(repo.projectDir, ".gitignore")).exists()).toBe(
    false
  );
  const status = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    repo.projectRoot
  );
  expect(status.split("\n").sort()).toEqual([
    "?? .hack/docker-compose.yml",
    "?? .hack/hack.config.json",
    "?? .hack/hack.env.default.yaml",
  ]);
});

test("normal git clones keep generated env keys at the repo root", async () => {
  const repo = await createRepo();
  await initGitRepo(repo.projectRoot);

  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "secret-token",
    secret: true,
  });

  expect(
    await Bun.file(resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME)).exists()
  ).toBe(true);
  expect(
    await Bun.file(
      resolve(repo.projectRoot, ".git", PROJECT_ENV_KEY_FILENAME)
    ).exists()
  ).toBe(false);
});

test("linked worktrees fall back to the shared git-common-dir env key", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-project-env-worktree-"));
  tempDirs.add(sandbox);

  const sourceRoot = resolve(sandbox, "source");
  await mkdir(sourceRoot, { recursive: true });
  await initGitRepo(sourceRoot);
  await writeFile(resolve(sourceRoot, "README.md"), "worktree fixture\n");
  await runGit(["add", "README.md"], sourceRoot);
  await runGit(["commit", "-m", "init"], sourceRoot);

  const linkedRoot = resolve(sandbox, "linked");
  await runGit(["worktree", "add", linkedRoot], sourceRoot);

  const projectDir = resolve(linkedRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      { name: "linked-repo", dev_host: "linked.hack" },
      null,
      2
    )}\n`
  );

  await setProjectEnvValue({
    projectRoot: linkedRoot,
    projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "shared-worktree-secret",
    secret: true,
    local: false,
  });

  const currentKeyPath = resolve(linkedRoot, PROJECT_ENV_KEY_FILENAME);
  expect(await Bun.file(currentKeyPath).exists()).toBe(false);

  const currentGitDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    linkedRoot
  );
  const sharedKeyPath = resolve(currentGitDir, PROJECT_ENV_KEY_FILENAME);
  const sharedKeyText = (await readFile(sharedKeyPath, "utf8")).trim();
  expect(sharedKeyText.length).toBeGreaterThan(10);

  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  const resolved = await resolveProjectEnvConfig({
    projectRoot: linkedRoot,
    projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe(
    "shared-worktree-secret"
  );
});

test("resolveProjectEnvSharedKeyPath returns null when git is unavailable", async () => {
  const repo = await createRepo();
  const originalPath = process.env.PATH;
  process.env.PATH = resolve(repo.tempRoot, "missing-git-bin");

  try {
    await expect(
      resolveProjectEnvSharedKeyPath({
        projectRoot: repo.projectRoot,
      })
    ).resolves.toBeNull();
  } finally {
    restoreEnv("PATH", originalPath);
  }
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

test("primary checkout reads shared env key created by a linked worktree", async () => {
  const repo = await createRepo();
  await writeFile(
    resolve(repo.projectRoot, ".gitignore"),
    ".hack.secret.key\n"
  );

  await initializeGitRepo({ projectRoot: repo.projectRoot });
  const linkedRoot = resolve(repo.tempRoot, "repo-linked");
  await createGitWorktree({
    projectRoot: repo.projectRoot,
    worktreeRoot: linkedRoot,
    branch: "feature/shared-key-author",
  });

  await setProjectEnvValue({
    projectRoot: linkedRoot,
    projectDir: resolve(linkedRoot, ".hack"),
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "shared-from-linked-worktree",
    secret: true,
  });

  const primaryKeyPath = resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME);
  expect(await Bun.file(primaryKeyPath).exists()).toBe(false);

  const commonDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repo.projectRoot
  );
  const sharedKeyPath = resolve(commonDir, PROJECT_ENV_KEY_FILENAME);
  expect((await readFile(sharedKeyPath, "utf8")).trim().length).toBeGreaterThan(
    10
  );

  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    await readFile(
      resolve(linkedRoot, ".hack", "hack.env.default.yaml"),
      "utf8"
    )
  );

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api", "web"],
  });

  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe(
    "shared-from-linked-worktree"
  );
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

test("named overlay globals override base host and service values", async () => {
  const repo = await createRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    E2E_PLAIN: "base-global"',
      "  host:",
      '    E2E_PLAIN: "base-host"',
      "  api:",
      '    E2E_PLAIN: "base-api"',
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.qa.yaml"),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    E2E_PLAIN: "qa-global"',
      "",
    ].join("\n")
  );

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "qa",
    serviceNames: ["api", "web"],
  });
  if (!resolved) {
    throw new Error("Expected resolved env config.");
  }

  expect(resolved.serviceEnv.api?.E2E_PLAIN).toBe("qa-global");
  expect(
    selectProjectEnvValuesForExecutionTarget({
      resolved,
      scopeName: "global",
      target: "host",
    }).E2E_PLAIN
  ).toBe("qa-global");
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

async function createGitWorktree(opts: {
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly branch: string;
}): Promise<void> {
  await runGit(
    ["worktree", "add", "-b", opts.branch, opts.worktreeRoot],
    opts.projectRoot
  );
}

async function initializeGitRepo(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  await writeFile(resolve(opts.projectRoot, "README.md"), "# env test\n");
  await initGitRepo(opts.projectRoot);
  await runGit(["add", "."], opts.projectRoot);
  await runGit(["commit", "-m", "test: seed env fixture"], opts.projectRoot);
}

test.each([
  false,
  true,
])("legacy env mutation owners refuse native input without changing bytes (legacy conflict: %s)", async (legacy) => {
  const repo = await createRepo();
  const nativePath = join(repo.projectDir, "hack.project.json");
  const envPath = join(repo.projectDir, ".env");
  const contractPath = join(repo.projectDir, PROJECT_ENV_CONTRACT_FILENAME);
  await writeFile(nativePath, "{malformed native marker\n");
  await writeFile(envPath, "PUBLIC_FIXTURE=preserve\n");
  await writeFile(
    contractPath,
    JSON.stringify({
      version: 1,
      vars: [{ key: "PUBLIC_FIXTURE", source: "plain_env" }],
    })
  );
  if (!legacy) {
    await unlink(repo.composeFile);
    await unlink(repo.configFile);
  }
  const existingPaths = [
    nativePath,
    envPath,
    contractPath,
    ...(legacy ? [repo.composeFile, repo.configFile] : []),
  ];
  const before = await Promise.all(
    existingPaths.map(async (path) => ({ path, bytes: await readFile(path) }))
  );
  const mutation = {
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "PUBLIC_FIXTURE",
  };
  const operations = [
    () =>
      migrateLegacyProjectEnv({
        ...repo,
        projectName: "fixture",
        serviceNames: ["api"],
        materialize: true,
      }),
    () =>
      repairLegacyComposeEnvFileReferences({
        composeFile: repo.composeFile,
        projectDir: repo.projectDir,
      }),
    () =>
      setProjectEnvValue({
        ...mutation,
        value: "changed",
        secret: true,
        local: true,
      }),
    () => unsetProjectEnvValue(mutation),
    () => materializeProjectEnv({ ...repo, serviceNames: ["api"] }),
    () => ensureProjectEnvSecretKey({ projectRoot: repo.projectRoot }),
    () => ensureHackDirGitignore({ projectDir: repo.projectDir }),
    () =>
      removeLegacyProjectEnvArtifacts({
        projectRoot: repo.projectRoot,
        paths: [envPath, contractPath],
      }),
  ];
  for (const operation of operations) {
    await expect(operation()).rejects.toThrow(
      legacy ? "E_NATIVE_PROJECT_CONFLICT" : "E_NATIVE_PROJECT_UNSUPPORTED"
    );
    for (const file of before) {
      expect(await readFile(file.path)).toEqual(file.bytes);
    }
  }
  for (const path of [
    join(repo.projectRoot, PROJECT_ENV_KEY_FILENAME),
    join(repo.projectRoot, ".gitignore"),
    join(repo.projectDir, ".gitignore"),
    join(repo.projectDir, "hack.env.default.yaml"),
    join(repo.projectDir, PROJECT_ENV_STATE_FILENAME),
  ]) {
    expect(await Bun.file(path).exists()).toBe(false);
  }
});

test("Compose env repair rechecks native selection after reading the repair input", async () => {
  const repo = await createRepo();
  const contents = "services:\n  api:\n    env_file: .env\n";
  await writeFile(repo.composeFile, contents);
  await expect(
    repairLegacyComposeEnvFileReferences({
      projectDir: repo.projectDir,
      get composeFile() {
        writeFileSync(join(repo.projectDir, "hack.project.json"), "{}\n");
        return repo.composeFile;
      },
    })
  ).rejects.toThrow("E_NATIVE_PROJECT_CONFLICT");
  expect(await readFile(repo.composeFile, "utf8")).toBe(contents);
});

const ENVELOPE_KEY = "synthetic-envelope-key-for-tests-only";
const ENVELOPE_SENTINEL = "synthetic-envelope-plaintext-never-in-errors";

type EnvelopeParts = {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
};

/** Encrypts the sentinel with the real mutation owner and returns the v1 value. */
async function encryptedEnvelopeFixture(): Promise<{
  readonly repo: Awaited<ReturnType<typeof createRepo>>;
  readonly secure: string;
}> {
  const repo = await createRepo();
  await writeFile(
    resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME),
    `${ENVELOPE_KEY}\n`
  );
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: ENVELOPE_SENTINEL,
    secret: true,
  });
  const parsed: unknown = YAML.parse(
    await readFile(resolve(repo.projectDir, "hack.env.default.yaml"), "utf8")
  );
  const secure = (
    parsed as { values?: { global?: { TOKEN?: { secure?: unknown } } } }
  ).values?.global?.TOKEN?.secure;
  if (typeof secure !== "string") {
    throw new Error("missing synthetic envelope");
  }
  return { repo, secure };
}

function envelopeParts(secure: string): EnvelopeParts {
  const [, iv = "", tag = "", ciphertext = ""] = secure.split(":");
  return {
    iv: Buffer.from(iv, "base64"),
    tag: Buffer.from(tag, "base64"),
    ciphertext: Buffer.from(ciphertext, "base64"),
  };
}

function envelope(parts: EnvelopeParts): string {
  return [
    "v1",
    parts.iv.toString("base64"),
    parts.tag.toString("base64"),
    parts.ciphertext.toString("base64"),
  ].join(":");
}

async function writeSecureValue(opts: {
  readonly repo: Awaited<ReturnType<typeof createRepo>>;
  readonly secure: string;
}): Promise<void> {
  await writeFile(
    resolve(opts.repo.projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: { secure: opts.secure } } },
    })
  );
}

const ENVELOPE_MUTATIONS: ReadonlyArray<
  readonly [string, (secure: string) => string]
> = [
  ...[4, 8, 12].map(
    (bytes) =>
      [
        `${bytes}-byte tag`,
        (secure: string) => {
          const parts = envelopeParts(secure);
          return envelope({ ...parts, tag: parts.tag.subarray(0, bytes) });
        },
      ] as const
  ),
  [
    "16-byte IV",
    (secure) => {
      const parts = envelopeParts(secure);
      return envelope({
        ...parts,
        iv: Buffer.concat([parts.iv, Buffer.alloc(4)]),
      });
    },
  ],
  [
    "base64 with !",
    (secure) => {
      const [prefix, iv, tag, ciphertext = ""] = secure.split(":");
      return [prefix, iv, tag, `!${ciphertext.slice(1)}`].join(":");
    },
  ],
  [
    "base64 with whitespace",
    (secure) => {
      const [prefix, iv = "", tag, ciphertext] = secure.split(":");
      return [prefix, `${iv.slice(0, 4)} ${iv.slice(4)}`, tag, ciphertext].join(
        ":"
      );
    },
  ],
  [
    "truncated ciphertext",
    (secure) => {
      const parts = envelopeParts(secure);
      return envelope({
        ...parts,
        ciphertext: parts.ciphertext.subarray(0, -1),
      });
    },
  ],
  [
    "bit-flipped ciphertext",
    (secure) => {
      const parts = envelopeParts(secure);
      const ciphertext = Buffer.from(parts.ciphertext);
      ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
      return envelope({ ...parts, ciphertext });
    },
  ],
  [
    "oversized ciphertext",
    (secure) =>
      envelope({
        ...envelopeParts(secure),
        ciphertext: Buffer.alloc(1024 * 1024 + 1, 7),
      }),
  ],
];

for (const [name, mutate] of ENVELOPE_MUTATIONS) {
  test(`legacy secure env value with ${name} refuses with a fixed redacted error`, async () => {
    const { repo, secure } = await encryptedEnvelopeFixture();
    const mutated = mutate(secure);
    expect(mutated).not.toBe(secure);
    await writeSecureValue({ repo, secure: mutated });

    const error = await resolveProjectEnvConfig({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceNames: ["api"],
    }).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe("Invalid secure env value.");
    for (const privateText of [ENVELOPE_SENTINEL, ENVELOPE_KEY]) {
      expect(String(error)).not.toContain(privateText);
    }
  });
}

test("legacy secure env value with the wrong key refuses with the same fixed error", async () => {
  const { repo } = await encryptedEnvelopeFixture();
  await writeFile(
    resolve(repo.projectRoot, PROJECT_ENV_KEY_FILENAME),
    "synthetic-wrong-key\n"
  );
  await expect(
    resolveProjectEnvConfig({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      envName: null,
      serviceNames: ["api"],
    })
  ).rejects.toThrow("Invalid secure env value.");
});

test("legacy v1 secure values round-trip, including the empty value", async () => {
  const { repo } = await encryptedEnvelopeFixture();
  await setProjectEnvValue({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    scope: "global",
    key: "EMPTY",
    value: "",
    secret: true,
  });
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  expect(resolved?.globalEnv.TOKEN).toBe(ENVELOPE_SENTINEL);
  expect(resolved?.globalEnv.EMPTY).toBe("");
});

/** Byte bound shared by the legacy and native v1 ciphertext parsers. */
const ENVELOPE_CIPHERTEXT_LIMIT = 1024 * 1024;

/**
 * Seals plaintext exactly as the v1 owner does (AES-256-GCM, SHA-256 of the
 * trimmed key text, 16-byte tag) but with a caller-chosen IV length. Node and
 * Bun accept any non-empty GCM IV, so a refusal of these authentic envelopes
 * can only come from the parser's own IV and size guards, not from GCM
 * authentication.
 */
function sealProjectEnvValue(opts: {
  readonly plaintext: string;
  readonly ivBytes: number;
}): string {
  const key = nodeCrypto
    .createHash("sha256")
    .update(ENVELOPE_KEY, "utf8")
    .digest();
  const iv = nodeCrypto.randomBytes(opts.ivBytes);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([
    cipher.update(opts.plaintext, "utf8"),
    cipher.final(),
  ]);
  return envelope({ iv, tag: cipher.getAuthTag(), ciphertext });
}

type LegacyTokenOutcome =
  | { readonly value: string | undefined }
  | { readonly error: unknown };

async function resolveLegacyToken(opts: {
  readonly repo: Awaited<ReturnType<typeof createRepo>>;
}): Promise<LegacyTokenOutcome> {
  try {
    const resolved = await resolveProjectEnvConfig({
      projectRoot: opts.repo.projectRoot,
      projectDir: opts.repo.projectDir,
      envName: null,
      serviceNames: ["api"],
    });
    return { value: resolved?.globalEnv.TOKEN };
  } catch (error: unknown) {
    return { error };
  }
}

function expectFixedEnvelopeRefusal(outcome: LegacyTokenOutcome): void {
  const error = "error" in outcome ? outcome.error : null;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toBe(
    "Invalid secure env value."
  );
  for (const privateText of [ENVELOPE_SENTINEL, ENVELOPE_KEY]) {
    expect(String(error)).not.toContain(privateText);
  }
}

test("legacy test-sealed 12-byte-IV value at the ciphertext bound decrypts with the tag length pinned (control)", async () => {
  const { repo } = await encryptedEnvelopeFixture();
  const plaintext = `${ENVELOPE_SENTINEL}${"a".repeat(
    ENVELOPE_CIPHERTEXT_LIMIT - ENVELOPE_SENTINEL.length
  )}`;
  await writeSecureValue({
    repo,
    secure: sealProjectEnvValue({ plaintext, ivBytes: 12 }),
  });
  const decipher = spyOn(nodeCrypto, "createDecipheriv");
  try {
    const outcome = await resolveLegacyToken({ repo });
    expect("value" in outcome ? outcome.value : null).toBe(plaintext);
    // The tag length is pinned by option rather than left to the runtime default.
    expect(decipher).toHaveBeenCalled();
    for (const call of decipher.mock.calls) {
      const options: unknown = call[3];
      expect(options).toEqual({ authTagLength: 16 });
    }
  } finally {
    decipher.mockRestore();
  }
});

for (const ivBytes of [8, 16]) {
  test(`legacy authentic value sealed with a ${ivBytes}-byte IV refuses before decipher`, async () => {
    const { repo } = await encryptedEnvelopeFixture();
    await writeSecureValue({
      repo,
      secure: sealProjectEnvValue({ plaintext: ENVELOPE_SENTINEL, ivBytes }),
    });
    const decipher = spyOn(nodeCrypto, "createDecipheriv");
    try {
      expectFixedEnvelopeRefusal(await resolveLegacyToken({ repo }));
      expect(decipher).not.toHaveBeenCalled();
    } finally {
      decipher.mockRestore();
    }
  });
}

test("legacy authentic value one byte over the ciphertext bound refuses before decipher", async () => {
  const { repo } = await encryptedEnvelopeFixture();
  await writeSecureValue({
    repo,
    secure: sealProjectEnvValue({
      plaintext: "a".repeat(ENVELOPE_CIPHERTEXT_LIMIT + 1),
      ivBytes: 12,
    }),
  });
  const decipher = spyOn(nodeCrypto, "createDecipheriv");
  try {
    expectFixedEnvelopeRefusal(await resolveLegacyToken({ repo }));
    expect(decipher).not.toHaveBeenCalled();
  } finally {
    decipher.mockRestore();
  }
});

// Structural mutations must be refused by the explicit parser guards before any
// decipher exists, so the refusal does not depend on runtime GCM defaults.
for (const name of [
  "4-byte tag",
  "8-byte tag",
  "12-byte tag",
  "16-byte IV",
  "base64 with !",
  "base64 with whitespace",
  "oversized ciphertext",
]) {
  test(`legacy secure env value with ${name} refuses before decipher`, async () => {
    const mutate = ENVELOPE_MUTATIONS.find(([label]) => label === name)?.[1];
    if (!mutate) {
      throw new Error("missing envelope mutation");
    }
    const { repo, secure } = await encryptedEnvelopeFixture();
    await writeSecureValue({ repo, secure: mutate(secure) });
    const decipher = spyOn(nodeCrypto, "createDecipheriv");
    try {
      expectFixedEnvelopeRefusal(await resolveLegacyToken({ repo }));
      expect(decipher).not.toHaveBeenCalled();
    } finally {
      decipher.mockRestore();
    }
  });
}

test("legacy secure env value with a 16-byte tag of the wrong value refuses", async () => {
  const { repo, secure } = await encryptedEnvelopeFixture();
  const parts = envelopeParts(secure);
  const tag = Buffer.from(parts.tag);
  tag[15] = (tag[15] ?? 0) ^ 1;
  await writeSecureValue({ repo, secure: envelope({ ...parts, tag }) });
  expectFixedEnvelopeRefusal(await resolveLegacyToken({ repo }));
});
