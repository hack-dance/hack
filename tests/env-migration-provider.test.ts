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
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  applyEnvMigration,
  envMigrationJournalPath,
  recordEnvMigrationProjectRun,
} from "../src/lib/env-migration.ts";
import { bindEnvMigrationSnapshots } from "../src/lib/env-migration-snapshot.ts";
import { isRecord } from "../src/lib/guards.ts";
import { resolveProjectEnvConfig } from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import * as snapshotLibrary from "../src/lib/upgrade-snapshot.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const keys = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_ENV_SECRET_KEY",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
] as const;
const sentinel = "synthetic-provider-cli-sentinel";
const children = fixtureChildren("env-migration-provider");
const compiled = process.env.HACK_TEST_ENV_MIGRATION_BINARY;
// These cases run several real CLIs plus Doctor; hosted macOS exceeds Bun's
// five-second default. The test envelope also bounds child cleanup on refusal.
const DOCTOR_WORKFLOW_TIMEOUT_MS = 45_000;
let root = "";
let saved: (string | undefined)[] = [];

beforeEach(async () => {
  saved = keys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(join(tmpdir(), "env-provider-")));
  for (const key of keys) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.HOME = join(root, "home");
  process.env.HACK_HOME = join(root, "state");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  await mkdir(process.env.HOME, { mode: 0o700 });
});
afterEach(async () => {
  await children.stopAll();
  for (const [index, key] of keys.entries()) {
    restoreEnv(key, saved[index]);
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "provider",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: "legacy-store.json", keyPath: "legacy.key" },
        },
      },
    })
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [
        { key: "TOKEN", source: "plain_env" },
        { key: "SECRET", source: "keychain", services: ["api"] },
      ],
    })
  );
  await writeFile(join(projectDir, ".env"), `TOKEN=${sentinel}\n`);
  const project = {
    projectRoot,
    projectDir,
    projectName: "provider",
    serviceNames: ["api"],
  };
  await (await resolveSecretStore(project)).set({
    key: "SECRET",
    value: sentinel,
  });
  return project;
}

async function runMigrationCli(
  projectRoot: string,
  args: readonly string[],
  { json = true }: { readonly json?: boolean } = {}
) {
  return await runCliCommand(projectRoot, [
    "env",
    "migrate",
    "--path",
    projectRoot,
    ...(json ? ["--json"] : []),
    ...args,
  ]);
}

async function runCliCommand(
  projectRoot: string,
  args: readonly string[],
  storage?: { readonly home: string; readonly hackHome?: string }
) {
  if (compiled && !isAbsolute(compiled)) {
    throw new Error("Compiled test executable must be absolute");
  }
  const command = compiled
    ? [compiled]
    : [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "..", "index.ts"),
      ];
  const result = await children.run({
    cmd: [...command, ...args],
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      home: storage?.home ?? join(root, "home"),
      env: {
        HACK_HOME: storage ? storage.hackHome : join(root, "state"),
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        PATH: "/nonexistent",
      },
    }),
  });
  expect(result.stdout + result.stderr).not.toContain(sentinel);
  return result;
}

async function cli(projectRoot: string, args: readonly string[]) {
  const result = await runMigrationCli(projectRoot, args);
  const raw: unknown = JSON.parse(result.stdout);
  if (!(isRecord(raw) && typeof raw.ok === "boolean")) {
    throw new Error("Expected CLI result envelope");
  }
  if (raw.ok && !isRecord(raw.data)) {
    throw new Error("Expected migration result data");
  }
  return {
    ...result,
    envelope: {
      ok: raw.ok,
      data: isRecord(raw.data) ? raw.data : {},
      error: raw.error,
    },
  };
}

function pathField(data: Record<string, unknown>, name: string): string {
  const path = data[name];
  if (typeof path !== "string") {
    throw new Error("Expected migration metadata path");
  }
  return path;
}

