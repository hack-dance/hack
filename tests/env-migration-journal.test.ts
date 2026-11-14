import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildDoctorRemediationPlanLines } from "../src/commands/doctor.ts";
import {
  applyEnvMigration,
  cleanupEnvMigration,
  type EnvMigrationProject,
  envMigrationJournalPath,
  migrateLegacyEnvForCommand,
  previewEnvCleanup,
  previewEnvMigration,
  recordEnvMigrationProjectRun,
  rollbackEnvMigration,
} from "../src/lib/env-migration.ts";
import { migrationDigest } from "../src/lib/env-migration-files.ts";
import { stageMigrationPayloads } from "../src/lib/env-migration-payloads.ts";
import { envMigrationSnapshots } from "../src/lib/env-migration-snapshot.ts";
import {
  LegacyEnvCleanupError,
  resolveProjectEnvConfig,
  resolveProjectEnvConfigForNativeSelection,
  resolveProjectEnvMetadata,
  resolveProjectEnvMetadataForNativeSelection,
  resolveProjectEnvSharedKeyLocation,
  resolveProjectEnvSharedKeyPath,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { withProjectsRegistryLock } from "../src/lib/projects-registry-lock.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureEnvSnapshots } from "./helpers/env-migration-fixture.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const SENTINEL = "synthetic-upgrade-journal-value";
const QA = "synthetic-upgrade-qa-value";
const isolated = [
  "HOME",
  "HACK_HOME",
  "HACK_ENV_SECRET_KEY",
  "HACK_SECRETS_FILE_KEY",
  "HACK_GLOBAL_CONFIG_PATH",
] as const;
let root = "";
let saved: (string | undefined)[] = [];
let project: EnvMigrationProject;
const commands = fixtureChildren("env-journal-command");

beforeEach(async () => {
  saved = isolated.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(join(tmpdir(), "env-journal-")));
  for (const key of isolated) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.HOME = join(root, "home");
  process.env.HACK_HOME = join(root, "hack-home");
  await mkdir(process.env.HOME);
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"journal"}\n');
  await writeFile(
    join(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "TOKEN", source: "plain_env" }],
    })
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n"
  );
  await writeFile(join(projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  await writeFile(join(projectDir, ".env.qa"), `TOKEN=${QA}\n`);
  project = {
    projectRoot,
    projectDir,
    projectName: "journal",
    serviceNames: ["api"],
  };
});

afterEach(async () => {
  await commands.stopAll();
  for (const [index, key] of isolated.entries()) {
    restoreEnv(key, saved[index]);
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

async function apply(input: Parameters<typeof applyEnvMigration>[0]) {
  const result = await applyEnvMigration(input);
  if (!result.manifestPath) {
    throw new Error("Fixture expected a snapshot-backed migration");
  }
  return { ...result, manifestPath: result.manifestPath };
}

async function projectFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const selected = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(selected);
      } else {
        files.set(selected, await readFile(selected, "base64"));
      }
    }
  };
  await visit(project.projectRoot);
  return files;
}

function expectRestored(
  actual: Map<string, string>,
  before: Map<string, string>
): void {
  for (const [path, text] of actual) {
    if (!before.has(path) && path.endsWith("/.hack-staging/.gitignore")) {
      expect(text).toBe(Buffer.from("*\n").toString("base64"));
      actual.delete(path);
    }
  }
  expect(actual).toEqual(before);
}

test("implicit migration resumes and readers find its journal through an aliased data home", async () => {
  const actualHome = join(root, "canonical-state");
  const alias = join(root, "state-link");
  await mkdir(actualHome, { mode: 0o700 });
  await symlink(actualHome, alias);
  process.env.HACK_HOME = join(alias, "not-created-yet");
  const preview = await previewEnvMigration(project);
  expect(await readdir(actualHome)).toEqual([]);
  await expect(
    applyEnvMigration({
      project,
      snapshots: envMigrationSnapshots(),
      acceptTrackedChanges: true,
      hooks: {
        boundary: async ({ phase }) => {
          if (phase === "prepared") {
            throw new Error("synthetic journal interruption");
          }
        },
      },
    })
  ).rejects.toThrow("synthetic journal interruption");
  await expect(
    resolveProjectEnvConfig({ ...project, envName: null })
  ).rejects.toThrow("unfinished");
  await migrateLegacyEnvForCommand({ ...project, materialize: false });
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.globalEnv
      .TOKEN
  ).toBe(SENTINEL);
  expect((await previewEnvMigration(project)).journalPath).toBe(
    preview.journalPath
  );
  const canonical = join(actualHome, "not-created-yet");
  process.env.HACK_HOME = canonical;
  expect((await previewEnvMigration(project)).journalPath).toBe(
    preview.journalPath
  );
});

for (const name of ["env-migrations", "upgrade"] as const) {
  test(`data-home alias support still refuses a planted ${name} symlink below that root`, async () => {
    const actualHome = join(root, "canonical-state");
    const alias = join(root, "state-link");
    const outside = join(root, "other-storage");
    await mkdir(actualHome, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(actualHome, alias);
    await symlink(outside, join(actualHome, name));
    process.env.HACK_HOME = alias;
    const before = await projectFiles();
    await expect(
      applyEnvMigration({
        project,
        snapshots: envMigrationSnapshots(),
        acceptTrackedChanges: true,
      })
    ).rejects.toThrow();
    expect(await projectFiles()).toEqual(before);
    expect(await readdir(outside)).toEqual([]);
  });
}

for (const kind of ["dangling", "file"] as const) {
  test(`an unresolved ${kind} data home refuses without writes or private diagnostics`, async () => {
    const path = join(root, "refused-home");
    if (kind === "dangling") {
      await symlink(join(root, "absent-target"), path);
    } else {
      await writeFile(path, SENTINEL);
    }
    process.env.HACK_HOME = path;
    const before = await projectFiles();
    const error = await previewEnvMigration(project).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain("cannot resolve its data home");
      expect(error.message).not.toContain(SENTINEL);
    }
    expect(await projectFiles()).toEqual(before);
  });
}

