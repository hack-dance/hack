import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDoctorEnvCleanup } from "../src/commands/doctor.ts";
import { withEnvLayerLock } from "../src/lib/env-layer-lock.ts";
import {
  finishImplicitLegacyEnvMigration,
  LegacyEnvCleanupError,
  migrateLegacyProjectEnv,
  removeLegacyProjectEnvArtifacts,
  repairLegacyComposeEnvFileReferences,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import {
  resolveSecretStore,
  withEncryptedFileKeyLock,
} from "../src/lib/secret-store.ts";
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
    migrated,
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
  expect(String(error)).toContain(
    "Reconcile chosen values with hack env set KEY --value-stdin"
  );
  expect(String(error)).toContain("--local for machine-local values");
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

test("implicit migration defers cleanup without waiting on a legacy writer lock", async () => {
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
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writer = withEnvLayerLock({
    layerPath: options.path,
    run: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  try {
    const report = await finishImplicitLegacyEnvMigration({
      ...options,
      migrated,
    });
    expect(report.removed).toEqual([]);
    expect(report.lines.join("\n")).toContain(
      "preview the separate cleanup step"
    );
    expect(report.lines.join("\n")).not.toContain(SENTINEL);
    expect(await Bun.file(options.path).exists()).toBe(true);
  } finally {
    release.resolve();
    await writer;
  }
}, 20_000);

async function withMigratedStore(
  run: (options: Awaited<ReturnType<typeof migratedStore>>) => Promise<void>
) {
  const savedKey = process.env.HACK_SECRETS_FILE_KEY;
  const savedFallback = process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK;
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-cleanup-encryption-key";
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  try {
    await run(await migratedStore());
  } finally {
    restoreEnv("HACK_SECRETS_FILE_KEY", savedKey);
    restoreEnv("HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK", savedFallback);
  }
}

async function migratedStore() {
  const options = await fixture();
  const storePath = join(options.projectRoot, "legacy-store.json");
  const keyPath = join(options.projectRoot, "legacy-store.key");
  const contractPath = join(options.projectDir, "hack.env.json");
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
    contractPath,
    JSON.stringify({
      version: 1,
      vars: [{ key: "TOKEN", source: "keychain", required: false }],
    })
  );
  const store = await resolveSecretStore(options);
  await store.set({ key: "TOKEN", value: SENTINEL });
  const cleanup = await migrate(options);
  return { ...options, ...cleanup, storePath, keyPath, contractPath };
}

test("a changed YAML store value keeps the unchanged encrypted store and key", async () => {
  await withMigratedStore(async (options) => {
    const bytes = await readFile(options.storePath, "utf8");
    await setProjectEnvValue({
      ...options,
      envName: null,
      scope: "global",
      key: "TOKEN",
      value: `${SENTINEL}-changed`,
      secret: true,
      local: true,
    });
    await refused({ ...options, paths: [options.storePath, options.keyPath] });
    expect(await readFile(options.storePath, "utf8")).toBe(bytes);
    expect(await Bun.file(options.keyPath).exists()).toBe(true);
  });
});

test("cleanup refuses a key-only batch while its store remains", async () => {
  await withMigratedStore(async (options) => {
    const bytes = await readFile(options.storePath, "utf8");
    const key = await readFile(options.keyPath, "utf8");
    await refused({ ...options, paths: [options.keyPath] });
    expect(await readFile(options.storePath, "utf8")).toBe(bytes);
    expect(await readFile(options.keyPath, "utf8")).toBe(key);
  });
});

test.skipIf(process.getuid?.() === 0)(
  "an unreadable store is kept with its key",
  async () => {
    await withMigratedStore(async (options) => {
      await chmod(options.storePath, 0o000);
      try {
        await expect(readFile(options.storePath)).rejects.toThrow();
        await refused({
          ...options,
          paths: [options.storePath, options.keyPath],
        });
        expect(await Bun.file(options.keyPath).exists()).toBe(true);
      } finally {
        await chmod(options.storePath, 0o600);
      }
      expect(await Bun.file(options.storePath).exists()).toBe(true);
    });
  }
);

test.skipIf(process.getuid?.() === 0)(
  "partial cleanup reports confirmed removals and retains the key",
  async () => {
    await withMigratedStore(async (options) => {
      await chmod(options.projectDir, 0o500);
      try {
        const error = await removeLegacyProjectEnvArtifacts({
          ...options,
          paths: [options.storePath, options.contractPath, options.keyPath],
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LegacyEnvCleanupError);
        if (!(error instanceof LegacyEnvCleanupError)) {
          throw new Error("Expected a safe cleanup outcome");
        }
        expect(error.removedPaths).toEqual([options.storePath]);
        expect(error.message).toContain(JSON.stringify(options.storePath));
        expect(error.message).not.toContain(SENTINEL);
        expect(await Bun.file(options.storePath).exists()).toBe(false);
        expect(await Bun.file(options.contractPath).exists()).toBe(true);
        expect(await Bun.file(options.keyPath).exists()).toBe(true);
      } finally {
        await chmod(options.projectDir, 0o700);
      }
    });
  }
);

for (const configWritable of [true, false]) {
  test.skipIf(process.getuid?.() === 0)(
    `doctor surfaces partial cleanup with a removed store (config writable: ${configWritable}, HACK-2179)`,
    async () => {
      await withMigratedStore(async (options) => {
        const configPath = join(options.projectDir, "hack.config.json");
        const key = await readFile(options.keyPath, "utf8");
        const store = await readFile(options.storePath, "utf8");
        const printed: string[] = [];
        const stdoutWrite = process.stdout.write;
        const stderrWrite = process.stderr.write;
        const capture = (chunk: unknown): boolean => {
          printed.push(String(chunk));
          return true;
        };
        await chmod(configPath, configWritable ? 0o600 : 0o400);
        await chmod(options.projectDir, 0o500);
        let error: unknown;
        try {
          process.stdout.write = capture as typeof process.stdout.write;
          process.stderr.write = capture as typeof process.stderr.write;
          error = await removeDoctorEnvCleanup({
            ...options,
            paths: [options.storePath, options.contractPath, options.keyPath],
          }).catch((caught: unknown) => caught);
        } finally {
          process.stdout.write = stdoutWrite;
          process.stderr.write = stderrWrite;
          await chmod(options.projectDir, 0o700);
          await chmod(configPath, 0o600);
        }
        expect(error).toBeInstanceOf(LegacyEnvCleanupError);
        if (!(error instanceof LegacyEnvCleanupError)) {
          throw new Error("Expected doctor to surface the cleanup failure");
        }
        expect(error.removedPaths).toEqual([options.storePath]);
        expect(await Bun.file(options.storePath).exists()).toBe(false);
        expect(await Bun.file(options.contractPath).exists()).toBe(true);
        expect(await readFile(options.keyPath, "utf8")).toBe(key);
        const config = JSON.parse(await readFile(configPath, "utf8"));
        expect(config.name).toBe("fixture");
        if (configWritable) {
          expect(config.controlPlane).toBeUndefined();
        } else {
          expect(config.controlPlane.secrets.encryptedFile.path).toBe(
            options.storePath
          );
          expect(printed.join("")).toContain(
            "Could not reconcile the legacy secret store pointer"
          );
        }
        for (const value of [SENTINEL, key.trim(), store]) {
          expect(printed.join("")).not.toContain(value);
          expect(error.message).not.toContain(value);
        }
      });
    }
  );
}

test("cleanup uses store/key owner locks without a root .internal directory", async () => {
  await withMigratedStore(async (options) => {
    await expect(
      lstat(join(options.projectRoot, ".internal"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await removeLegacyProjectEnvArtifacts({
        ...options,
        paths: [options.keyPath, options.storePath],
      })
    ).toEqual([options.storePath, options.keyPath]);
    await expect(
      lstat(join(options.projectRoot, ".internal"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("cleanup waits for the key writer and preserves its completed change", async () => {
  await withMigratedStore(async (options) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const keyText = "synthetic-concurrent-key-change\n";
    const writer = withEncryptedFileKeyLock({
      keyPath: options.keyPath,
      run: async () => {
        entered.resolve();
        await release.promise;
        await writeFile(options.keyPath, keyText);
      },
    });
    await entered.promise;
    let settled = false;
    const removal = removeLegacyProjectEnvArtifacts({
      ...options,
      paths: [options.storePath, options.keyPath],
    }).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      await Bun.sleep(200);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await writer;
      const error = await removal;
      expect(error).toBeInstanceOf(LegacyEnvCleanupError);
      expect(String(error)).not.toContain(keyText.trim());
    }
    expect(await readFile(options.keyPath, "utf8")).toBe(keyText);
    expect(await Bun.file(options.storePath).exists()).toBe(true);
  });
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

test("implicit migration retains a source changed after publication", async () => {
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
  expect(report.lines.join("\n")).toContain("Legacy env files were kept.");
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
