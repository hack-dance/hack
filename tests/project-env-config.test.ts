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
  PROJECT_ENV_STATE_FILENAME,
} from "../src/constants.ts";
import { upsertDotEnvValue } from "../src/lib/hack-env.ts";
import { readProjectDefaultEnvConfig } from "../src/lib/project.ts";
import {
  assertValidProjectEnvScopeName,
  ensureProjectEnvSecretKey,
  inspectLegacyComposeEnvFileReferences,
  inspectProjectEnvMaterialization,
  listProjectEnvOverlayNames,
  materializeProjectEnv,
  migrateLegacyProjectEnv,
  parseProjectEnvTarget,
  repairLegacyComposeEnvFileReferences,
  resolveProjectEnvConfig,
  resolveProjectEnvLocalConfigPath,
  resolveProjectEnvSharedKeyPath,
  selectProjectEnvValuesForExecutionTarget,
  setProjectEnvValue,
  unsetProjectEnvValue,
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

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
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
    process.env.PATH = originalPath;
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
    process.env.PATH = originalPath;
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

  process.env.HACK_ENV_SECRET_KEY = undefined;
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
    process.env.PATH = originalPath;
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