for (const location of ["HOME", "HACK_HOME", "missing-child"] as const) {
  test(`production migration resolves an uncanonicalized ${location} alias for preview, apply, no-op and rollback`, async () => {
    const project = await fixture();
    const alias = join(root, "storage-alias");
    const target = join(root, "actual-storage");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias);
    const storage =
      location === "HOME"
        ? { home: alias }
        : {
            home: join(root, "home"),
            hackHome:
              location === "missing-child" ? join(alias, "new-data") : alias,
          };
    const actualHome =
      location === "HOME"
        ? join(target, ".hack")
        : location === "missing-child"
          ? join(target, "new-data")
          : target;
    const command = async (flags: readonly string[]) => {
      const result = await runCliCommand(
        project.projectRoot,
        ["env", "migrate", "--path", project.projectRoot, "--json", ...flags],
        storage
      );
      expect(result.exitCode, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    const preview = await command([]);
    expect(preview.status).toBe("ready");
    expect(preview.journalPath).toStartWith(`${actualHome}/env-migrations/`);
    expect(await readdir(target)).toEqual([]);
    const applied = await command(["--apply"]);
    expect(applied.status).toBe("applied");
    expect(applied.manifestPath).toStartWith(
      `${actualHome}/upgrade/snapshots/`
    );
    expect((await command(["--apply"])).status).toBe("already_complete");
    const rollback = await command([
      "--rollback-manifest",
      applied.manifestPath,
    ]);
    expect(rollback.status).toBe("restored");
    expect(
      await (await resolveSecretStore(project)).get({ key: "SECRET" })
    ).toBe(sentinel);
    expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
      sentinel
    );
  }, 45_000);
}

test("production CLI refuses first Compose repair when pre-existing layers do not deliver legacy contract values", async () => {
  const project = await fixture();
  const composePath = join(project.projectDir, "docker-compose.yml");
  const compose =
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n";
  const layerPath = join(project.projectDir, "hack.env.default.yaml");
  const layer =
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n";
  await writeFile(composePath, compose);
  await writeFile(layerPath, layer);
  const before = (await readdir(project.projectDir)).sort();
  for (const args of [[], ["--apply"]]) {
    const result = await cli(project.projectRoot, args);
    expect(result.exitCode).toBe(1);
    expect(result.envelope.ok).toBe(false);
    expect(await readFile(composePath, "utf8")).toBe(compose);
    expect(await readFile(layerPath, "utf8")).toBe(layer);
    expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
      `TOKEN=${sentinel}\n`
    );
    expect((await readdir(project.projectDir)).sort()).toEqual(before);
    expect(
      await Bun.file(envMigrationJournalPath(project.projectRoot)).exists()
    ).toBe(false);
  }
});

test("production CLI explicitly repairs Compose after implicit env exec, then rolls the whole migration back", async () => {
  const project = await fixture();
  const composePath = join(project.projectDir, "docker-compose.yml");
  const compose =
    "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n";
  await writeFile(composePath, compose);
  const implicit = await runCliCommand(project.projectRoot, [
    "env",
    "exec",
    "--path",
    project.projectRoot,
    "--",
    "/usr/bin/true",
  ]);
  expect(implicit.exitCode, implicit.stderr).toBe(0);
  expect(await readFile(composePath, "utf8")).toBe(compose);
  const preview = await cli(project.projectRoot, []);
  expect(preview.exitCode, preview.stderr).toBe(0);
  expect(preview.envelope.data.status).toBe("ready");
  expect(preview.envelope.data.files).toContainEqual({
    path: composePath,
    action: "change",
    keys: [],
    tracked: false,
  });
  const applied = await cli(project.projectRoot, ["--apply"]);
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(applied.envelope.data.status).toBe("applied");
  expect(await readFile(composePath, "utf8")).not.toContain("env_file");
  const repeated = await cli(project.projectRoot, ["--apply"]);
  expect(repeated.envelope.data.status).toBe("already_complete");
  const rollback = await cli(project.projectRoot, [
    "--rollback-manifest",
    pathField(applied.envelope.data, "manifestPath"),
  ]);
  expect(rollback.exitCode, rollback.stderr).toBe(0);
  expect(await readFile(composePath, "utf8")).toBe(compose);
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
    sentinel
  );
  expect(await (await resolveSecretStore(project)).get({ key: "SECRET" })).toBe(
    sentinel
  );
});

