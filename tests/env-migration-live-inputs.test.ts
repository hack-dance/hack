import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectLegacyProjectEnvCleanupCandidates,
  migrateLegacyProjectEnv,
  removeLegacyProjectEnvArtifacts,
  resolveProjectEnvConfig,
  resolveProjectEnvSharedKeyPath,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const KEY = "synthetic-shared-migration-key";
const VALUE = "synthetic-migrated-secret";
const roots: string[] = [];
const envNames = [
  "HACK_ENV_SECRET_KEY",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
] as const;
let saved: (string | undefined)[];
beforeEach(() => {
  saved = envNames.map((name) => process.env[name]);
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  process.env.HACK_SECRETS_FILE_KEY = KEY;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
});
afterEach(async () => {
  for (const [index, name] of envNames.entries()) {
    restoreEnv(name, saved[index]);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(directory = ".hack") {
  const unresolvedProjectRoot = await mkdtemp(
    join(tmpdir(), "hack-live-env-inputs-")
  );
  const projectRoot = await realpath(unresolvedProjectRoot);
  roots.push(projectRoot);
  const projectDir = join(projectRoot, directory);
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n"
  );
  return {
    projectRoot,
    unresolvedProjectRoot,
    projectDir,
    projectName: "fixture",
    serviceNames: ["app"],
  };
}

for (const configuredKeyPath of [".hack.secret.key", "link/.hack.secret.key"]) {
  test(`legacy cleanup preserves a YAML key reused through ${configuredKeyPath}`, async () => {
    const options = await fixture();
    await symlink(".", join(options.projectRoot, "link"));
    const keyPath = join(options.projectRoot, ".hack.secret.key");
    const storePath = join(options.projectRoot, "legacy-store.json");
    await writeFile(keyPath, `${KEY}\n`, { mode: 0o600 });
    await writeFile(
      join(options.projectDir, "hack.config.json"),
      JSON.stringify({
        name: "fixture",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: storePath, keyPath: configuredKeyPath },
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
    await store.set({ key: "TOKEN", value: VALUE });
    const migrated = await migrateLegacyProjectEnv({
      ...options,
      materialize: false,
    });
    expect(migrated.cleanupCandidates).toContain(storePath);
    await removeLegacyProjectEnvArtifacts({
      projectRoot: options.projectRoot,
      paths: migrated.cleanupCandidates,
    });
    const resolved = await resolveProjectEnvConfig({
      ...options,
      envName: null,
    });
    expect(resolved?.globalEnv.TOKEN).toBe(VALUE);
    expect(await readFile(keyPath, "utf8")).toBe(`${KEY}\n`);
    expect(migrated.cleanupCandidates).not.toContain(keyPath);
    expect(await Bun.file(storePath).exists()).toBe(false);
  });
}

test("candidate selection and deletion both reject project/shared keys and current env inputs", async () => {
  const options = await fixture();
  const git = Bun.spawn(["git", "init", "--quiet", options.projectRoot], {
    env: fixtureGitEnv(),
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await git.exited).toBe(0);
  const keyPath = join(options.projectRoot, ".hack.secret.key");
  const sharedKeyPath = join(options.projectRoot, ".git/.hack.secret.key");
  const configPath = join(options.projectDir, "hack.config.json");
  const layerPath = join(options.projectDir, "hack.env.default.yaml");
  await writeFile(keyPath, `${KEY}\n`);
  await writeFile(sharedKeyPath, `${KEY}\n`);
  await writeFile(configPath, '{"name":"fixture"}\n');
  await writeFile(
    layerPath,
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  expect(await resolveProjectEnvSharedKeyPath(options)).toBe(sharedKeyPath);
  // Temp roots can have another spelling on hosts with a symlinked temp directory.
  const unresolvedKeyPath = join(
    options.unresolvedProjectRoot,
    ".hack.secret.key"
  );
  const protectedPaths = [
    keyPath,
    sharedKeyPath,
    configPath,
    layerPath,
    unresolvedKeyPath,
  ];
  await symlink(".", join(options.projectRoot, "link"));
  const alias = join(options.projectRoot, "link/.hack.secret.key");
  const hardlink = join(options.projectRoot, "key-hardlink");
  await link(keyPath, hardlink);
  protectedPaths.push(alias, hardlink);
  const caseAlias = join(options.projectRoot, ".HACK.SECRET.KEY");
  if (await Bun.file(caseAlias).exists()) {
    protectedPaths.push(caseAlias);
  }
  const candidates = await collectLegacyProjectEnvCleanupCandidates({
    ...options,
    overlayNames: [],
    materialize: false,
    deliveredValues: new Map(),
    configCleanupCandidates: protectedPaths,
    composeEnvFileReferences: [],
  });
  expect(candidates.allowed).toEqual([]);
  const ordinary = join(options.projectRoot, "legacy-artifact");
  await writeFile(ordinary, "keep-before-refusal\n");
  for (const path of protectedPaths) {
    const before = await readFile(path);
    await expect(
      removeLegacyProjectEnvArtifacts({
        projectRoot: options.projectRoot,
        paths: [ordinary, path],
      })
    ).rejects.toThrow("current project env key");
    expect(await readFile(path)).toEqual(before);
    expect(await Bun.file(ordinary).exists()).toBe(true);
  }
});

test("deletion protects live inputs in a legacy .dev project", async () => {
  const options = await fixture(".dev");
  const layerPath = join(options.projectDir, "hack.env.default.yaml");
  await writeFile(
    join(options.projectDir, "hack.config.json"),
    '{"name":"fixture"}\n'
  );
  await writeFile(
    layerPath,
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await expect(
    removeLegacyProjectEnvArtifacts({
      projectRoot: options.projectRoot,
      paths: [layerPath],
    })
  ).rejects.toThrow("current project env key");
  expect(await Bun.file(layerPath).exists()).toBe(true);
});

test("an unrelated .dev file does not block cleanup in a .hack project", async () => {
  const options = await fixture();
  await writeFile(
    join(options.projectRoot, ".dev"),
    "unrelated fixture file\n"
  );
  const ordinary = join(options.projectRoot, "legacy-artifact");
  await writeFile(ordinary, "fixture\n");
  expect(
    await removeLegacyProjectEnvArtifacts({
      projectRoot: options.projectRoot,
      paths: [ordinary],
    })
  ).toEqual([ordinary]);
  expect(await readFile(join(options.projectRoot, ".dev"), "utf8")).toBe(
    "unrelated fixture file\n"
  );
});