test("an already modern project without legacy inputs previews complete and applies without creating state", async () => {
  for (const name of ["hack.env.json", ".env", ".env.qa"]) {
    await rm(join(project.projectDir, name));
  }
  await writeFile(
    join(project.projectDir, "hack.env.default.yaml"),
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  const before = await projectFiles();
  const preview = await previewEnvMigration(project);
  expect(preview.status).toBe("complete");
  expect(preview.files).toEqual([]);
  const snapshots = {
    ...fixtureEnvSnapshots(root),
    capture: async (): Promise<{ manifestPath: string }> => {
      throw new Error("No-op must not create snapshots");
    },
  };
  expect(
    (
      await applyEnvMigration({
        project,
        snapshots,
        acceptTrackedChanges: false,
      })
    ).status
  ).toBe("already_complete");
  expect(await projectFiles()).toEqual(before);
  expect(await Bun.file(preview.journalPath).exists()).toBe(false);
});

for (const delivery of [
  "missing-base",
  "changed-base",
  "missing-overlay",
  "delivered",
] as const) {
  test(`first Compose repair verifies existing contract layers (${delivery})`, async () => {
    const compose = join(project.projectDir, "docker-compose.yml");
    await writeFile(
      compose,
      "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n"
    );
    const writeLayer = async (name: string, value: string | null) => {
      await writeFile(
        join(project.projectDir, `hack.env.${name}.yaml`),
        JSON.stringify({
          version: 1,
          environment: name,
          secretsprovider: "project_key",
          values: { global: value === null ? {} : { TOKEN: value } },
        })
      );
    };
    await writeLayer(
      "default",
      delivery === "missing-base"
        ? null
        : delivery === "changed-base"
          ? QA
          : SENTINEL
    );
    if (delivery !== "missing-overlay") {
      await writeLayer("qa", QA);
    }
    const before = await projectFiles();
    const composeBefore = await readFile(compose, "base64");
    const path = envMigrationJournalPath(project.projectRoot);
    if (delivery !== "delivered") {
      await expect(previewEnvMigration(project)).rejects.toThrow();
      await expect(
        applyEnvMigration({
          project,
          snapshots: envMigrationSnapshots(),
          acceptTrackedChanges: true,
        })
      ).rejects.toThrow();
      expect(await projectFiles()).toEqual(before);
      expect(await Bun.file(path).exists()).toBe(false);
      // Keeping Compose references is safe even before the layers deliver them.
      await migrateLegacyEnvForCommand({ ...project, materialize: false });
      expect(await readFile(compose, "base64")).toBe(composeBefore);
      expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
        `TOKEN=${SENTINEL}\n`
      );
      return;
    }
    const preview = await previewEnvMigration(project);
    expect(preview.files).toContainEqual(
      expect.objectContaining({ path: compose, action: "change" })
    );
    expect(JSON.stringify(preview)).not.toContain(SENTINEL);
    const snapshots = envMigrationSnapshots();
    const applied = await apply({
      project,
      snapshots,
      acceptTrackedChanges: true,
    });
    expect(await readFile(compose, "utf8")).not.toContain("env_file");
    expect(
      (await resolveProjectEnvConfig({ ...project, envName: null }))?.globalEnv
        .TOKEN
    ).toBe(SENTINEL);
    expect(
      (await resolveProjectEnvConfig({ ...project, envName: "qa" }))?.globalEnv
        .TOKEN
    ).toBe(QA);
    await rollbackEnvMigration({
      project,
      snapshots,
      manifestPath: applied.manifestPath,
    });
    expectRestored(await projectFiles(), before);
  });
}

test("preview makes no writes and exactly names what apply publishes; completed retry is a no-op", async () => {
  const before = await projectFiles();
  const preview = await previewEnvMigration(project);
  expect(await projectFiles()).toEqual(before);
  expect(await Bun.file(preview.journalPath).exists()).toBe(false);
  expect(preview.manifestPath).toBeNull();
  expect(JSON.stringify(preview)).not.toContain(SENTINEL);
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  await expect(
    cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("hack up");
  expect(result.status).toBe("applied");
  expect((await previewEnvMigration(project)).manifestPath).toBe(
    result.manifestPath
  );
  const after = await projectFiles();
  expect(
    [...after]
      .filter(([path, text]) => before.get(path) !== text)
      .map(([path]) => path)
      .sort()
  ).toEqual(
    preview.files
      .filter((file) => file.action !== "removable")
      .map((file) => file.path)
      .sort()
  );
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
    SENTINEL
  );
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.globalEnv
      .TOKEN
  ).toBe(SENTINEL);
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: "qa" }))?.globalEnv
      .TOKEN
  ).toBe(QA);
  const journal = await readFile(result.journalPath, "utf8");
  expect(
    (await readdir(dirname(result.journalPath))).filter((name) =>
      name.startsWith("payloads-")
    )
  ).toEqual([]);
  expect(journal).not.toContain(SENTINEL);
  expect(journal).not.toContain(QA);
  expect(await readFile(result.manifestPath, "utf8")).not.toContain(SENTINEL);
  expect(
    (
      await apply({
        project,
        snapshots,
        acceptTrackedChanges: true,
      })
    ).status
  ).toBe("already_complete");
  expect(await projectFiles()).toEqual(after);
  expect(await readFile(result.journalPath, "utf8")).toBe(journal);
});

test("journalled implicit migration keeps undeclared Compose overlay inputs; explicit repair still refuses their loss", async () => {
  const composePath = join(project.projectDir, "docker-compose.yml");
  const compose =
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env.staging\n";
  await writeFile(composePath, compose);
  const overlayPath = join(project.projectDir, ".env.staging");
  await writeFile(overlayPath, `UNDECLARED=${QA}\n`);
  const before = await projectFiles();
  // Explicit migration repairs Compose references, so it must still refuse
  // dropping an overlay value that the contract does not carry into layers.
  await expect(previewEnvMigration(project)).rejects.toThrow(".env.staging");
  expect(await projectFiles()).toEqual(before);
  const result = await migrateLegacyEnvForCommand({
    ...project,
    materialize: false,
  });
  expect(result.legacyDetected).toBe(true);
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
  expect(JSON.stringify(result)).not.toContain(QA);
  expect(await readFile(composePath, "utf8")).toBe(compose);
  expect(await readFile(overlayPath, "utf8")).toBe(`UNDECLARED=${QA}\n`);
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.globalEnv
      .TOKEN
  ).toBe(SENTINEL);
  expect(
    JSON.parse(
      await readFile(envMigrationJournalPath(project.projectRoot), "utf8")
    ).state
  ).toBe("complete");
  expect(await previewEnvMigration(project)).toMatchObject({
    status: "recovery_required",
    composeRepair: "unavailable",
    files: [],
  });
  await expect(
    applyEnvMigration({
      project,
      snapshots: envMigrationSnapshots(),
      acceptTrackedChanges: true,
    })
  ).rejects.toThrow(".env.staging");
  expect(await readFile(composePath, "utf8")).toBe(compose);
});

