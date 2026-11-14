import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { applyEnvMigration } from "../src/lib/env-migration.ts";
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

async function cli(projectRoot: string, args: readonly string[]) {
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
    cmd: [
      ...command,
      "env",
      "migrate",
      "--path",
      projectRoot,
      "--json",
      ...args,
    ],
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      home: join(root, "home"),
      env: {
        HACK_HOME: join(root, "state"),
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        PATH: "/nonexistent",
      },
    }),
  });
  expect(result.stdout + result.stderr).not.toContain(sentinel);
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
      createUpgradeSnapshot: (input) =>
        snapshotLibrary.createUpgradeSnapshot({ ...input, root: snapshotRoot }),
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
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
});
