import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnvLayerLock } from "../src/lib/env-layer-lock.ts";
import {
  finishImplicitLegacyEnvMigration,
  migrateLegacyProjectEnv,
  removeLegacyProjectEnvArtifacts,
  repairLegacyComposeEnvFileReferences,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

const SENTINEL = "synthetic-cleanup-value";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "hack-cleanup-"));
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"fixture"}\n');
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n    env_file:\n      - .env\n"
  );
  const path = join(projectDir, ".env");
  await writeFile(path, `TOKEN=${SENTINEL}\n`);
  return {
    projectRoot,
    projectDir,
    projectName: "fixture",
    serviceNames: ["app"],
    path,
  };
}

async function migrate(options: Awaited<ReturnType<typeof fixture>>) {
  const migrated = await migrateLegacyProjectEnv({
    ...options,
    materialize: false,
    migrateUndeclaredDotenv: true,
    composeRepairFollows: true,
  });
  await repairLegacyComposeEnvFileReferences({
    composeFile: join(options.projectDir, "docker-compose.yml"),
    projectDir: options.projectDir,
  });
  return {
    projectRoot: options.projectRoot,
    paths: [options.path],
    context: migrated.cleanupContext,
  };
}

async function refused(
  options: Parameters<typeof removeLegacyProjectEnvArtifacts>[0]
) {
  const error = await removeLegacyProjectEnvArtifacts(options).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Retry hack doctor --migrate-env-config");
  expect(String(error)).not.toContain(SENTINEL);
}

test("unchanged sources are removed only after current delivery and Compose references are checked", async () => {
  const options = await fixture();
  const cleanup = await migrate(options);
  expect(await removeLegacyProjectEnvArtifacts(cleanup)).toEqual([
    options.path,
  ]);
  expect(await Bun.file(options.path).exists()).toBe(false);
});

test("cleanup preserves a source updated while confirmation was pending", async () => {
  const options = await fixture();
  const cleanup = await migrate(options);
  const current = `TOKEN=${SENTINEL}-new\nADDED=${SENTINEL}\n`;
  await writeFile(options.path, current);
  await refused(cleanup);
  expect(await readFile(options.path, "utf8")).toBe(current);
});

test("an equal-content replacement has a new identity and is kept", async () => {
  const options = await fixture();
  const cleanup = await migrate(options);
  const current = await readFile(options.path, "utf8");
  await writeFile(`${options.path}.replacement`, current);
  await rename(`${options.path}.replacement`, options.path);
  await refused(cleanup);
  expect(await readFile(options.path, "utf8")).toBe(current);
});

test("implicit migration also carries the source receipt into cleanup", async () => {
  const options = await fixture();
  await writeFile(
    join(options.projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(options.projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "TOKEN", source: "plain_env", required: false }],
    })
  );
  const migrated = await migrateLegacyProjectEnv({
    ...options,
    materialize: false,
  });
  expect(migrated.cleanupCandidates).toContain(options.path);
  await writeFile(options.path, `TOKEN=${SENTINEL}-new\n`);
  const report = await finishImplicitLegacyEnvMigration({
    ...options,
    migrated,
  });
  expect(report.removed).toEqual([]);
  expect(report.lines.join("\n")).toContain("Kept remaining legacy env files");
  expect(report.lines.join("\n")).not.toContain(SENTINEL);
  expect(await readFile(options.path, "utf8")).toBe(`TOKEN=${SENTINEL}-new\n`);
});

test("cleanup rechecks current YAML delivery after confirmation", async () => {
  const options = await fixture();
  const cleanup = await migrate(options);
  await setProjectEnvValue({
    ...options,
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: `${SENTINEL}-changed`,
    secret: false,
    local: true,
  });
  await refused(cleanup);
  expect(await readFile(options.path, "utf8")).toBe(`TOKEN=${SENTINEL}\n`);
});

async function scopedFixture() {
  const options = await fixture();
  await writeFile(
    join(options.projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [
        {
          key: "TOKEN",
          source: "plain_env",
          required: false,
          services: ["app"],
        },
      ],
    })
  );
  return options;
}

test("cleanup rechecks a service-scoped value after confirmation", async () => {
  const options = await scopedFixture();
  const cleanup = await migrate(options);
  await setProjectEnvValue({
    ...options,
    envName: null,
    scope: "app",
    key: "TOKEN",
    value: `${SENTINEL}-changed`,
    secret: false,
    local: true,
  });
  await refused(cleanup);
  expect(await readFile(options.path, "utf8")).toBe(`TOKEN=${SENTINEL}\n`);
});