test("explicit migration after implicit completion previews only Compose repair and keeps one reversible journal", async () => {
  const composePath = join(project.projectDir, "docker-compose.yml");
  const compose =
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n";
  await writeFile(composePath, compose);
  const before = await projectFiles();
  await migrateLegacyEnvForCommand({ ...project, materialize: false });
  const journalPath = envMigrationJournalPath(project.projectRoot);
  const implicit = JSON.parse(await readFile(journalPath, "utf8"));
  const migrated = await projectFiles();
  const preview = await previewEnvMigration(project);
  expect(await projectFiles()).toEqual(migrated);
  expect(preview.status).toBe("ready");
  expect(preview.manifestPath).toBe(implicit.manifestPath);
  expect(preview.files.filter((file) => file.action !== "removable")).toEqual([
    { path: composePath, action: "change", keys: [], tracked: false },
  ]);
  expect(preview.files).toContainEqual({
    path: join(project.projectDir, ".env"),
    action: "removable",
    keys: [],
    tracked: false,
  });
  const snapshots = envMigrationSnapshots();
  const repaired = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  expect(repaired.status).toBe("applied");
  expect(repaired.manifestPath).toBe(implicit.manifestPath);
  const after = await projectFiles();
  expect(
    [...after]
      .filter(([path, text]) => migrated.get(path) !== text)
      .map(([path]) => path)
  ).toEqual([composePath]);
  expect(await readFile(composePath, "utf8")).not.toContain("env_file");
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
    SENTINEL
  );
  expect(JSON.stringify(preview)).not.toContain(SENTINEL);
  expect(await readFile(journalPath, "utf8")).not.toContain(SENTINEL);
  expect(
    (await apply({ project, snapshots, acceptTrackedChanges: true })).status
  ).toBe("already_complete");
  await recordEnvMigrationProjectRun(project);
  await cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true });
  expect(await Bun.file(join(project.projectDir, ".env")).exists()).toBe(false);
  await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: repaired.manifestPath,
  });
  expectRestored(await projectFiles(), before);
});

test("deferred repair preview and Doctor plan report unavailable legacy drift without changing or blocking current layers", async () => {
  await writeFile(
    join(project.projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n"
  );
  await migrateLegacyEnvForCommand({ ...project, materialize: false });
  await writeFile(join(project.projectDir, ".env"), `TOKEN=${QA}\n`);
  const before = await projectFiles();
  const path = envMigrationJournalPath(project.projectRoot);
  const journal = await readFile(path, "utf8");
  const preview = await previewEnvMigration(project);
  expect(preview).toMatchObject({
    status: "recovery_required",
    composeRepair: "unavailable",
    files: [],
  });
  expect(JSON.stringify(preview)).not.toContain(QA);
  const plan = await buildDoctorRemediationPlanLines({
    startDir: project.projectRoot,
    migrateEnvConfig: true,
  });
  expect(plan.some((line) => line.includes("Compose repair unavailable"))).toBe(
    true
  );
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.globalEnv
      .TOKEN
  ).toBe(SENTINEL);
  await expect(
    apply({
      project,
      snapshots: envMigrationSnapshots(),
      acceptTrackedChanges: true,
    })
  ).rejects.toThrow("input changed");
  expect(await projectFiles()).toEqual(before);
  expect(await readFile(path, "utf8")).toBe(journal);
});

test("deferred repair preview reads a keychain-backed store without copying its absent backend key or invalidating apply", async () => {
  await writeFile(
    join(project.projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n"
  );
  await writeFile(
    join(project.projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [
        { key: "TOKEN", source: "plain_env" },
        { key: "SEC", source: "keychain", services: ["api"] },
      ],
    })
  );
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "journal",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(project.projectRoot, "legacy-store.json"),
            keyPath: join(project.projectRoot, "legacy-backend.key"),
          },
        },
      },
    })
  );
  const result = await commands.run({
    cmd: [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures", "env-migration-keychain-worker.ts"),
    ],
    cwd: project.projectRoot,
    env: privateCliEnv({
      root,
      env: {
        HACK_HOME: join(root, "state"),
        HACK_NO_INTERACTIVE: "1",
        HACK_TEST_PROJECT_ROOT: project.projectRoot,
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: undefined,
        PATH: "/nonexistent",
      },
    }),
  });
  expect(result.stdout + result.stderr).not.toContain(SENTINEL);
  expect(result.stdout + result.stderr).not.toContain(
    "synthetic-deferred-repair-keychain"
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    previewStatus: "ready",
    unchangedAfterPreview: true,
    absentAfterPreview: true,
    absentAfterApply: true,
    applied: true,
    preserved: true,
    calls: { get: expect.any(Number), set: 0, delete: 0 },
  });
  expect(JSON.parse(result.stdout).calls.get).toBeGreaterThan(0);
});

test("explicit no-op clears deferred Compose repair after manual removal of references", async () => {
  const composePath = join(project.projectDir, "docker-compose.yml");
  await writeFile(
    composePath,
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n"
  );
  await migrateLegacyEnvForCommand({ ...project, materialize: false });
  await writeFile(composePath, "services: [unclosed\n");
  expect(await previewEnvMigration(project)).toMatchObject({
    status: "recovery_required",
    composeRepair: "unavailable",
  });
  await expect(
    apply({
      project,
      snapshots: envMigrationSnapshots(),
      acceptTrackedChanges: false,
    })
  ).rejects.toThrow("configuration");
  await writeFile(composePath, "services:\n  api:\n    image: alpine:3.22\n");
  const before = await projectFiles();
  expect((await previewEnvMigration(project)).status).toBe("complete");
  const result = await apply({
    project,
    snapshots: envMigrationSnapshots(),
    acceptTrackedChanges: false,
  });
  expect(result.status).toBe("already_complete");
  const journal = await readFile(result.journalPath, "utf8");
  expect(JSON.parse(journal).composeRepair).toBe("complete");
  expect(await projectFiles()).toEqual(before);
  expect(
    (
      await apply({
        project,
        snapshots: envMigrationSnapshots(),
        acceptTrackedChanges: false,
      })
    ).status
  ).toBe("already_complete");
  expect(await readFile(result.journalPath, "utf8")).toBe(journal);
});

