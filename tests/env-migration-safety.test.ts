import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
} from "../src/constants.ts";
import {
  dropRemovedLegacySecretStorePointer,
  migrateLegacyProjectEnv,
  resolveProjectEnvConfig,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Env and secret migration safety for v4 to v5 upgrades. Every fixture lives
 * in a temp HOME with synthetic values; the keychain fallback is off, so no
 * test reads or writes a real keychain item, and no Docker or git is used.
 * The one CLI run uses a private environment in the same temp HOME.
 */

const PROJECT = "env-migration-safety";
const ENV_KEYS = [
  "HOME",
  "HACK_HOME",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_ENV_SECRET_KEY",
] as const;
const savedEnv = new Map<string, string | undefined>();
let root: string | null = null;

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
  root = await mkdtemp(join(tmpdir(), "hack-env-migration-safety-"));
  process.env.HOME = resolve(root, "home");
  Reflect.deleteProperty(process.env, "HACK_HOME");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  process.env.HACK_SECRETS_FILE_KEY = ["synthetic", "store", "key"].join("-");
  await mkdir(process.env.HOME, { recursive: true });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    restoreEnv(key, savedEnv.get(key));
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

type Repo = {
  readonly projectRoot: string;
  readonly projectDir: string;
};

async function createRepo(opts: {
  readonly vars: readonly Record<string, unknown>[];
  readonly config?: Record<string, unknown>;
  readonly compose?: string;
}): Promise<Repo> {
  if (!root) {
    throw new Error("root not set");
  }
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    opts.compose ?? "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: PROJECT, ...opts.config }, null, 2)}\n`
  );
  await writeFile(
    resolve(projectDir, PROJECT_ENV_CONTRACT_FILENAME),
    `${JSON.stringify({ version: 1, vars: opts.vars }, null, 2)}\n`
  );
  return { projectRoot, projectDir };
}

function encryptedFileConfig(opts: {
  readonly path: string;
  readonly keyPath?: string;
}): Record<string, unknown> {
  return {
    controlPlane: {
      secrets: {
        backend: "encrypted_file",
        encryptedFile: {
          path: opts.path,
          ...(opts.keyPath === undefined ? {} : { keyPath: opts.keyPath }),
        },
      },
    },
  };
}

async function migrate(
  repo: Repo,
  extra: { readonly composeRepairFollows?: boolean } = {}
) {
  return await migrateLegacyProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: PROJECT,
    serviceNames: ["api"],
    materialize: false,
    ...extra,
  });
}

async function setStoreEntries(
  repo: Repo,
  entries: Readonly<Record<string, string>>
): Promise<void> {
  const store = await resolveSecretStore({
    projectName: PROJECT,
    projectDir: repo.projectDir,
  });
  for (const [key, value] of Object.entries(entries)) {
    await store.set({ key, value });
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

async function expectRefusal(
  run: Promise<unknown>,
  code: string
): Promise<string> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as { readonly code?: unknown }).code).toBe(code);
  return (error as Error).message;
}

// HACK-1715: cleanup must not offer a store or key file that holds anything the layers don't deliver.

test("an undeclared store entry keeps the store out of cleanup, named but never shown (HACK-1715)", async () => {
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({ path: "secrets.enc.json" }),
  });
  const storePath = resolve(repo.projectRoot, "secrets.enc.json");
  const declared = ["synthetic", "declared", "5a1e"].join("-");
  const undeclared = ["synthetic", "undeclared", "9c3d"].join("-");
  await setStoreEntries(repo, { SEC: declared, UNDECL: undeclared });
  const before = await readFile(storePath, "utf8");

  const migrated = await migrate(repo);

  expect(migrated.cleanupCandidates).not.toContain(storePath);
  expect(migrated.retainedEnvFiles).toContainEqual({
    path: storePath,
    keys: ["UNDECL"],
    reason: "undelivered",
  });
  expect(JSON.stringify(migrated)).not.toContain(declared);
  expect(JSON.stringify(migrated)).not.toContain(undeclared);
  expect(await readFile(storePath, "utf8")).toBe(before);
});