test(
  "production cleanup accepts Doctor permission tightening while preserving original rollback bytes",
  async () => {
    const project = await fixture();
    const envPath = join(project.projectDir, ".env");
    await chmod(envPath, 0o644);
    expect((await lstat(envPath)).mode & 0o777).toBe(0o644);
    const migrated = await cli(project.projectRoot, ["--apply"]);
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    const doctor = await runCliCommand(project.projectRoot, [
      "doctor",
      "--fix",
      "--path",
      project.projectRoot,
    ]);
    // The fixture intentionally has no Docker or other host tooling; hygiene still runs.
    expect(doctor.exitCode).toBe(1);
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(envPath, "utf8")).toBe(`TOKEN=${sentinel}\n`);
    await recordEnvMigrationProjectRun(project);
    const cleaned = await cli(project.projectRoot, ["--cleanup", "--apply"]);
    expect(cleaned.exitCode, cleaned.stderr).toBe(0);
    expect(await Bun.file(envPath).exists()).toBe(false);
    const rollback = await cli(project.projectRoot, [
      "--rollback-manifest",
      pathField(migrated.envelope.data, "manifestPath"),
    ]);
    expect(rollback.exitCode, rollback.stderr).toBe(0);
    expect(rollback.envelope.data.warnings).toContainEqual(
      expect.stringContaining("original file permissions")
    );
    expect(await readFile(envPath, "utf8")).toBe(`TOKEN=${sentinel}\n`);
  },
  DOCTOR_WORKFLOW_TIMEOUT_MS
);

test(
  "production rollback accepts a byte-identical tighter mode before cleanup and reports original-mode review",
  async () => {
    const project = await fixture();
    const envPath = join(project.projectDir, ".env");
    await chmod(envPath, 0o644);
    const migrated = await cli(project.projectRoot, ["--apply"]);
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    await runCliCommand(project.projectRoot, [
      "doctor",
      "--fix",
      "--path",
      project.projectRoot,
    ]);
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600);
    const rollback = await cli(project.projectRoot, [
      "--rollback-manifest",
      pathField(migrated.envelope.data, "manifestPath"),
    ]);
    expect(rollback.exitCode, rollback.stderr).toBe(0);
    expect(rollback.envelope.data.warnings).toContainEqual(
      expect.stringContaining("original file permissions")
    );
    expect(await readFile(envPath, "utf8")).toBe(`TOKEN=${sentinel}\n`);
  },
  DOCTOR_WORKFLOW_TIMEOUT_MS
);