test("later Compose repair accepts layer additions and tighter modes, invalidates old run proof and refuses lost values", async () => {
  await writeFile(
    join(project.projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n"
  );
  await migrateLegacyEnvForCommand({ ...project, materialize: false });
  await recordEnvMigrationProjectRun(project);
  const layer = join(project.projectDir, "hack.env.local.yaml");
  const original = await readFile(layer, "utf8");
  await writeFile(layer, original.replace(SENTINEL, "changed-synthetic-value"));
  expect(await previewEnvMigration(project)).toMatchObject({
    status: "recovery_required",
    composeRepair: "unavailable",
    files: [],
  });
  await expect(
    apply({
      project,
      snapshots: envMigrationSnapshots(),
      acceptTrackedChanges: true,
    })
  ).rejects.toThrow();
  const changedLayer = original.replace(
    "  global:\n",
    "  global:\n    EXTRA: additional-synthetic-value\n"
  );
  expect(changedLayer).not.toBe(original);
  await writeFile(layer, changedLayer);
  await chmod(join(project.projectDir, ".env"), 0o600);
  await chmod(join(project.projectDir, "docker-compose.yml"), 0o600);
  await apply({
    project,
    snapshots: envMigrationSnapshots(),
    acceptTrackedChanges: true,
  });
  expect(await readFile(layer, "utf8")).toBe(changedLayer);
  expect(
    (await lstat(join(project.projectDir, "docker-compose.yml"))).mode & 0o777
  ).toBe(0o600);
  await expect(
    cleanupEnvMigration({
      project,
      snapshots: envMigrationSnapshots(),
      acceptTrackedChanges: true,
    })
  ).rejects.toThrow("hack up");
  await recordEnvMigrationProjectRun(project);
  await cleanupEnvMigration({
    project,
    snapshots: envMigrationSnapshots(),
    acceptTrackedChanges: true,
  });
  expect(await Bun.file(join(project.projectDir, ".env")).exists()).toBe(false);
});

test("later Compose repair refuses damaged originals before changing the completed journal", async () => {
  const composePath = join(project.projectDir, "docker-compose.yml");
  await writeFile(
    composePath,
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n"
  );
  const snapshots = fixtureEnvSnapshots(root);
  const implicit = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
    repairCompose: false,
  });
  const manifest = JSON.parse(await readFile(implicit.manifestPath, "utf8"));
  const entry = manifest.files.find(
    (file: { path: string }) => file.path === composePath
  );
  const original = await readFile(entry.payload);
  await writeFile(entry.payload, "damaged synthetic original");
  const before = await projectFiles();
  const journal = await readFile(implicit.journalPath, "utf8");
  await expect(
    apply({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("coverage");
  expect(await projectFiles()).toEqual(before);
  expect(await readFile(implicit.journalPath, "utf8")).toBe(journal);
  await writeFile(entry.payload, original);
  expect(
    (await apply({ project, snapshots, acceptTrackedChanges: true })).status
  ).toBe("applied");
});

test("later Compose repair rechecks its read revision before publication and on resume", async () => {
  const composePath = join(project.projectDir, "docker-compose.yml");
  const compose =
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n";
  await writeFile(composePath, compose);
  const snapshots = fixtureEnvSnapshots(root);
  await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
    repairCompose: false,
  });
  const envPath = join(project.projectDir, ".env");
  const original = await readFile(envPath, "utf8");
  await expect(
    apply({
      project,
      snapshots,
      acceptTrackedChanges: true,
      hooks: {
        boundary: async ({ phase }) => {
          if (phase === "before_publish") {
            await writeFile(envPath, "TOKEN=changed-synthetic-value\n");
          }
        },
      },
    })
  ).rejects.toThrow("input changed");
  expect(await readFile(composePath, "utf8")).toBe(compose);
  await expect(
    apply({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("input changed");
  expect(await readFile(composePath, "utf8")).toBe(compose);
  await writeFile(envPath, original);
  expect(
    (await apply({ project, snapshots, acceptTrackedChanges: true })).status
  ).toBe("applied");
});

test("retry sweeps only receipted staging artifacts and retains unknown contents", async () => {
  const preview = await previewEnvMigration(project);
  await mkdir(dirname(preview.journalPath), { recursive: true, mode: 0o700 });
  const input = {
    journalPath: preview.journalPath,
    projectRoot: project.projectRoot,
    files: [{ text: SENTINEL, sha256: migrationDigest(Buffer.from(SENTINEL)) }],
  };
  const orphan = await stageMigrationPayloads(input);
  const kept = await stageMigrationPayloads(input);
  await writeFile(
    join(dirname(kept[0] ?? ""), "user-note"),
    "synthetic user note"
  );
  const result = await apply({
    project,
    snapshots: fixtureEnvSnapshots(root),
    acceptTrackedChanges: true,
  });
  expect(await Bun.file(orphan[0] ?? "").exists()).toBe(false);
  expect(await readFile(kept[0] ?? "", "utf8")).toBe(SENTINEL);
  expect(
    await readFile(join(dirname(kept[0] ?? ""), "user-note"), "utf8")
  ).toBe("synthetic user note");
  expect("payloadCleanup" in result && result.payloadCleanup).toBe("kept");
});

test("cleanup is explicit, rechecks delivery, and requires intact snapshot payloads", async () => {
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  await writeFile(
    join(project.projectDir, "hack.env.local.yaml"),
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    TOKEN: changed\n"
  );
  await recordEnvMigrationProjectRun(project);
  await expect(
    cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow();
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
    SENTINEL
  );
  expect(await Bun.file(result.manifestPath).exists()).toBe(true);
});

for (const change of [
  "permissions only",
  "changed bytes",
  "wider permissions",
] as const) {
  test(`cleanup after migration handles ${change} without adopting byte or access drift`, async () => {
    const envPath = join(project.projectDir, ".env");
    await chmod(envPath, 0o644);
    const snapshots = fixtureEnvSnapshots(root);
    const migrated = await apply({
      project,
      snapshots,
      acceptTrackedChanges: true,
    });
    await chmod(envPath, change === "wider permissions" ? 0o666 : 0o600);
    if (change === "changed bytes") {
      await writeFile(envPath, "TOKEN=changed-synthetic-value\n");
    }
    await recordEnvMigrationProjectRun(project);
    if (change !== "permissions only") {
      await expect(
        cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true })
      ).rejects.toThrow("input changed");
      expect(await Bun.file(envPath).exists()).toBe(true);
      expect(
        JSON.parse(await readFile(migrated.journalPath, "utf8")).state
      ).toBe("complete");
      return;
    }
    const result = await cleanupEnvMigration({
      project,
      snapshots,
      acceptTrackedChanges: true,
    });
    expect(result.removed).toContain(envPath);
    expect(await Bun.file(envPath).exists()).toBe(false);
    expect(
      (await resolveProjectEnvConfig({ ...project, envName: null }))?.globalEnv
        .TOKEN
    ).toBe(SENTINEL);
    await rollbackEnvMigration({
      project,
      snapshots,
      manifestPath: migrated.manifestPath,
    });
    expect(await readFile(envPath, "utf8")).toBe(`TOKEN=${SENTINEL}\n`);
    expect((await lstat(envPath)).mode & 0o777).toBe(0o644);
    expect(await readFile(migrated.journalPath, "utf8")).not.toContain(
      SENTINEL
    );
  });
}

test("rollback restores original bytes and refuses a later user edit", async () => {
  const before = await projectFiles();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  const target = join(project.projectDir, "hack.env.local.yaml");
  const original = await readFile(target, "utf8");
  await writeFile(target, `${original}\n# user edit\n`);
  await expect(
    rollbackEnvMigration({
      project,
      snapshots,
      manifestPath: result.manifestPath,
    })
  ).rejects.toThrow("changed target");
  await writeFile(target, original);
  await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
  });
  expectRestored(await projectFiles(), before);
});

