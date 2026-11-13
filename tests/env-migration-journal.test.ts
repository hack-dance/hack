import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEnvMigration,
  cleanupEnvMigration,
  type EnvMigrationProject,
  previewEnvMigration,
  recordEnvMigrationProjectRun,
  rollbackEnvMigration,
} from "../src/lib/env-migration.ts";
import { resolveProjectEnvConfig } from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureEnvSnapshots } from "./helpers/env-migration-fixture.ts";
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
  for (const [index, key] of isolated.entries()) {
    restoreEnv(key, saved[index]);
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("preview makes no writes and exactly names what apply publishes; completed retry is a no-op", async () => {
  const before = await projectFiles();
  const preview = await previewEnvMigration(project);
  expect(await projectFiles()).toEqual(before);
  expect(await Bun.file(preview.journalPath).exists()).toBe(false);
  expect(JSON.stringify(preview)).not.toContain(SENTINEL);
  const snapshots = fixtureEnvSnapshots(root);
  const result = await applyEnvMigration({
    project,
    snapshots,
    acceptTrackedChanges: true,
  });
  await expect(
    cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true })
  ).rejects.toThrow("hack up");
  expect(result.status).toBe("applied");
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
  expect(journal).not.toContain(SENTINEL);
  expect(journal).not.toContain(QA);
  expect(await readFile(result.manifestPath, "utf8")).not.toContain(SENTINEL);
  expect(
    (
      await applyEnvMigration({
        project,
        snapshots,
        acceptTrackedChanges: true,
      })
    ).status
  ).toBe("already_complete");
  expect(await projectFiles()).toEqual(after);
  expect(await readFile(result.journalPath, "utf8")).toBe(journal);
});

test("cleanup is explicit, rechecks delivery, and requires intact snapshot payloads", async () => {
  const snapshots = fixtureEnvSnapshots(root);
  const result = await applyEnvMigration({
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

test("rollback restores original bytes and refuses a later user edit", async () => {
  const before = await projectFiles();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await applyEnvMigration({
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
  expect(await projectFiles()).toEqual(before);
});

test("cleanup snapshots must still hold every original; cleanup followed by rollback restores legacy files", async () => {
  const before = await projectFiles();
  const snapshots = fixtureEnvSnapshots(root);
  const result = await applyEnvMigration({
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
  expect(await projectFiles()).toEqual(before);
});

test("preview does not provision a new project key; apply encrypts with a private key and rollback retains every legacy value", async () => {
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
  const before = await projectFiles();
  const keyPath = join(project.projectRoot, ".hack.secret.key");
  const preview = await previewEnvMigration(project);
  expect(await projectFiles()).toEqual(before);
  expect(preview.files).toContainEqual({
    path: keyPath,
    action: "write",
    keys: [],
    tracked: false,
  });
  const snapshots = fixtureEnvSnapshots(root);
  const result = await applyEnvMigration({
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
  await cleanupEnvMigration({ project, snapshots, acceptTrackedChanges: true });
  expect(
    await readFile(join(project.projectDir, "hack.config.json"), "utf8")
  ).not.toContain("encryptedFile");
  await rollbackEnvMigration({
    project,
    snapshots,
    manifestPath: result.manifestPath,
  });
  expect(await projectFiles()).toEqual(before);
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
  const result = await applyEnvMigration({
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

test("SIGKILL at every journal/publication boundary resumes without losing an overlay value", async () => {
  const preview = await previewEnvMigration(project);
  const count = preview.files.filter(
    (file) => file.action !== "removable"
  ).length;
  const boundaries = [
    "prepared:-1",
    ...Array.from({ length: count }, (_, index) => [
      `before_publish:${index}`,
      `published:${index}`,
      `recorded:${index}`,
    ]).flat(),
    "verified:-1",
    "complete:-1",
  ];
  // Each interruption owns a fresh HOME, data root, project and snapshot set.
  for (const boundary of boundaries) {
    const selected = join(root, boundary.replaceAll(":", "-"));
    const selectedProject = {
      ...project,
      projectRoot: join(selected, "project"),
      projectDir: join(selected, "project", ".hack"),
    };
    await mkdir(selectedProject.projectDir, { recursive: true });
    for (const file of [
      "hack.config.json",
      "hack.env.json",
      "docker-compose.yml",
      ".env",
      ".env.qa",
    ]) {
      await writeFile(
        join(selectedProject.projectDir, file),
        await readFile(join(project.projectDir, file))
      );
    }
    const dataHome = join(selected, "hack-home");
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
        await applyEnvMigration({
          project: selectedProject,
          snapshots: fixtureEnvSnapshots(selected),
          acceptTrackedChanges: true,
        });
        expect(
          (await resolveProjectEnvConfig({ ...selectedProject, envName: null }))
            ?.globalEnv.TOKEN
        ).toBe(SENTINEL);
        expect(
          (await resolveProjectEnvConfig({ ...selectedProject, envName: "qa" }))
            ?.globalEnv.TOKEN
        ).toBe(QA);
        expect(
          await readFile(join(selectedProject.projectDir, ".env"), "utf8")
        ).toContain(SENTINEL);
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
}, 60_000);