test("a removed contract service gets a fixed cleanup refusal", async () => {
  const options = await scopedFixture();
  const cleanup = await migrate(options);
  await writeFile(
    join(options.projectDir, "docker-compose.yml"),
    "services:\n  other:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(options.projectDir, "hack.env.local.yaml"),
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await refused(cleanup);
  expect(await Bun.file(options.path).exists()).toBe(true);
});

test("cleanup keeps a source when Compose re-adds its env_file reference", async () => {
  const options = await fixture();
  const cleanup = await migrate(options);
  await writeFile(
    join(options.projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n    env_file: .env\n"
  );
  await refused(cleanup);
  expect(await Bun.file(options.path).exists()).toBe(true);
});

test("cleanup keeps a scoped key newly used for Compose interpolation", async () => {
  const options = await scopedFixture();
  const cleanup = await migrate(options);
  await writeFile(
    join(options.projectDir, "docker-compose.yml"),
    'services:\n  app:\n    image: alpine:3.22\n    environment:\n      OTHER: "${TOKEN}"\n'
  );
  await refused(cleanup);
  expect(await Bun.file(options.path).exists()).toBe(true);
});

test("a second cleanup confirmation works after the first removed untracked sources", async () => {
  const options = await fixture();
  const contractPath = join(options.projectDir, "hack.env.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      version: 1,
      vars: [{ key: "TOKEN", source: "plain_env", required: false }],
    })
  );
  const cleanup = await migrate(options);
  expect(await removeLegacyProjectEnvArtifacts(cleanup)).toEqual([
    options.path,
  ]);
  expect(
    await removeLegacyProjectEnvArtifacts({ ...cleanup, paths: [contractPath] })
  ).toEqual([contractPath]);
});

test("cleanup waits for the dotenv writer lock and rechecks the completed write", async () => {
  const options = await fixture();
  const cleanup = await migrate(options);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writer = withEnvLayerLock({
    layerPath: options.path,
    run: async () => {
      entered.resolve();
      await release.promise;
      await writeFile(options.path, `TOKEN=${SENTINEL}-concurrent\n`);
    },
  });
  await entered.promise;
  let settled = false;
  const removal = refused(cleanup).finally(() => {
    settled = true;
  });
  try {
    await Bun.sleep(30);
    expect(settled).toBe(false);
  } finally {
    release.resolve();
    await writer;
    await removal;
  }
  expect(await readFile(options.path, "utf8")).toContain(
    `${SENTINEL}-concurrent`
  );
});

test("a stale encrypted-store inventory preserves both store and key", async () => {
  const options = await fixture();
  const savedKey = process.env.HACK_SECRETS_FILE_KEY;
  const savedFallback = process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK;
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-cleanup-encryption-key";
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  try {
    const storePath = join(options.projectRoot, "legacy-store.json");
    const keyPath = join(options.projectRoot, "legacy-store.key");
    await writeFile(keyPath, "synthetic-cleanup-encryption-key\n");
    await writeFile(
      join(options.projectDir, "hack.config.json"),
      JSON.stringify({
        name: "fixture",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: storePath, keyPath },
          },
        },
      })
    );
    await writeFile(
      join(options.projectDir, "hack.env.json"),
      JSON.stringify({
        version: 1,
        vars: [{ key: "TOKEN", source: "keychain", required: false }],
      })
    );
    const store = await resolveSecretStore(options);
    await store.set({ key: "TOKEN", value: SENTINEL });
    const migrated = await migrateLegacyProjectEnv({
      ...options,
      materialize: false,
      composeRepairFollows: true,
    });
    expect(migrated.cleanupCandidates).toContain(storePath);
    expect(migrated.cleanupCandidates).toContain(keyPath);
    await repairLegacyComposeEnvFileReferences({
      composeFile: join(options.projectDir, "docker-compose.yml"),
      projectDir: options.projectDir,
    });
    await store.set({ key: "ADDED", value: `${SENTINEL}-new` });
    const bytes = await readFile(storePath, "utf8");
    await refused({
      projectRoot: options.projectRoot,
      paths: [storePath, keyPath],
      context: migrated.cleanupContext,
    });
    expect(await readFile(storePath, "utf8")).toBe(bytes);
    expect(await Bun.file(keyPath).exists()).toBe(true);
    expect(await store.get({ key: "ADDED" })).toBe(`${SENTINEL}-new`);
  } finally {
    restoreEnv("HACK_SECRETS_FILE_KEY", savedKey);
    restoreEnv("HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK", savedFallback);
  }
});