test("a partial publication refuses implicit commands before they can use incomplete layers", async () => {
  await expect(
    apply({
      project,
      snapshots: fixtureEnvSnapshots(root),
      acceptTrackedChanges: true,
      hooks: {
        boundary: async ({ phase, index }) => {
          if (phase === "published" && index === 1) {
            throw new Error("synthetic interruption");
          }
        },
      },
    })
  ).rejects.toThrow("synthetic interruption");
  await expect(
    resolveProjectEnvConfig({ ...project, envName: null })
  ).rejects.toThrow("unfinished");
  expect((await previewEnvMigration(project)).manifestPath).toBeString();
  await expect(
    resolveProjectEnvMetadata({ ...project, envName: null })
  ).rejects.toThrow("unfinished");
  const native = {
    projectRoot: project.projectRoot,
    overlay: null,
    inheritLocal: false,
    declaredWorkloadNames: ["api"],
  };
  await expect(
    resolveProjectEnvConfigForNativeSelection(native)
  ).rejects.toThrow("unfinished");
  await expect(
    resolveProjectEnvMetadataForNativeSelection(native)
  ).rejects.toThrow("unfinished");
  for (const args of [
    ["env", "list"],
    ["env", "get", "TOKEN"],
    ["env", "exec", "--", "true"],
  ]) {
    const result = await commands.run({
      cmd: [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "..", "index.ts"),
        ...args,
        "--path",
        project.projectRoot,
      ],
      cwd: project.projectRoot,
      env: privateCliEnv({
        root,
        env: {
          HACK_HOME: process.env.HACK_HOME,
          HACK_NO_INTERACTIVE: "1",
          PATH: "/nonexistent",
        },
      }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      args[1] === "get"
        ? "Unable to read env value."
        : "An env migration is unfinished."
    );
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
  }
});

test("explicit preserve-changes rollback recovers from an edited pending migration and keeps the edited bytes privately", async () => {
  const snapshots = fixtureEnvSnapshots(root);
  await expect(
    apply({
      project,
      snapshots,
      acceptTrackedChanges: true,
      hooks: {
        boundary: async ({ phase }) => {
          if (phase === "verified") {
            throw new Error("synthetic interruption");
          }
        },
      },
    })
  ).rejects.toThrow("synthetic interruption");
  const result = JSON.parse(
    await readFile(envMigrationJournalPath(project.projectRoot), "utf8")
  );
  expect(result.state).toBe("applying");
  const edited = "version: 1\n# synthetic later user edit\n";
  const layer = join(project.projectDir, "hack.env.local.yaml");
  await writeFile(layer, edited);
  await expect(
    rollbackEnvMigration({
      project,
      snapshots,
      manifestPath: result.manifestPath,
    })
  ).rejects.toThrow("changed target");
  const restored = await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
    preserveChanges: true,
  });
  expect(restored.status).toBe("restored");
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
    SENTINEL
  );
  const payloads = (await readdir(dirname(result.manifestPath))).filter(
    (name) => name.startsWith("preserved-")
  );
  expect(
    await Promise.all(
      payloads.map((name) =>
        readFile(join(dirname(result.manifestPath), name), "utf8")
      )
    )
  ).toContain(edited);
});

test("a damaged journal names its recovery location without exposing its contents", async () => {
  const result = await apply({
    project,
    snapshots: fixtureEnvSnapshots(root),
    acceptTrackedChanges: true,
  });
  await writeFile(result.journalPath, SENTINEL);
  let failure: unknown;
  try {
    await resolveProjectEnvConfig({ ...project, envName: null });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) {
    throw new Error("Fixture expected damaged-journal refusal");
  }
  expect(failure.message).toContain(result.journalPath);
  expect(failure.message).toContain("Keep this file and the upgrade snapshots");
  expect(failure.message).not.toContain(SENTINEL);
});

test("incomplete rollback leaves its journal resumable and skips already restored files", async () => {
  const before = await projectFiles();
  const base = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots: base,
    acceptTrackedChanges: true,
  });
  let first = true;
  const snapshots = {
    ...base,
    rollback: async (input: Parameters<typeof base.rollback>[0]) => {
      if (!first) {
        return await base.rollback(input);
      }
      first = false;
      const index = input.expectedCurrent.findIndex((file) =>
        file.path.endsWith("hack.env.qa.yaml")
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const partial = await base.rollback({
        ...input,
        expectedCurrent: input.expectedCurrent.slice(0, index + 1),
      });
      return { ...partial, status: "incomplete" as const };
    },
  };
  expect(
    (
      await rollbackEnvMigration({
        project,
        snapshots,
        manifestPath: result.manifestPath,
      })
    ).status
  ).toBe("incomplete");
  expect(JSON.parse(await readFile(result.journalPath, "utf8")).state).toBe(
    "rolling_back"
  );
  expect(
    (
      await rollbackEnvMigration({
        project,
        snapshots,
        manifestPath: result.manifestPath,
      })
    ).status
  ).toBe("restored");
  expectRestored(await projectFiles(), before);
});

test("apply rechecks rollback state under the lock after observing a completed journal", async () => {
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  const before = await projectFiles();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const retry = applyEnvMigration({
    project,
    snapshots,
    acceptTrackedChanges: true,
    hooks: {
      beforeLock: async () => {
        reached.resolve();
        await release.promise;
      },
    },
  });
  await reached.promise;
  try {
    const interrupted = {
      ...snapshots,
      rollback: async () => ({ status: "incomplete" as const, results: [] }),
    };
    await rollbackEnvMigration({
      project,
      snapshots: interrupted,
      manifestPath: result.manifestPath,
    });
  } finally {
    release.resolve();
  }
  await expect(retry).rejects.toThrow("needs recovery");
  expect(await projectFiles()).toEqual(before);
});

test("cleanup snapshots must still hold every original; cleanup followed by rollback restores legacy files", async () => {
  const before = await projectFiles();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  await recordEnvMigrationProjectRun(project);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const entry = manifest.files.find(
    (file: { path: string }) => file.path === join(project.projectDir, ".env")
  );
  const original = await readFile(entry.payload);
  await writeFile(entry.payload, "damaged synthetic backup");
  await expect(
    cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("coverage");
  expect(await projectFiles()).not.toEqual(before);
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
    SENTINEL
  );
  await writeFile(entry.payload, original);
  await cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true });
  expect(await Bun.file(join(project.projectDir, ".env")).exists()).toBe(false);
  await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
  });
  expectRestored(await projectFiles(), before);
});

async function addLegacySecret() {
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "journal",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: "legacy-store.json", keyPath: "legacy.key" },
        },
      },
    })
  );
  await writeFile(
    join(project.projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [
        { key: "TOKEN", source: "plain_env" },
        { key: "SEC", source: "keychain", services: ["api"] },
      ],
    })
  );
  const store = await resolveSecretStore(project);
  await store.set({ key: "SEC", value: SENTINEL });
}

async function migrationFixtureGit(args: readonly string[]): Promise<void> {
  const result = await runFixtureGit({ cwd: project.projectRoot, args });
  expect(result.exitCode, result.stderr).toBe(0);
}