test(
  "production previews report deferred repair unavailable without failing, printing drift values or changing files",
  async () => {
    const project = await fixture();
    const composePath = join(project.projectDir, "docker-compose.yml");
    const compose =
      "services:\n  api:\n    image: alpine:3.22\n    env_file: .env\n";
    await writeFile(composePath, compose);
    const implicit = await runCliCommand(project.projectRoot, [
      "env",
      "exec",
      "--path",
      project.projectRoot,
      "--",
      "/usr/bin/true",
    ]);
    expect(implicit.exitCode, implicit.stderr).toBe(0);
    const drift = "synthetic-drift-preview-value";
    const envPath = join(project.projectDir, ".env");
    await writeFile(envPath, `TOKEN=${drift}\n`);
    const journalPath = envMigrationJournalPath(project.projectRoot);
    const journal = await readFile(journalPath, "utf8");
    for (const json of [true, false]) {
      const result = await runMigrationCli(project.projectRoot, [], { json });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain(drift);
      const parsed = JSON.parse(result.stdout);
      expect(json ? parsed.data : parsed).toMatchObject({
        status: "recovery_required",
        composeRepair: "unavailable",
        files: [],
      });
    }
    const doctor = await runCliCommand(project.projectRoot, [
      "doctor",
      "--migrate-env-config",
      "--path",
      project.projectRoot,
    ]);
    expect(doctor.stdout + doctor.stderr).toContain(
      "Compose repair unavailable"
    );
    expect(doctor.stdout + doctor.stderr).not.toContain(
      "Env migration input changed"
    );
    expect(doctor.stdout + doctor.stderr).not.toContain(drift);
    const refused = await cli(project.projectRoot, ["--apply"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).not.toContain(drift);
    expect(await readFile(journalPath, "utf8")).toBe(journal);
    expect(await readFile(envPath, "utf8")).toBe(`TOKEN=${drift}\n`);
    expect(await readFile(composePath, "utf8")).toBe(compose);
  },
  DOCTOR_WORKFLOW_TIMEOUT_MS
);

for (const damage of ["manifest", "missing-blob", "changed-blob"] as const) {
  test(`resumed production apply refuses ${damage} damage before another publication`, async () => {
    const project = await fixture();
    await expect(
      applyEnvMigration({
        project,
        snapshots: bindEnvMigrationSnapshots(snapshotLibrary),
        acceptTrackedChanges: true,
        hooks: {
          boundary: async ({ phase }) => {
            if (phase === "prepared") {
              throw new Error("synthetic prepared interruption");
            }
          },
        },
      })
    ).rejects.toThrow("synthetic prepared interruption");
    const journalPath = envMigrationJournalPath(project.projectRoot);
    const journal: unknown = JSON.parse(await readFile(journalPath, "utf8"));
    if (!isRecord(journal)) {
      throw new Error("Expected interrupted migration journal");
    }
    const manifestPath = pathField(journal, "manifestPath");
    const loaded = await snapshotLibrary.readUpgradeSnapshot({ manifestPath });
    if (loaded.status !== "ok") {
      throw new Error("Expected intact initial snapshot");
    }
    const original = loaded.snapshot.manifest.entries.find(
      (entry) => entry.path === join(project.projectDir, "hack.config.json")
    );
    if (original?.before.kind !== "file") {
      throw new Error("Expected config original in snapshot");
    }
    const damaged =
      damage === "manifest"
        ? manifestPath
        : join(loaded.snapshot.dir, "blobs", original.before.sha256);
    const bytes = await readFile(damaged);
    if (damage === "changed-blob") {
      await writeFile(damaged, "synthetic damaged snapshot payload", {
        mode: 0o600,
      });
    } else {
      await rm(damaged);
    }
    const paths = (
      await readdir(project.projectRoot, { recursive: true })
    ).sort();
    const before = await Promise.all(
      paths.map(async (name) => {
        const path = join(project.projectRoot, name);
        return (await lstat(path)).isFile() ? await readFile(path) : null;
      })
    );
    const journalBefore = await readFile(journalPath);
    const result = await cli(project.projectRoot, [
      "--apply",
      "--accept-tracked-env-changes",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(
      (await readdir(project.projectRoot, { recursive: true })).sort()
    ).toEqual(paths);
    for (const [index, name] of paths.entries()) {
      const expected = before[index];
      if (expected) {
        expect(
          (await readFile(join(project.projectRoot, name))).equals(expected)
        ).toBe(true);
      }
    }
    expect((await readFile(journalPath)).equals(journalBefore)).toBe(true);
    await writeFile(damaged, bytes, { mode: 0o600 });
    const resumed = await cli(project.projectRoot, [
      "--apply",
      "--accept-tracked-env-changes",
    ]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.envelope.data.status).toBe("applied");
    expect(
      (await resolveProjectEnvConfig({ ...project, envName: null }))?.serviceEnv
        .api?.SECRET
    ).toBe(sentinel);
  });
}

test("production snapshot provider backs source CLI apply, no-op and guarded rollback", async () => {
  const project = await fixture();
  const preview = await cli(project.projectRoot, []);
  expect(preview.exitCode, preview.stderr).toBe(0);
  const applied = await cli(project.projectRoot, [
    "--apply",
    "--accept-tracked-env-changes",
  ]);
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(applied.envelope).toMatchObject({
    ok: true,
    data: { status: "applied" },
  });
  const data = applied.envelope.data;
  const manifestPath = pathField(data, "manifestPath");
  for (const path of [manifestPath, pathField(data, "journalPath")]) {
    expect(await readFile(path, "utf8")).not.toContain(sentinel);
  }
  expect(
    (await resolveProjectEnvConfig({ ...project, envName: null }))?.serviceEnv
      .api?.SECRET
  ).toBe(sentinel);
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
    `TOKEN=${sentinel}\n`
  );
  expect(
    (
      await cli(project.projectRoot, [
        "--apply",
        "--accept-tracked-env-changes",
      ])
    ).envelope
  ).toMatchObject({ ok: true, data: { status: "already_complete" } });
  const cleanup = await cli(project.projectRoot, [
    "--cleanup",
    "--apply",
    "--accept-tracked-env-changes",
  ]);
  expect(cleanup.exitCode).not.toBe(0);
  expect(JSON.stringify(cleanup.envelope)).toContain("hack up");
  const rolled = await cli(project.projectRoot, [
    "--rollback-manifest",
    manifestPath,
  ]);
  expect(rolled.exitCode, rolled.stderr).toBe(0);
  expect(rolled.envelope).toMatchObject({
    ok: true,
    data: { status: "restored" },
  });
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
    `TOKEN=${sentinel}\n`
  );
});

for (const json of [true, false]) {
  test(`incomplete production rollback exits 1 with details (${json ? "JSON" : "plain"})`, async () => {
    const project = await fixture();
    const applied = await cli(project.projectRoot, [
      "--apply",
      "--accept-tracked-env-changes",
    ]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    const manifestPath = pathField(applied.envelope.data, "manifestPath");
    const journalPath = pathField(applied.envelope.data, "journalPath");
    // A real malformed provider work directory refuses restoration on every
    // platform, including root. No permission-based skip or mock is needed.
    const blocked = join(dirname(manifestPath), "staging");
    const marker = "synthetic restore-work-directory blocker";
    await writeFile(blocked, marker, { mode: 0o600 });
    const incomplete = await runMigrationCli(
      project.projectRoot,
      ["--rollback-manifest", manifestPath],
      { json }
    );
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.stdout + incomplete.stderr).not.toContain(marker);
    const raw: unknown = JSON.parse(incomplete.stdout);
    const data = json && isRecord(raw) ? raw.data : raw;
    if (!isRecord(data)) {
      throw new Error("Expected rollback restoration details");
    }
    expect(data.status).toBe("incomplete");
    expect(data.results).toContainEqual(
      expect.objectContaining({ status: "error" })
    );
    expect(JSON.parse(await readFile(journalPath, "utf8")).state).toBe(
      "rolling_back"
    );
    await expect(
      resolveProjectEnvConfig({ ...project, envName: null })
    ).rejects.toThrow("unfinished");
    await rm(blocked);
    const restored = await cli(project.projectRoot, [
      "--rollback-manifest",
      manifestPath,
    ]);
    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(restored.envelope.data.status).toBe("restored");
    expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
      `TOKEN=${sentinel}\n`
    );
  });
}