test("a key file inside the project stays while the store it opens stays (HACK-1715)", async () => {
  if (!root) {
    throw new Error("root not set");
  }
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  const outsideStore = resolve(root, "outside", "secrets.enc.json");
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({
      path: outsideStore,
      keyPath: "store.key",
    }),
  });
  const keyPath = resolve(repo.projectRoot, "store.key");
  await writeFile(keyPath, `${["synthetic", "file", "key"].join("-")}\n`);
  await setStoreEntries(repo, {
    SEC: ["synthetic", "declared", "e2b7"].join("-"),
  });

  const migrated = await migrate(repo);

  expect(migrated.cleanupCandidates).not.toContain(keyPath);
  expect(migrated.retainedEnvFiles).toContainEqual({
    path: keyPath,
    keys: [],
    reason: "secret_store_key",
    storePath: outsideStore,
  });
  expect(await exists(keyPath)).toBe(true);
});

test("a store whose every entry the layers deliver is still offered with its key file (HACK-1715 control)", async () => {
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({
      path: "secrets.enc.json",
      keyPath: "store.key",
    }),
  });
  const storePath = resolve(repo.projectRoot, "secrets.enc.json");
  const keyPath = resolve(repo.projectRoot, "store.key");
  await writeFile(keyPath, `${["synthetic", "file", "key"].join("-")}\n`);
  await setStoreEntries(repo, {
    SEC: ["synthetic", "declared", "41f0"].join("-"),
    "env.qa.SEC": ["synthetic", "qa", "41f0"].join("-"),
  });
  await writeFile(resolve(repo.projectDir, ".env.qa"), "");

  const migrated = await migrate(repo);

  expect(migrated.cleanupCandidates).toContain(storePath);
  expect(migrated.cleanupCandidates).toContain(keyPath);
  expect(
    migrated.retainedEnvFiles.filter((entry) =>
      [storePath, keyPath].includes(entry.path)
    )
  ).toEqual([]);
});

test("a store the migration can't open is kept, and so is nothing deleted for it (HACK-1715)", async () => {
  // No key anywhere and the keychain fallback off: the store can't be listed.
  // The contract reads no value from it, so the migration itself proceeds.
  const repo = await createRepo({
    vars: [{ key: "PLAIN", source: "plain_env" }],
    config: encryptedFileConfig({ path: "secrets.enc.json" }),
  });
  const storePath = resolve(repo.projectRoot, "secrets.enc.json");
  await setStoreEntries(repo, {
    LEFT_BEHIND: ["synthetic", "left", "77aa"].join("-"),
  });
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `PLAIN=${["synthetic", "plain", "77aa"].join("-")}\n`
  );

  const migrated = await migrate(repo);

  expect(migrated.cleanupCandidates).not.toContain(storePath);
  expect(migrated.retainedEnvFiles).toContainEqual({
    path: storePath,
    keys: [],
    reason: "secret_store_unlisted",
  });
});

test("a store shared with another project is kept (HACK-1715)", async () => {
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({ path: "secrets.enc.json" }),
  });
  const storePath = resolve(repo.projectRoot, "secrets.enc.json");
  await setStoreEntries(repo, {
    SEC: ["synthetic", "declared", "0b0b"].join("-"),
  });
  const other = await resolveSecretStore({
    projectName: "another-project",
    projectDir: repo.projectDir,
  });
  await other.set({
    key: "SEC",
    value: ["synthetic", "other", "0b0b"].join("-"),
  });

  const migrated = await migrate(repo);

  expect(migrated.cleanupCandidates).not.toContain(storePath);
  expect(migrated.retainedEnvFiles).toContainEqual({
    path: storePath,
    keys: [],
    reason: "secret_store_shared",
  });
});

// HACK-1715 option C: a kept store keeps its config pointer, on every route.

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");

async function readConfig(repo: Repo): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(resolve(repo.projectDir, PROJECT_CONFIG_FILENAME), "utf8")
  ) as Record<string, unknown>;
}