test("secret migration refuses a symlinked root ignore file even when its target lists the key", async () => {
  await addLegacySecret();
  await migrationFixtureGit(["init", "--quiet"]);
  const ignore = join(project.projectRoot, ".gitignore");
  const target = join(root, "ignore-target");
  await writeFile(target, ".hack.secret.key\n");
  await symlink(target, ignore);
  const before = await projectFiles();
  await expect(previewEnvMigration(project)).rejects.toThrow();
  await expect(
    applyEnvMigration({
      project,
      snapshots: fixtureEnvSnapshots(root),
      acceptTrackedChanges: true,
    })
  ).rejects.toThrow();
  expect(await projectFiles()).toEqual(before);
  expect((await lstat(ignore)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toBe(".hack.secret.key\n");
  expect(
    await Bun.file(join(project.projectRoot, ".hack.secret.key")).exists()
  ).toBe(false);
  expect(
    await Bun.file(envMigrationJournalPath(project.projectRoot)).exists()
  ).toBe(false);
});

test("key publication rechecks effective ignores after waiting for its lock and resumes after repair", async () => {
  await addLegacySecret();
  await migrationFixtureGit(["init", "--quiet"]);
  const ignore = join(project.projectRoot, ".gitignore");
  await writeFile(ignore, ".hack.secret.key\n");
  const keyPath = join(project.projectRoot, ".hack.secret.key");
  const preview = await previewEnvMigration(project);
  const keyIndex = preview.files.findIndex((file) => file.path === keyPath);
  const location = await resolveProjectEnvSharedKeyLocation(project);
  if (!location || keyIndex < 0) {
    throw new Error("Fixture expected key publication");
  }
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const holder = withProjectsRegistryLock({
    lockPath: `${location.path}.lock`,
    run: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  const snapshots = fixtureEnvSnapshots(root);
  const applying = applyEnvMigration({
    project,
    snapshots,
    acceptTrackedChanges: true,
    hooks: {
      boundary: async ({ phase, index }) => {
        if (phase === "before_publish" && index === keyIndex) {
          reached.resolve();
        }
      },
    },
  }).then(
    () => null,
    (error: unknown) => error
  );
  try {
    await Promise.race([
      reached.promise,
      applying.then(() => {
        throw new Error("Migration settled before key publication");
      }),
    ]);
    await writeFile(ignore, ".hack.secret.key\n!.hack.secret.key\n");
  } finally {
    release.resolve();
    await holder;
  }
  const error = await applying;
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toContain("ignored");
    expect(error.message).not.toContain(SENTINEL);
  }
  expect(await Bun.file(keyPath).exists()).toBe(false);
  expect(
    await Bun.file(join(project.projectDir, "hack.env.default.yaml")).exists()
  ).toBe(false);
  await writeFile(ignore, ".hack.secret.key\n");
  expect(
    (await apply({ project, snapshots, acceptTrackedChanges: true })).status
  ).toBe("applied");
  await migrationFixtureGit([
    "check-ignore",
    "--no-index",
    "--",
    ".hack.secret.key",
  ]);
  await migrationFixtureGit(["add", "--all"]);
  const tracked = await runFixtureGit({
    cwd: project.projectRoot,
    args: ["ls-files", "--", ".hack.secret.key"],
  });
  expect(tracked.stdout).toBe("");
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.serviceEnv
      .api?.SEC
  ).toBe(SENTINEL);
}, 20_000);

for (const trackedName of [".hack.secret.key", ".Hack.Secret.Key"]) {
  test(`secret migration refuses an absent key tracked as ${trackedName} before planning or writes`, async () => {
    await addLegacySecret();
    await migrationFixtureGit(["init", "--quiet"]);
    const keyPath = join(project.projectRoot, ".hack.secret.key");
    await writeFile(
      join(project.projectRoot, trackedName),
      "synthetic indexed placeholder\n"
    );
    await migrationFixtureGit(["add", "--force", "--", trackedName]);
    await rm(join(project.projectRoot, trackedName));
    const before = await projectFiles();
    await expect(previewEnvMigration(project)).rejects.toThrow("git-tracked");
    await expect(
      applyEnvMigration({
        project,
        snapshots: fixtureEnvSnapshots(root),
        acceptTrackedChanges: true,
      })
    ).rejects.toThrow("git-tracked");
    expect(await projectFiles()).toEqual(before);
    expect(await Bun.file(keyPath).exists()).toBe(false);
    expect(
      await Bun.file(envMigrationJournalPath(project.projectRoot)).exists()
    ).toBe(false);
  });

  test(`key publication rechecks ${trackedName} tracking after waiting for its lock and can resume after untracking`, async () => {
    await addLegacySecret();
    await migrationFixtureGit(["init", "--quiet"]);
    const keyPath = join(project.projectRoot, ".hack.secret.key");
    const preview = await previewEnvMigration(project);
    const keyIndex = preview.files.findIndex((file) => file.path === keyPath);
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    const location = await resolveProjectEnvSharedKeyLocation(project);
    if (!location) {
      throw new Error("Fixture expected a shared Git key lock");
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reachedKey = Promise.withResolvers<void>();
    const holder = withProjectsRegistryLock({
      lockPath: `${location.path}.lock`,
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const snapshots = fixtureEnvSnapshots(root);
    const applying = applyEnvMigration({
      project,
      snapshots,
      acceptTrackedChanges: true,
      hooks: {
        boundary: async ({ phase, index }) => {
          if (phase === "before_publish" && index === keyIndex) {
            reachedKey.resolve();
          }
        },
      },
    }).then(
      () => ({ kind: "unexpected-success" as const }),
      (error: unknown) => ({ kind: "refused" as const, error })
    );
    try {
      await Promise.race([
        reachedKey.promise,
        applying.then(() => {
          throw new Error("Migration settled before reaching key publication");
        }),
      ]);
      // The worktree returns to the planned absent state, but the index now
      // tracks that name while the actual key owner lock is still held.
      await writeFile(
        join(project.projectRoot, trackedName),
        "synthetic indexed placeholder\n"
      );
      await migrationFixtureGit(["add", "--force", "--", trackedName]);
      await rm(join(project.projectRoot, trackedName));
    } finally {
      release.resolve();
      await holder;
      await applying;
    }
    const result = await applying;
    if (!(result.kind === "refused" && result.error instanceof Error)) {
      throw new Error("Expected a tracked-key refusal after lock acquisition");
    }
    expect(result.error.message).toContain("git-tracked");
    expect(result.error.message).not.toContain(SENTINEL);
    expect(await Bun.file(keyPath).exists()).toBe(false);
    expect(
      await Bun.file(join(project.projectDir, "hack.env.default.yaml")).exists()
    ).toBe(false);
    await migrationFixtureGit(["rm", "--cached", "--force", "--", trackedName]);
    expect(
      (await apply({ project, snapshots, acceptTrackedChanges: true })).status
    ).toBe("applied");
    expect(
      (await resolveProjectEnvConfig({ ...project, envName: null }))?.serviceEnv
        .api?.SEC
    ).toBe(SENTINEL);
  }, 20_000);
}

test("fresh delivery refusal before unlink keeps migration complete and cleanup retryable", async () => {
  await addLegacySecret();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  await recordEnvMigrationProjectRun(project);
  const preview = await previewEnvCleanup(project);
  let failure: unknown;
  try {
    await cleanupEnvMigration({
      project,
      acceptTrackedChanges: true,
      snapshots: {
        ...snapshots,
        assertCoverage: async (input) => {
          await snapshots.assertCoverage(input);
          await setProjectEnvValue({
            ...project,
            envName: null,
            scope: "global",
            key: "TOKEN",
            value: QA,
            secret: false,
            local: true,
          });
        },
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LegacyEnvCleanupError);
  if (!(failure instanceof LegacyEnvCleanupError)) {
    throw new Error("Fixture expected a delivery refusal");
  }
  expect(failure.reason).toBe("changed");
  expect(failure.removedPaths).toEqual([]);
  expect(failure.message).toContain("--cleanup");
  expect(failure.message).not.toContain("--rollback-manifest");
  expect(failure.message).not.toContain("remove only copies");
  expect(failure.message).not.toContain(SENTINEL);
  expect(failure.message).not.toContain(QA);
  const journal = JSON.parse(await readFile(result.journalPath, "utf8"));
  expect(journal.state).toBe("complete");
  expect(journal.cleanupConfig).toBeUndefined();
  expect(journal.removed).toEqual([]);
  expect(
    (await readdir(dirname(result.journalPath))).filter((name) =>
      name.startsWith("payloads-")
    )
  ).toEqual([]);
  for (const file of preview.files.filter(
    (entry) => entry.action === "removable"
  )) {
    expect(await Bun.file(file.path).exists()).toBe(true);
  }
  expect(
    await readFile(join(project.projectDir, "hack.config.json"), "utf8")
  ).toContain("encryptedFile");
  await setProjectEnvValue({
    ...project,
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: SENTINEL,
    secret: false,
    local: true,
  });
  await recordEnvMigrationProjectRun(project);
  expect(
    (
      await cleanupEnvMigration({
        project,
        snapshots,
        acceptTrackedChanges: true,
      })
    ).status
  ).toBe("cleaned");
});

test("a failed cleanup receipt preserves confirmed removals and repairs the removed store pointer without exposing the cause", async () => {
  await addLegacySecret();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  await recordEnvMigrationProjectRun(project);
  const preview = await previewEnvCleanup(project);
  const expectedRemoved = preview.files
    .filter((file) => file.action === "removable")
    .map((file) => file.path)
    .sort();
  let failure: unknown;
  try {
    await cleanupEnvMigration({
      project,
      snapshots: {
        ...snapshots,
        recordAfter: () => Promise.reject(new Error(SENTINEL)),
      },
      acceptTrackedChanges: true,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LegacyEnvCleanupError);
  if (!(failure instanceof LegacyEnvCleanupError)) {
    throw new Error("Fixture expected a cleanup failure");
  }
  expect([...failure.removedPaths].sort()).toEqual(expectedRemoved);
  expect(failure.message).toContain("--rollback-manifest");
  expect(failure.message).toContain(result.manifestPath);
  expect(failure.message).not.toContain("remove only copies");
  expect(failure.message).not.toContain(SENTINEL);
  const journal = await readFile(result.journalPath, "utf8");
  expect(JSON.parse(journal).state).toBe("cleaning");
  expect(JSON.parse(journal).removed.sort()).toEqual(expectedRemoved);
  expect(journal).not.toContain(SENTINEL);
  for (const path of expectedRemoved) {
    expect(await Bun.file(path).exists()).toBe(false);
    expect(failure.message).toContain(JSON.stringify(path));
  }
  expect(
    await readFile(join(project.projectDir, "hack.config.json"), "utf8")
  ).not.toContain("encryptedFile");
  await expect(
    cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("interrupted");
  await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
  });
  for (const path of expectedRemoved) {
    expect(await Bun.file(path).exists()).toBe(true);
  }
  expect(
    await readFile(join(project.projectDir, "hack.config.json"), "utf8")
  ).toContain("encryptedFile");
});

test("preview does not provision a new project key; apply encrypts with a private key and rollback retains every legacy value", async () => {
  await addLegacySecret();
  const before = await projectFiles();
  const keyPath = join(project.projectRoot, ".hack.secret.key");
  const preview = await previewEnvMigration(project);
  expectRestored(await projectFiles(), before);
  expect(preview.files).toContainEqual({
    path: keyPath,
    action: "write",
    keys: [],
    tracked: false,
  });
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  expect((await lstat(keyPath)).mode & 0o777).toBe(0o600);
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.serviceEnv
      .api?.SEC
  ).toBe(SENTINEL);
  await recordEnvMigrationProjectRun(project);
  const cleanupBefore = await projectFiles();
  const cleanupPreview = await previewEnvCleanup(project);
  expect(await projectFiles()).toEqual(cleanupBefore);
  await cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true });
  const cleanupAfter = await projectFiles();
  const cleanupEffects = [...cleanupBefore]
    .filter(([path, text]) => cleanupAfter.get(path) !== text)
    .map(([path]) => path)
    .sort();
  expect(cleanupEffects).toEqual(
    cleanupPreview.files.map((file) => file.path).sort()
  );
  expect(
    await readFile(join(project.projectDir, "hack.config.json"), "utf8")
  ).not.toContain("encryptedFile");
  const restored = await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
  });
  expect("retained" in restored && restored.retained).toContain(keyPath);
  expect((await lstat(keyPath)).mode & 0o777).toBe(0o600);
  const after = await projectFiles();
  after.delete(keyPath);
  after.delete(join(project.projectRoot, ".gitignore"));
  expectRestored(after, before);
});

test("encrypted scoped values and store-only overlays survive; cleanup never removes their live project key", async () => {
  const keyPath = join(project.projectRoot, ".hack.secret.key");
  const keyText = "synthetic-upgrade-key-material";
  await writeFile(keyPath, `${keyText}\n`, { mode: 0o600 });
  await writeFile(
    join(project.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "journal",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: "legacy-store.json",
            keyPath: ".hack.secret.key",
          },
        },
      },
    })
  );
  await writeFile(
    join(project.projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [
        { key: "TOKEN", source: "plain_env" },
        { key: "SEC", source: "keychain", services: ["api"] },
      ],
    })
  );
  const store = await resolveSecretStore(project);
  await store.set({ key: "SEC", value: SENTINEL });
  await store.set({ key: "env.store-only.SEC", value: QA });
  const before = await projectFiles();
  const preview = await previewEnvMigration(project);
  expect(await projectFiles()).toEqual(before);
  expect(
    preview.files
      .filter((file) => file.action === "removable")
      .map((file) => file.path)
  ).not.toContain(keyPath);
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.serviceEnv
      .api?.SEC
  ).toBe(SENTINEL);
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: "store-only" }))
      ?.serviceEnv.api?.SEC
  ).toBe(QA);
  for (const path of [result.journalPath, result.manifestPath]) {
    const text = await readFile(path, "utf8");
    for (const value of [SENTINEL, QA, keyText]) {
      expect(text).not.toContain(value);
    }
  }
  await recordEnvMigrationProjectRun(project);
  await cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true });
  expect(await readFile(keyPath, "utf8")).toBe(`${keyText}\n`);
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: "store-only" }))
      ?.serviceEnv.api?.SEC
  ).toBe(QA);
});