test("production rollback maps preserved edits to retrievable private files without printing them", async () => {
  const project = await fixture();
  const applied = await cli(project.projectRoot, [
    "--apply",
    "--accept-tracked-env-changes",
  ]);
  expect(applied.exitCode, applied.stderr).toBe(0);
  const layer = join(project.projectDir, "hack.env.local.yaml");
  const edited = `version: 1\n# ${sentinel}\n`;
  await writeFile(layer, edited);
  const manifest = pathField(applied.envelope.data, "manifestPath");
  expect(
    (await cli(project.projectRoot, ["--rollback-manifest", manifest])).exitCode
  ).not.toBe(0);
  const recovered = await cli(project.projectRoot, [
    "--rollback-manifest",
    manifest,
    "--preserve-changes",
  ]);
  expect(recovered.exitCode, recovered.stderr).toBe(0);
  const preserved = recovered.envelope.data.preserved;
  if (!Array.isArray(preserved)) {
    throw new Error("Expected preserved-file mapping");
  }
  const file: unknown = preserved.find(
    (entry: unknown) => isRecord(entry) && entry.path === layer
  );
  if (!isRecord(file)) {
    throw new Error("Expected retained edit path");
  }
  expect(await readFile(pathField(file, "backupPath"), "utf8")).toBe(edited);
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
    `TOKEN=${sentinel}\n`
  );
});