async function runHack(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
  readonly stdin: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (!(root && process.env.HOME)) {
    throw new Error("root not set");
  }
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.repo.projectRoot,
    env: privateCliEnv({
      root,
      home: process.env.HOME,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(root, "hack-config.json"),
        HACK_HOME: join(root, "hack-home"),
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        HACK_SECRETS_FILE_KEY: process.env.HACK_SECRETS_FILE_KEY,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }),
    stdin: new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

test("an implicit env add keeps the pointer of a store with an undeclared entry, which stays readable (HACK-1715)", async () => {
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({ path: "secrets.enc.json" }),
  });
  const storePath = resolve(repo.projectRoot, "secrets.enc.json");
  const declared = ["synthetic", "declared", "a7c1"].join("-");
  const undeclared = ["synthetic", "undeclared", "a7c1"].join("-");
  await setStoreEntries(repo, { SEC: declared, UNDECL: undeclared });
  const storeText = await readFile(storePath, "utf8");
  const configBefore = await readConfig(repo);
  const added = ["synthetic", "added", "a7c1"].join("-");

  const run = await runHack({
    repo,
    args: [
      "env",
      "add",
      "NEW_SETTING",
      "--local",
      "--value-stdin",
      "--path",
      repo.projectRoot,
    ],
    stdin: `${added}\n`,
  });

  expect(run.exitCode).toBe(0);
  expect(await exists(resolve(repo.projectDir, "hack.env.default.yaml"))).toBe(
    true
  );
  expect(await readConfig(repo)).toEqual(configBefore);
  expect(await readFile(storePath, "utf8")).toBe(storeText);
  const store = await resolveSecretStore({
    projectName: PROJECT,
    projectDir: repo.projectDir,
  });
  expect(await store.get({ key: "UNDECL" })).toBe(undeclared);
  expect(run.output).toContain(
    "Kept the encrypted secret store pointer (controlPlane.secrets) in .hack/hack.config.json for secrets.enc.json, which stays: it still holds SEC, UNDECL (values omitted)"
  );
  for (const value of [declared, undeclared, added]) {
    expect(run.output).not.toContain(value);
  }
}, 60_000);

test("a store outside the project keeps its pointer, and a second migration changes nothing (HACK-1715)", async () => {
  if (!root) {
    throw new Error("root not set");
  }
  const outsideStore = resolve(root, "outside", "secrets.enc.json");
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({ path: outsideStore }),
  });
  const declared = ["synthetic", "declared", "d3e4"].join("-");
  await setStoreEntries(repo, { SEC: declared });
  const configPath = resolve(repo.projectDir, PROJECT_CONFIG_FILENAME);
  const configText = await readFile(configPath, "utf8");

  const first = await migrate(repo);

  expect(first.updatedProjectConfig).toBe(false);
  expect(await readFile(configPath, "utf8")).toBe(configText);
  expect(first.keptSecretStorePointer).toEqual({
    configPath,
    storePath: outsideStore,
    listed: true,
    keys: ["SEC"],
  });
  const layers = await readFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    "utf8"
  );
  const storeText = await readFile(outsideStore, "utf8");

  const second = await migrate(repo);

  expect(second.legacyDetected).toBe(false);
  expect(second.wroteFiles).toEqual([]);
  expect(await readFile(configPath, "utf8")).toBe(configText);
  expect(await readFile(outsideStore, "utf8")).toBe(storeText);
  expect(
    await readFile(resolve(repo.projectDir, "hack.env.default.yaml"), "utf8")
  ).toBe(layers);
});

test("a cloud backend keeps the in-project store pointer it reads, and its store is never offered (HACK-1715)", async () => {
  if (!root) {
    throw new Error("root not set");
  }
  // Absolute, because the cloud shim resolves a relative path against HOME.
  const storePath = resolve(root, "repo", "cloud-shim.enc.json");
  const keyPath = resolve(root, "repo", "cloud.key");
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: {
      controlPlane: {
        secrets: {
          backend: "cloud",
          cloud: { provider: "vault", project: "synthetic" },
          encryptedFile: { path: storePath, keyPath },
        },
      },
    },
  });
  const declared = ["synthetic", "cloud", "b8f9"].join("-");
  await setStoreEntries(repo, { SEC: declared });
  expect(await exists(storePath)).toBe(true);
  const storeText = await readFile(storePath, "utf8");

  const migrated = await migrate(repo);

  const secrets = (
    (await readConfig(repo)).controlPlane as Record<string, unknown>
  ).secrets as Record<string, unknown>;
  expect(secrets.backend).toBe("cloud");
  expect(secrets.encryptedFile).toEqual({ path: storePath, keyPath });
  expect(migrated.cleanupCandidates).not.toContain(storePath);
  expect(migrated.cleanupCandidates).not.toContain(keyPath);
  expect(
    await dropRemovedLegacySecretStorePointer({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      projectName: PROJECT,
      removed: [storePath],
    })
  ).toBe(false);
  expect(await readFile(storePath, "utf8")).toBe(storeText);
  const store = await resolveSecretStore({
    projectName: PROJECT,
    projectDir: repo.projectDir,
  });
  expect(await store.get({ key: "SEC" })).toBe(declared);
});