test("rollback retains a new shared key used by another checkout", async () => {
  const primary = project;
  const git = async (args: readonly string[]) => {
    const result = await runFixtureGit({ cwd: primary.projectRoot, args });
    expect(result.exitCode, result.stderr).toBe(0);
  };
  await git(["init", "--quiet"]);
  await git([
    "add",
    ".hack/hack.config.json",
    ".hack/docker-compose.yml",
    ".hack/hack.env.json",
  ]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  const linked = join(root, "linked");
  await git(["worktree", "add", "--quiet", "-b", "migration-fixture", linked]);
  project = {
    ...primary,
    projectRoot: linked,
    projectDir: join(linked, ".hack"),
  };
  await writeFile(join(project.projectDir, ".env"), `TOKEN=${SENTINEL}\n`);
  await writeFile(join(project.projectDir, ".env.qa"), `TOKEN=${QA}\n`);
  await addLegacySecret();
  const shared = await resolveProjectEnvSharedKeyPath(project);
  expect(shared).toBeString();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await apply({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  const keyBefore = await readFile(shared ?? "", "utf8");
  await writeFile(
    join(primary.projectDir, "hack.env.default.yaml"),
    await readFile(join(project.projectDir, "hack.env.default.yaml"))
  );
  await setProjectEnvValue({
    ...primary,
    envName: null,
    scope: "global",
    key: "SIBLING",
    value: QA,
    secret: true,
    local: false,
  });
  expect(
    (await resolveProjectEnvConfig({ ...primary, envName: null }))?.globalEnv
      .SIBLING
  ).toBe(QA);
  await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
  });
  expect(await readFile(shared ?? "", "utf8")).toBe(keyBefore);
  expect(
    (await resolveProjectEnvConfig({ ...primary, envName: null }))?.globalEnv
      .SIBLING
  ).toBe(QA);
});

test("SIGKILL at every journal/publication boundary resumes without losing an overlay value", async () => {
  const composePath = join(project.projectDir, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  for (const scenario of ["plain", "repair", "encrypted"] as const) {
    await writeFile(
      composePath,
      scenario === "repair"
        ? `${originalCompose}    env_file: .env\n`
        : originalCompose
    );
    if (scenario === "encrypted") {
      await addLegacySecret();
    }
    const sources = await projectFiles();
    const preview = await previewEnvMigration({
      ...project,
      repairCompose: scenario !== "repair",
    });
    const count = preview.files.filter(
      (file) => file.action !== "removable"
    ).length;
    const boundaries = [
      "prepared:-1",
      ...Array.from(
        { length: scenario === "repair" ? 1 : count },
        (_, localIndex) => {
          const index = scenario === "repair" ? count : localIndex;
          return [
            `before_publish:${index}`,
            `published:${index}`,
            `recorded:${index}`,
          ];
        }
      ).flat(),
      "verified:-1",
      "complete:-1",
    ];
    // Each interruption owns a fresh HOME, data root, project and snapshot set.
    for (const boundary of boundaries) {
      const selected = join(
        root,
        `${scenario}-${boundary.replaceAll(":", "-")}`
      );
      const selectedProject = {
        ...project,
        projectRoot: join(selected, "project"),
        projectDir: join(selected, "project", ".hack"),
      };
      await mkdir(selectedProject.projectDir, { recursive: true });
      for (const [path, encoded] of sources) {
        const target = join(
          selectedProject.projectRoot,
          relative(project.projectRoot, path)
        );
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, Buffer.from(encoded, "base64"), {
          mode: (await lstat(path)).mode & 0o777,
        });
      }
      const dataHome = join(selected, "hack-home");
      if (scenario === "repair") {
        const previousHome = process.env.HACK_HOME;
        process.env.HACK_HOME = dataHome;
        try {
          await apply({
            project: selectedProject,
            snapshots: fixtureEnvSnapshots(selected),
            acceptTrackedChanges: true,
            repairCompose: false,
          });
        } finally {
          restoreEnv("HACK_HOME", previousHome);
        }
      }
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "helpers", "env-migration-child.ts"),
          selected,
          boundary,
        ],
        {
          env: privateCliEnv({ root: selected, env: { HACK_HOME: dataHome } }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = new Response(child.stderr).text();
      let output = "";
      let reached = false;
      try {
        const reader = child.stdout.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          output += new TextDecoder().decode(chunk.value);
          if (output.includes(`"phase":"${boundary.split(":")[0]}"`)) {
            reached = true;
            child.kill("SIGKILL");
            break;
          }
        }
        await child.exited;
        expect(reached, `${boundary}: ${await stderr}`).toBe(true);
        expect(output).not.toContain(SENTINEL);
        const previousHome = process.env.HACK_HOME;
        process.env.HACK_HOME = dataHome;
        try {
          await apply({
            project: selectedProject,
            snapshots: fixtureEnvSnapshots(selected),
            acceptTrackedChanges: true,
          });
          expect(
            (
              await resolveProjectEnvConfig({
                ...selectedProject,
                envName: null,
              })
            )?.globalEnv.TOKEN
          ).toBe(SENTINEL);
          expect(
            (
              await resolveProjectEnvConfig({
                ...selectedProject,
                envName: "qa",
              })
            )?.globalEnv.TOKEN
          ).toBe(QA);
          if (scenario === "encrypted") {
            expect(
              (
                await resolveProjectEnvConfig({
                  ...selectedProject,
                  envName: null,
                })
              )?.serviceEnv.api?.SEC
            ).toBe(SENTINEL);
          }
          expect(
            await readFile(join(selectedProject.projectDir, ".env"), "utf8")
          ).toContain(SENTINEL);
          if (scenario === "repair") {
            expect(
              await readFile(
                join(selectedProject.projectDir, "docker-compose.yml"),
                "utf8"
              )
            ).not.toContain("env_file");
          }
        } finally {
          restoreEnv("HACK_HOME", previousHome);
        }
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
        await stderr;
      }
    }
  }
}, 120_000);