test("apply refuses cross-filesystem snapshot storage before any project publication", async () => {
  const sharedMemory = await lstat("/dev/shm").catch(() => null);
  if (!sharedMemory || sharedMemory.dev === (await lstat(root)).dev) {
    return; // This host has no second filesystem; Linux CI exercises the boundary.
  }
  const snapshotRoot = await mkdtemp(join("/dev/shm", "env-snapshot-"));
  try {
    const project = await fixture();
    const before = await readFile(join(project.projectDir, ".env"));
    const snapshots = bindEnvMigrationSnapshots({
      ...snapshotLibrary,
      defaultUpgradeSnapshotRoot: () => snapshotRoot,
    });
    await expect(
      applyEnvMigration({ project, snapshots, acceptTrackedChanges: true })
    ).rejects.toThrow("same filesystem");
    expect(
      (await readFile(join(project.projectDir, ".env"))).equals(before)
    ).toBe(true);
    expect(
      await Bun.file(join(project.projectDir, "hack.env.default.yaml")).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(project.projectRoot, ".hack.secret.key")).exists()
    ).toBe(false);
    expect(await readdir(snapshotRoot)).toEqual([]);
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
});

for (const code of ["EXDEV", "EPERM"]) {
  test(`apply refuses a same-device restore link failure (${code}) before publication`, async () => {
    const project = await fixture();
    const names = (
      await readdir(project.projectRoot, { recursive: true })
    ).sort();
    let probed = false;
    let captures = 0;
    const snapshots = bindEnvMigrationSnapshots(
      {
        ...snapshotLibrary,
        createUpgradeSnapshot: (input) => {
          captures++;
          return snapshotLibrary.createUpgradeSnapshot(input);
        },
      },
      {
        linkRestoreProbe: async (source, destination) => {
          // Unlike the second-filesystem case, admission reached the real link
          // boundary after proving matching devices and creating an empty probe.
          expect((await lstat(source)).dev).toBe(
            (await lstat(project.projectRoot)).dev
          );
          expect((await readFile(source)).length).toBe(0);
          expect(String(destination)).toContain(".hack-env-restore-probe-");
          probed = true;
          throw Object.assign(new Error("synthetic link refusal"), { code });
        },
      }
    );
    await expect(
      applyEnvMigration({ project, snapshots, acceptTrackedChanges: true })
    ).rejects.toThrow("same filesystem and mount");
    expect(probed).toBe(true);
    expect(captures).toBe(0);
    expect(
      (await readdir(project.projectRoot, { recursive: true })).sort()
    ).toEqual(names);
    expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
      `TOKEN=${sentinel}\n`
    );
    expect(
      (await readdir(process.env.HACK_HOME ?? "", { recursive: true })).some(
        (name) => name.includes(".hack-env-restore-probe-")
      )
    ).toBe(false);
    expect(await snapshotLibrary.listUpgradeSnapshots()).toEqual([]);
  });
}

test("snapshot storage inside the project refuses before copying any originals", async () => {
  const project = await fixture();
  const names = (
    await readdir(project.projectRoot, { recursive: true })
  ).sort();
  let captures = 0;
  const snapshots = bindEnvMigrationSnapshots({
    ...snapshotLibrary,
    defaultUpgradeSnapshotRoot: () => join(project.projectRoot, "snapshots"),
    createUpgradeSnapshot: (input) => {
      captures++;
      return snapshotLibrary.createUpgradeSnapshot(input);
    },
  });
  await expect(
    applyEnvMigration({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("outside Git working trees");
  expect(captures).toBe(0);
  expect(
    (await readdir(project.projectRoot, { recursive: true })).sort()
  ).toEqual(names);
  expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
    `TOKEN=${sentinel}\n`
  );
});