// HACK-1714: an overlay secret that only the store holds must reach a layer.

test("an overlay secret with no overlay file is migrated into that overlay's layer (HACK-1714)", async () => {
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({ path: "secrets.enc.json" }),
  });
  const storePath = resolve(repo.projectRoot, "secrets.enc.json");
  const staging = ["synthetic", "staging", "c4d2"].join("-");
  await setStoreEntries(repo, { "env.staging.SEC": staging });
  const before = await readFile(storePath, "utf8");

  const migrated = await migrate(repo);

  expect(migrated.migratedOverlays).toEqual(["staging"]);
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "staging",
    serviceNames: ["api"],
  });
  expect(resolved?.serviceEnv.api?.SEC).toBe(staging);
  // Every entry is now delivered, so the store may be offered; it is unchanged.
  expect(migrated.cleanupCandidates).toContain(storePath);
  expect(await readFile(storePath, "utf8")).toBe(before);
});

test("a store overlay name that can't be a layer name refuses before any write (HACK-1714)", async () => {
  const repo = await createRepo({
    vars: [{ key: "SEC", source: "keychain" }],
    config: encryptedFileConfig({ path: "secrets.enc.json" }),
  });
  const value = ["synthetic", "bad", "name"].join("-");
  await setStoreEntries(repo, { "env.Bad_Name.SEC": value });

  const message = await expectRefusal(migrate(repo), "E_CONFIG_INVALID");

  expect(message).toContain("1 overlay");
  expect(message).not.toContain(value);
  expect(message).not.toContain("Bad_Name");
  expect(await exists(resolve(repo.projectDir, "hack.env.default.yaml"))).toBe(
    false
  );
});

// HACK-1686: a symlinked .hack/.env or default overlay never reaches a layer.

for (const target of [".env", ".env.staging"] as const) {
  test(`a symlinked ${target} pointing outside .hack refuses before any layer is written (HACK-1686)`, async () => {
    if (!root) {
      throw new Error("root not set");
    }
    const repo = await createRepo({
      vars: [{ key: "PLAIN", source: "plain_env" }],
      config: { env: { defaultOverlay: "staging" } },
    });
    const outside = resolve(repo.projectRoot, ".env");
    const leaked = ["synthetic", "root", "dotenv"].join("-");
    await writeFile(outside, `PLAIN=${leaked}\n`);
    await symlink(outside, resolve(repo.projectDir, target));

    const message = await expectRefusal(migrate(repo), "E_PATH_CONFLICT");

    expect(message).not.toContain(leaked);
    for (const layer of [
      "hack.env.default.yaml",
      "hack.env.staging.yaml",
      "hack.env.local.yaml",
      "hack.env.staging.local.yaml",
    ]) {
      expect(await exists(resolve(repo.projectDir, layer))).toBe(false);
    }
    expect(await readFile(outside, "utf8")).toBe(`PLAIN=${leaked}\n`);
  });
}

// HACK-1681: an unreadable legacy file refuses instead of migrating as empty.

for (const target of [".env", ".env.qa"] as const) {
  test.skipIf(process.getuid?.() === 0)(
    `an unreadable ${target} refuses with E_PERMISSION before any layer is written (HACK-1681)`,
    async () => {
      const repo = await createRepo({
        vars: [{ key: "PLAIN", source: "plain_env" }],
      });
      const file = resolve(repo.projectDir, target);
      const value = ["synthetic", "unreadable", "3e3e"].join("-");
      await writeFile(file, `PLAIN=${value}\n`);
      await chmod(file, 0o000);
      try {
        const message = await expectRefusal(migrate(repo), "E_PERMISSION");
        expect(message).not.toContain(value);
        expect(
          await exists(resolve(repo.projectDir, "hack.env.default.yaml"))
        ).toBe(false);
        expect(
          await exists(resolve(repo.projectDir, "hack.env.local.yaml"))
        ).toBe(false);
      } finally {
        await chmod(file, 0o600);
      }
      expect(await readFile(file, "utf8")).toBe(`PLAIN=${value}\n`);
    }
  );
}

test("a configured default overlay with no file still migrates as empty (HACK-1681 control)", async () => {
  const repo = await createRepo({
    vars: [{ key: "PLAIN", source: "plain_env" }],
    config: { env: { defaultOverlay: "staging" } },
  });
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `PLAIN=${["synthetic", "base", "1d1d"].join("-")}\n`
  );

  const migrated = await migrate(repo);

  expect(migrated.legacyDetected).toBe(true);
  expect(await exists(resolve(repo.projectDir, "hack.env.default.yaml"))).toBe(
    true
  );
});

// HACK-1682: a Compose-loaded overlay a default launch wouldn't select.

const STAGING_COMPOSE =
  "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n";

async function stagingRepo(opts: {
  readonly config?: Record<string, unknown>;
  readonly compose?: string;
  readonly stagingText: string;
}): Promise<Repo> {
  const repo = await createRepo({
    vars: [{ key: "PLAIN", source: "plain_env" }],
    compose: opts.compose ?? STAGING_COMPOSE,
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `PLAIN=${["synthetic", "base", "6f6f"].join("-")}\n`
  );
  await writeFile(resolve(repo.projectDir, ".env.staging"), opts.stagingText);
  return repo;
}

test("a Compose-loaded overlay that isn't the default refuses, even implicitly (HACK-1682)", async () => {
  const stagingValue = ["synthetic", "staging", "6f6f"].join("-");
  const repo = await stagingRepo({ stagingText: `PLAIN=${stagingValue}\n` });

  const message = await expectRefusal(migrate(repo), "E_CONFIG_INVALID");

  expect(message).toContain('".env.staging"');
  expect(message).not.toContain(stagingValue);
  expect(await exists(resolve(repo.projectDir, "hack.env.default.yaml"))).toBe(
    false
  );
});

test("the same overlay as env.defaultOverlay migrates and keeps its value (HACK-1682 control)", async () => {
  const stagingValue = ["synthetic", "staging", "8a8a"].join("-");
  const repo = await stagingRepo({
    config: { env: { defaultOverlay: "staging" } },
    stagingText: `PLAIN=${stagingValue}\n`,
  });

  await migrate(repo, { composeRepairFollows: true });

  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api"],
  });
  expect(resolved?.serviceEnv.api?.PLAIN).toBe(stagingValue);
});

test("an undeclared overlay key counts only when the Compose repair follows (HACK-1682)", async () => {
  const repo = await stagingRepo({
    stagingText: `EXTRA=${["synthetic", "extra", "2c2c"].join("-")}\n`,
  });

  await expectRefusal(
    migrate(repo, { composeRepairFollows: true }),
    "E_CONFIG_INVALID"
  );
  expect(await exists(resolve(repo.projectDir, "hack.env.default.yaml"))).toBe(
    false
  );

  // Implicitly, Compose keeps loading the file, and no layer sets EXTRA.
  const migrated = await migrate(repo);
  expect(migrated.legacyDetected).toBe(true);
});

test("env_file order that the default overlay would reverse refuses (HACK-1682)", async () => {
  const repo = await stagingRepo({
    config: { env: { defaultOverlay: "staging" } },
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env.staging, .env]\n",
    stagingText: `PLAIN=${["synthetic", "staging", "9d9d"].join("-")}\n`,
  });

  const message = await expectRefusal(migrate(repo), "E_CONFIG_INVALID");

  expect(message).toContain("order of Compose env_file");
  expect(await exists(resolve(repo.projectDir, "hack.env.default.yaml"))).toBe(
    false
  );
});
