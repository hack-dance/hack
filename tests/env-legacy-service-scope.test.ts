import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";

import { LEGACY_ENV_SERVICE_SCOPE_MESSAGE } from "../src/cli/env-arguments.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { ClosedCliError, HackCliError } from "../src/lib/cli-result.ts";
import {
  ENV_SCOPE_INVALID_MESSAGE,
  findUnmigratedLegacyDotenv,
  inspectProjectEnvMaterialization,
  LegacyDotenvMigrationRefusalError,
  type LegacyProjectEnvMigration,
  migrateLegacyProjectEnv,
  ProjectEnvLayerPathConflictError,
  projectEnvConfigExistsForMutation,
  resolveProjectEnvConfig,
  selectProjectEnvValues,
} from "../src/lib/project-env-config.ts";
import { resolveEnvMeta } from "../src/lib/project-meta.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1370: `hack env set`/`unset` in a legacy `.hack/.env` project refuse a
 * `--service` scope instead of silently changing the global value; a layer
 * entry that is not a usable file refuses (E_PATH_CONFLICT) instead of
 * selecting the legacy file; reads of an invalid layer print one closed
 * line, never a stack; and the doctor migration the refusal names keeps the
 * gitignored values out of tracked layers and refuses, writing nothing, what
 * it cannot migrate safely.
 *
 * Isolation: every child gets a private HOME, global config and Docker client
 * config inside a temp directory, and an `encrypted_file` secret backend in
 * that directory with an env-provided key and the keychain fallback disabled,
 * so no keychain, Docker socket or user file is reached even if a guard under
 * test is removed. Every value is a synthetic test string.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const NEW_VALUE = ["synthetic", "legacy", "scope", "7e41"].join("-");
const KEPT_VALUE = ["synthetic", "kept", "c0d2"].join("-");
const BAD_SCOPE_ARGUMENT = "Bad Scope synthetic-91fa!";
const LAYER = `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    KEPT_SETTING: ${KEPT_VALUE}\n`;

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly storePath: string;
};

async function createLegacyRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-legacy-scope-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  const storePath = resolve(root, "secrets.enc.json");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "env-legacy-scope",
        dev_host: "env-legacy-scope.hack",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: storePath },
          },
        },
      },
      null,
      2
    )}\n`
  );
  return { root, projectRoot, projectDir, storePath };
}

type CliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runCli(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly logger?: string;
}): Promise<CliRun> {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.repo.projectRoot,
    env: privateCliEnv({
      root: opts.repo.root,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
        HACK_HOME: join(opts.repo.root, "hack-home"),
        HACK_LOGGER: opts.logger ?? "console",
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_FILE_KEY: ["legacy", "scope", "test", "key"].join("-"),
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(opts.stdin ?? "");
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Output lines that carry text, ignoring the clack frame (`│`, `■`, ...). */
function textLines(run: CliRun): string[] {
  return `${run.stdout}\n${run.stderr}`
    .split("\n")
    .filter((line) => /[A-Za-z]/.test(line));
}

/** A refusal: exit 1, the message on the first text line, no stack or value. */
function expectRefusal(
  run: CliRun,
  expected: string,
  opts: { readonly lines: number }
): void {
  expect(run.exitCode).toBe(1);
  const lines = textLines(run);
  expect(lines).toHaveLength(opts.lines);
  expect(lines[0]).toContain(expected);
  const output = `${run.stdout}${run.stderr}`;
  expect(output).not.toMatch(/\bat\s.*\.ts:\d+/);
  expect(output).not.toContain(REPO_ROOT);
  expect(output).not.toContain(NEW_VALUE);
  expect(output).not.toContain(KEPT_VALUE);
}

async function hackDirEntries(repo: Repo): Promise<string[]> {
  return (await readdir(repo.projectDir)).sort();
}

const LEGACY_BASE_ENTRIES = [
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
].sort();

test("legacy env set refuses a service scope and writes nothing", async () => {
  const repo = await createLegacyRepo();
  for (const extra of [[], ["--secret"]] as const) {
    const run = await runCli({
      repo,
      args: [
        "env",
        "set",
        "NEW_SETTING",
        "--service",
        "api",
        ...extra,
        "--value-stdin",
        "--path",
        repo.projectRoot,
      ],
      stdin: `${NEW_VALUE}\n`,
    });
    // The usage refusal plus the one-line pointer to the command's help.
    expectRefusal(run, LEGACY_ENV_SERVICE_SCOPE_MESSAGE, { lines: 2 });
    expect(textLines(run)[1]).toBe("See `hack env set --help` for usage.");
  }
  expect(await hackDirEntries(repo)).toEqual(LEGACY_BASE_ENTRIES);
  // Neither the plaintext path nor the secret store was reached.
  expect(await lstat(repo.storePath).catch(() => null)).toBeNull();
});

test("legacy env set refuses an invalid scope with the value-free scope message", async () => {
  const repo = await createLegacyRepo();
  const run = await runCli({
    repo,
    args: [
      "env",
      "set",
      "NEW_SETTING",
      "--service",
      BAD_SCOPE_ARGUMENT,
      "--value-stdin",
      "--path",
      repo.projectRoot,
    ],
    stdin: `${NEW_VALUE}\n`,
  });
  // The same closed one-line refusal as in an env-layer project.
  expectRefusal(run, ENV_SCOPE_INVALID_MESSAGE, { lines: 1 });
  expect(`${run.stdout}${run.stderr}`).not.toContain("synthetic-91fa");
  expect(await hackDirEntries(repo)).toEqual(LEGACY_BASE_ENTRIES);
});

test("legacy env set still writes the global value without --service or with --service global", async () => {
  const repo = await createLegacyRepo();
  for (const scopeArgs of [[], ["--service", "global"]] as const) {
    const run = await runCli({
      repo,
      args: [
        "env",
        "set",
        "NEW_SETTING",
        ...scopeArgs,
        "--value-stdin",
        "--path",
        repo.projectRoot,
      ],
      stdin: `${NEW_VALUE}\n`,
    });
    expect(run.exitCode).toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toContain(NEW_VALUE);
  }
  const dotenv = await readFile(resolve(repo.projectDir, ".env"), "utf8");
  expect(
    dotenv.split("\n").filter((line) => line.startsWith("NEW_SETTING="))
  ).toHaveLength(1);
  // Still legacy: no env layer was created.
  expect(
    (await hackDirEntries(repo)).filter((name) => name.endsWith(".yaml"))
  ).toEqual([]);
});

test("legacy env unset refuses a service scope and keeps the global value", async () => {
  const repo = await createLegacyRepo();
  const envFile = resolve(repo.projectDir, ".env");
  const dotenv = `KEPT_SETTING=${KEPT_VALUE}\n`;
  await writeFile(envFile, dotenv);

  for (const scope of ["api", BAD_SCOPE_ARGUMENT]) {
    const run = await runCli({
      repo,
      args: [
        "env",
        "unset",
        "KEPT_SETTING",
        "--service",
        scope,
        "--path",
        repo.projectRoot,
      ],
    });
    expectRefusal(
      run,
      scope === "api"
        ? LEGACY_ENV_SERVICE_SCOPE_MESSAGE
        : ENV_SCOPE_INVALID_MESSAGE,
      // Only the usage refusal adds a pointer to the command's help.
      { lines: scope === "api" ? 2 : 1 }
    );
    expect(`${run.stdout}${run.stderr}`).not.toContain("synthetic-91fa");
  }
  expect(await readFile(envFile, "utf8")).toBe(dotenv);
  expect(await lstat(repo.storePath).catch(() => null)).toBeNull();
});

type LayerEntry = {
  readonly name: string;
  readonly kind: "dangling-link" | "directory" | "link-to-directory";
};

const UNUSABLE_LAYER_ENTRIES: readonly LayerEntry[] = [
  { name: "hack.env.default.yaml", kind: "dangling-link" },
  { name: "hack.env.staging.yaml", kind: "dangling-link" },
  { name: "hack.env.local.yaml", kind: "link-to-directory" },
  { name: "hack.env.default.yaml", kind: "directory" },
];

async function placeLayerEntry(repo: Repo, entry: LayerEntry): Promise<string> {
  const path = resolve(repo.projectDir, entry.name);
  if (entry.kind === "directory") {
    await mkdir(path);
  } else if (entry.kind === "link-to-directory") {
    await mkdir(resolve(repo.root, "elsewhere"), { recursive: true });
    await symlink(resolve(repo.root, "elsewhere"), path);
  } else {
    await symlink(resolve(repo.projectDir, "missing-layer.yaml"), path);
  }
  return path;
}

for (const entry of UNUSABLE_LAYER_ENTRIES) {
  test(`env set and unset refuse a ${entry.kind} ${entry.name} instead of falling back to .hack/.env`, async () => {
    const repo = await createLegacyRepo();
    const path = await placeLayerEntry(repo, entry);
    const before = await hackDirEntries(repo);
    const refusal = `E_PATH_CONFLICT: Refusing to choose the env format: ${path} is not a regular file`;

    const set = await runCli({
      repo,
      args: [
        "env",
        "set",
        "NEW_SETTING",
        "--value-stdin",
        "--path",
        repo.projectRoot,
      ],
      stdin: `${NEW_VALUE}\n`,
    });
    expectRefusal(set, refusal, { lines: 1 });

    const unset = await runCli({
      repo,
      args: ["env", "unset", "NEW_SETTING", "--path", repo.projectRoot],
    });
    expectRefusal(unset, refusal, { lines: 1 });
    // Nothing was written and the entry is left as it was.
    expect(await hackDirEntries(repo)).toEqual(before);
    if (entry.kind === "dangling-link") {
      expect(await readlink(path)).toBe(
        resolve(repo.projectDir, "missing-layer.yaml")
      );
    }
    expect(await lstat(repo.storePath).catch(() => null)).toBeNull();
  }, 60_000);
}

for (const entry of UNUSABLE_LAYER_ENTRIES) {
  test(`env list and explain refuse a ${entry.kind} ${entry.name} instead of reading .hack/.env`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `KEPT_SETTING=${KEPT_VALUE}\n`
    );
    const path = await placeLayerEntry(repo, entry);
    const before = await hackDirEntries(repo);
    const refusal = `E_PATH_CONFLICT: Refusing to choose the env format: ${path} is not a regular file`;
    // An overlay layer is read only when that overlay is selected.
    const envArgs =
      entry.name === "hack.env.staging.yaml" ? ["--env", "staging"] : [];

    for (const args of [
      ["env", "list"],
      ["env", "explain", "KEPT_SETTING"],
    ]) {
      const run = await runCli({
        repo,
        args: [...args, ...envArgs, "--path", repo.projectRoot],
      });
      expectRefusal(run, refusal, { lines: 1 });
    }
    expect(await hackDirEntries(repo)).toEqual(before);
  }, 60_000);
}

test("a symlinked overlay that resolves to a regular layer selects the env layers", async () => {
  const repo = await createLegacyRepo();
  const target = resolve(repo.root, "shared-staging.yaml");
  await writeFile(
    target,
    LAYER.replace("environment: default", "environment: staging")
  );
  await symlink(target, resolve(repo.projectDir, "hack.env.staging.yaml"));
  expect(
    await projectEnvConfigExistsForMutation({ projectDir: repo.projectDir })
  ).toBe(true);

  const run = await runCli({
    repo,
    args: [
      "env",
      "set",
      "NEW_SETTING",
      "--service",
      "api",
      "--value-stdin",
      "--path",
      repo.projectRoot,
    ],
    stdin: `${NEW_VALUE}\n`,
  });
  expect(run.exitCode).toBe(0);
  expect(`${run.stdout}${run.stderr}`).not.toContain(NEW_VALUE);
  // Written to the default env layer, never to the legacy file.
  expect(
    await lstat(resolve(repo.projectDir, ".env")).catch(() => null)
  ).toBeNull();
  const layer = await readFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    "utf8"
  );
  expect(layer).toContain("api:");
  expect(layer).toContain("NEW_SETTING");
});

test("the mutation format check accepts regular layers and refuses unusable entries as closed path conflicts", async () => {
  const legacy = await createLegacyRepo();
  expect(
    await projectEnvConfigExistsForMutation({ projectDir: legacy.projectDir })
  ).toBe(false);

  const modern = await createLegacyRepo();
  await writeFile(resolve(modern.projectDir, "hack.env.default.yaml"), LAYER);
  expect(
    await projectEnvConfigExistsForMutation({ projectDir: modern.projectDir })
  ).toBe(true);

  for (const entry of UNUSABLE_LAYER_ENTRIES) {
    const repo = await createLegacyRepo();
    const path = await placeLayerEntry(repo, entry);
    const error = await projectEnvConfigExistsForMutation({
      projectDir: repo.projectDir,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectEnvLayerPathConflictError);
    expect(error).toBeInstanceOf(HackCliError);
    const conflict = error as ProjectEnvLayerPathConflictError;
    expect(conflict.code).toBe("E_PATH_CONFLICT");
    expect(conflict.path).toBe(path);
    expect(conflict.message.split("\n")).toHaveLength(1);
  }
});

const INVALID_LAYERS = [
  { name: "invalid YAML", text: `${LAYER}version: [\n` },
  {
    name: "a scope name with a line break",
    text: `${LAYER}  "bad\\nscope synthetic-91fa": {}\n`,
  },
] as const;

for (const logger of ["console", "clack", "gum"] as const) {
  test(`env list and explain on an invalid layer print one line with HACK_LOGGER=${logger}`, async () => {
    const repo = await createLegacyRepo();
    const file = resolve(repo.projectDir, "hack.env.default.yaml");
    for (const invalid of INVALID_LAYERS) {
      await writeFile(file, invalid.text);
      for (const args of [
        ["env", "list"],
        ["env", "explain", "KEPT_SETTING"],
      ]) {
        const run = await runCli({
          repo,
          args: [...args, "--path", repo.projectRoot],
          logger,
        });
        expectRefusal(run, `Failed to parse ${file}:`, { lines: 1 });
        expect(`${run.stdout}${run.stderr}`).not.toContain("synthetic-91fa");
      }
      expect(await readFile(file, "utf8")).toBe(invalid.text);
    }
  }, 60_000);
}

test("an invalid layer read is a closed error with a value-free scope reason", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    INVALID_LAYERS[1].text
  );
  const error = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: null,
    serviceNames: ["api"],
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ClosedCliError);
  const message = (error as Error).message;
  expect(message).toContain("Invalid env scope name");
  expect(message).not.toContain("synthetic-91fa");
  expect(message.split("\n")).toHaveLength(1);
});

const BASE_ONLY_VALUE = ["synthetic", "base", "5b19"].join("-");
const STAGING_VALUE = ["synthetic", "staging", "a3e7"].join("-");

/** Parsed `values` of one env layer file. */
async function readLayerValues(
  repo: Repo,
  name: string
): Promise<Record<string, Record<string, unknown>>> {
  const parsed = YAML.parse(
    await readFile(resolve(repo.projectDir, name), "utf8")
  ) as { values: Record<string, Record<string, unknown>> };
  return parsed.values;
}

/** The migration `hack doctor --migrate-env-config` runs (HACK-1370). */
async function migrateLegacyRepo(
  repo: Repo,
  opts: { readonly migrateUndeclaredDotenv?: boolean }
): Promise<LegacyProjectEnvMigration> {
  return await migrateLegacyProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "env-legacy-scope",
    serviceNames: ["api"],
    materialize: false,
    ...opts,
  });
}

async function serviceScopedSet(repo: Repo): Promise<CliRun> {
  return await runCli({
    repo,
    args: [
      "env",
      "set",
      "NEW_SETTING",
      "--service",
      "api",
      "--value-stdin",
      "--path",
      repo.projectRoot,
    ],
    stdin: `${NEW_VALUE}\n`,
  });
}

test("the migration the refusal names converts a project with only .hack/.env, and a service-scoped set then works", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\nSHARED_SETTING=${BASE_ONLY_VALUE}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `KEPT_SETTING=${KEPT_VALUE}\nSHARED_SETTING=${STAGING_VALUE}\n`
  );
  const configPath = resolve(repo.projectDir, PROJECT_CONFIG_FILENAME);
  const configBefore = await readFile(configPath, "utf8");
  expectRefusal(
    await serviceScopedSet(repo),
    LEGACY_ENV_SERVICE_SCOPE_MESSAGE,
    { lines: 2 }
  );

  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
  // Machine-local layers first, then the tracked layers that switch format.
  expect(migrated.wroteFiles).toEqual([
    resolve(repo.projectDir, "hack.env.local.yaml"),
    resolve(repo.projectDir, "hack.env.staging.local.yaml"),
    resolve(repo.projectDir, "hack.env.default.yaml"),
    resolve(repo.projectDir, "hack.env.staging.yaml"),
  ]);
  // Every base entry is a machine-local global value; the overlay keeps only
  // what differs. The tracked layers hold no values.
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { KEPT_SETTING: KEPT_VALUE, SHARED_SETTING: BASE_ONLY_VALUE },
  });
  expect(await readLayerValues(repo, "hack.env.staging.local.yaml")).toEqual({
    global: { SHARED_SETTING: STAGING_VALUE },
  });
  expect(await readLayerValues(repo, "hack.env.default.yaml")).toEqual({
    global: {},
  });
  expect(await readLayerValues(repo, "hack.env.staging.yaml")).toEqual({
    global: {},
  });
  // The resolved env still carries every value.
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    envName: "staging",
    serviceNames: ["api"],
  });
  expect(resolved?.globalEnv).toEqual({
    KEPT_SETTING: KEPT_VALUE,
    SHARED_SETTING: STAGING_VALUE,
  });
  // Without a contract nothing names secret-backend values: the project config
  // and its secret backend store are left alone and never offered for cleanup.
  expect(migrated.updatedProjectConfig).toBe(false);
  expect(await readFile(configPath, "utf8")).toBe(configBefore);
  expect(migrated.cleanupCandidates).toEqual([
    resolve(repo.projectDir, ".env"),
    resolve(repo.projectDir, ".env.staging"),
  ]);
  expect(migrated.blockedCleanupCandidates).toEqual([]);

  // The refusal no longer applies: the set lands in the api scope.
  const run = await serviceScopedSet(repo);
  expect(run.exitCode).toBe(0);
  expect(`${run.stdout}${run.stderr}`).not.toContain(NEW_VALUE);
  const values = await readLayerValues(repo, "hack.env.default.yaml");
  expect(values.global).toEqual({});
  expect(Object.keys(values.api ?? {})).toEqual(["NEW_SETTING"]);
  expect(await lstat(repo.storePath).catch(() => null)).toBeNull();
}, 60_000);

const PASSWORD_VALUE = ["synthetic", "db", "password", "e8a1"].join("-");
const STRIPE_VALUE = ["sk", "test", "synthetic", "4f0c9b"].join("_");

async function git(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
}): Promise<string> {
  const proc = Bun.spawn(["git", "-C", opts.repo.projectRoot, ...opts.args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: opts.repo.root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Synthetic",
      GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic",
      GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(exitCode).toBe(0);
  return stdout;
}

test("the migration keeps secret-shaped values from the gitignored .hack/.env out of every file git would commit", async () => {
  const repo = await createLegacyRepo();
  await git({ repo, args: ["init", "-q"] });
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `DATABASE_PASSWORD=${PASSWORD_VALUE}\nSTRIPE_SECRET_KEY=${STRIPE_VALUE}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `STRIPE_SECRET_KEY=${STRIPE_VALUE}-staging\n`
  );

  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.wroteFiles).toContain(
    resolve(repo.projectDir, "hack.env.default.yaml")
  );
  // Every file git would add (tracked or untracked, not ignored) is free of
  // the values; the machine-local layers that hold them are ignored.
  const committable = (
    await git({
      repo,
      args: ["ls-files", "--cached", "--others", "--exclude-standard"],
    })
  )
    .split("\n")
    .filter((line) => line.length > 0);
  expect(committable).toContain(".hack/hack.env.default.yaml");
  expect(committable).toContain(".hack/hack.env.staging.yaml");
  expect(committable).not.toContain(".hack/hack.env.local.yaml");
  expect(committable).not.toContain(".hack/hack.env.staging.local.yaml");
  // The legacy overlay input itself is outside the managed ignore block; the
  // migration only reads it (and offers it for cleanup).
  for (const path of committable.filter(
    (entry) => entry !== ".hack/.env.staging"
  )) {
    const text = await readFile(resolve(repo.projectRoot, path), "utf8");
    expect(text).not.toContain(PASSWORD_VALUE);
    expect(text).not.toContain(STRIPE_VALUE);
  }
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: {
      DATABASE_PASSWORD: PASSWORD_VALUE,
      STRIPE_SECRET_KEY: STRIPE_VALUE,
    },
  });
  expect(await readLayerValues(repo, "hack.env.staging.local.yaml")).toEqual({
    global: { STRIPE_SECRET_KEY: `${STRIPE_VALUE}-staging` },
  });
}, 60_000);

/** The legacy files and the .hack entries, to prove a refusal wrote nothing. */
async function legacySnapshot(repo: Repo): Promise<{
  readonly entries: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}> {
  const entries = await hackDirEntries(repo);
  const files: Record<string, string> = {};
  for (const name of entries.filter((entry) => entry.startsWith(".env"))) {
    files[name] = await readFile(resolve(repo.projectDir, name), "utf8");
  }
  return { entries, files };
}

async function expectMigrationRefusal(opts: {
  readonly repo: Repo;
  readonly code: LegacyDotenvMigrationRefusalError["code"];
  readonly reason: string;
  readonly hidden: readonly string[];
}): Promise<void> {
  const before = await legacySnapshot(opts.repo);
  const error = await migrateLegacyRepo(opts.repo, {
    migrateUndeclaredDotenv: true,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
  const refusal = error as LegacyDotenvMigrationRefusalError;
  expect(refusal.code).toBe(opts.code);
  expect(refusal.message).toContain(opts.reason);
  expect(refusal.message).toContain(
    "Nothing was written, and the legacy files are kept."
  );
  expect(refusal.message.split("\n")).toHaveLength(1);
  for (const hidden of opts.hidden) {
    expect(refusal.message).not.toContain(hidden);
  }
  expect(await legacySnapshot(opts.repo)).toEqual(before);
}

test("the migration refuses keys an env layer cannot hold, counting them without showing keys or values", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `GOOD_KEY=${KEPT_VALUE}\nnode_env=${BASE_ONLY_VALUE}\nexport OTHER=${STAGING_VALUE}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `GOOD_KEY=${NEW_VALUE}\nlower_case=${NEW_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: "2 keys in .env, 1 key in .env.staging do not",
    hidden: [
      "node_env",
      "export OTHER",
      "lower_case",
      KEPT_VALUE,
      BASE_ONLY_VALUE,
      STAGING_VALUE,
      NEW_VALUE,
    ],
  });
});

for (const name of [".env.default", ".env.local", ".env.staging.local"]) {
  test(`the migration refuses a legacy ${name}, whose layer would not be an overlay`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `KEPT_SETTING=${KEPT_VALUE}\n`
    );
    await writeFile(
      resolve(repo.projectDir, name),
      `SHARED_SETTING=${STAGING_VALUE}\n`
    );
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: `${JSON.stringify(name)} would become the default or a machine-local env layer`,
      hidden: [KEPT_VALUE, STAGING_VALUE],
    });
  });
}

test("the migration refuses a machine-local target that git tracks", async () => {
  const repo = await createLegacyRepo();
  await git({ repo, args: ["init", "-q"] });
  const localPath = resolve(repo.projectDir, "hack.env.local.yaml");
  await writeFile(localPath, LAYER);
  await git({ repo, args: ["add", "-f", ".hack/hack.env.local.yaml"] });
  // Still in the index, gone from the working tree.
  await rm(localPath);
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_PATH_CONFLICT",
    reason: `git tracks the machine-local env layer ${localPath}`,
    hidden: [KEPT_VALUE],
  });
}, 60_000);

test("the migration refuses existing layer entries and never writes through or replaces them", async () => {
  // A symlinked overlay counts as an existing env layer: refused, and the
  // link target keeps its content.
  const linked = await createLegacyRepo();
  await writeFile(resolve(linked.projectDir, ".env"), `OWNED=${KEPT_VALUE}\n`);
  await writeFile(
    resolve(linked.projectDir, ".env.staging"),
    `OWNED=${STAGING_VALUE}\n`
  );
  const target = resolve(linked.root, "outside-staging.yaml");
  const targetText = LAYER.replace(
    "environment: default",
    "environment: staging"
  );
  await writeFile(target, targetText);
  await symlink(target, resolve(linked.projectDir, "hack.env.staging.yaml"));
  await expectMigrationRefusal({
    repo: linked,
    code: "E_PATH_CONFLICT",
    reason: `env layer files already exist in ${linked.projectDir}`,
    hidden: [KEPT_VALUE, STAGING_VALUE],
  });
  expect(await readFile(target, "utf8")).toBe(targetText);

  // A dangling default layer is a path conflict, and stays a symlink.
  const dangling = await createLegacyRepo();
  await writeFile(
    resolve(dangling.projectDir, ".env"),
    `OWNED=${KEPT_VALUE}\n`
  );
  const path = await placeLayerEntry(dangling, {
    name: "hack.env.default.yaml",
    kind: "dangling-link",
  });
  const before = await legacySnapshot(dangling);
  const error = await migrateLegacyRepo(dangling, {
    migrateUndeclaredDotenv: true,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProjectEnvLayerPathConflictError);
  expect((error as ProjectEnvLayerPathConflictError).path).toBe(path);
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await legacySnapshot(dangling)).toEqual(before);
});

test("an explicit migration of a project with no legacy env file switches it to an empty default layer", async () => {
  const repo = await createLegacyRepo();
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
  expect(migrated.wroteFiles).toEqual([
    resolve(repo.projectDir, "hack.env.default.yaml"),
  ]);
  expect(migrated.cleanupCandidates).toEqual([]);
  expect(await readLayerValues(repo, "hack.env.default.yaml")).toEqual({
    global: {},
  });
  const run = await serviceScopedSet(repo);
  expect(run.exitCode).toBe(0);
  const values = await readLayerValues(repo, "hack.env.default.yaml");
  expect(Object.keys(values.api ?? {})).toEqual(["NEW_SETTING"]);
}, 60_000);

test("the implicit migrations other commands run still need the hack.env.json contract", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const before = await hackDirEntries(repo);
  const migrated = await migrateLegacyRepo(repo, {});
  expect(migrated.legacyDetected).toBe(false);
  expect(migrated.wroteFiles).toEqual([]);
  expect(await hackDirEntries(repo)).toEqual(before);
});

test("the contract migration refuses a dangling default layer and never replaces it", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "KEPT_SETTING", source: "plain_env", required: false }],
    })}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const path = await placeLayerEntry(repo, {
    name: "hack.env.default.yaml",
    kind: "dangling-link",
  });
  const before = await hackDirEntries(repo);
  const error = await migrateLegacyRepo(repo, {}).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ProjectEnvLayerPathConflictError);
  expect((error as ProjectEnvLayerPathConflictError).path).toBe(path);
  expect(await readlink(path)).toBe(
    resolve(repo.projectDir, "missing-layer.yaml")
  );
  expect(await hackDirEntries(repo)).toEqual(before);

  // A linked regular overlay means env layers are in use: nothing is migrated.
  await rm(path);
  const target = resolve(repo.root, "shared-staging.yaml");
  await writeFile(
    target,
    LAYER.replace("environment: default", "environment: staging")
  );
  await symlink(target, resolve(repo.projectDir, "hack.env.staging.yaml"));
  const linked = await hackDirEntries(repo);
  const migrated = await migrateLegacyRepo(repo, {});
  expect(migrated.legacyDetected).toBe(false);
  expect(migrated.wroteFiles).toEqual([]);
  expect(await hackDirEntries(repo)).toEqual(linked);
});

test("doctor and project metadata report a dangling default layer instead of the legacy format", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const path = await placeLayerEntry(repo, {
    name: "hack.env.default.yaml",
    kind: "dangling-link",
  });
  const refusal = `Refusing to choose the env format: ${path} is not a regular file`;

  const meta = await resolveEnvMeta({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    composeFile: resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    projectName: "env-legacy-scope",
  });
  expect(meta.contractParseError).toContain(refusal);
  expect(meta.vars).toEqual([]);

  const run = await runCli({
    repo,
    args: ["doctor", "--json", "--path", repo.projectRoot],
  });
  expect(`${run.stdout}${run.stderr}`).not.toContain(KEPT_VALUE);
  const checks = (
    JSON.parse(run.stdout) as {
      readonly data: {
        readonly checks: readonly {
          readonly id: string;
          readonly status: string;
          readonly detail: string;
        }[];
      };
    }
  ).data.checks;
  const envMode = checks.find((check) => check.id === "env mode");
  expect(envMode?.status).toBe("error");
  expect(envMode?.detail).toContain(refusal);
  expect(await readlink(path)).toBe(
    resolve(repo.projectDir, "missing-layer.yaml")
  );
}, 120_000);

const RUNS_AS_ROOT = (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0;

test.skipIf(RUNS_AS_ROOT)(
  "env list and explain refuse an unreadable default layer with one closed line",
  async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `KEPT_SETTING=${KEPT_VALUE}\n`
    );
    const file = resolve(repo.projectDir, "hack.env.default.yaml");
    await writeFile(file, LAYER);
    await chmod(file, 0o000);
    try {
      for (const args of [
        ["env", "list"],
        ["env", "explain", "KEPT_SETTING"],
      ]) {
        const run = await runCli({
          repo,
          args: [...args, "--path", repo.projectRoot],
        });
        expectRefusal(run, `Cannot read the env layer ${file}.`, {
          lines: 1,
        });
      }
    } finally {
      await chmod(file, 0o600);
    }
    expect(await readFile(file, "utf8")).toBe(LAYER);
  },
  60_000
);

test("the migration refuses a legacy .env.<name> whose name is not an overlay name", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  // A control character in a file name must not break the one-line refusal.
  for (const name of [".env.staging.old", ".env.Prod", ".env.bad\nname"]) {
    await writeFile(
      resolve(repo.projectDir, name),
      `SHARED_SETTING=${STAGING_VALUE}\n`
    );
  }
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: '".env.bad\\nname", ".env.Prod", ".env.staging.old" in',
    hidden: [KEPT_VALUE, STAGING_VALUE],
  });
});

test("the migration leaves template and backup copies alone and never offers a git-tracked legacy file for cleanup", async () => {
  const repo = await createLegacyRepo();
  await git({ repo, args: ["init", "-q"] });
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const staging = resolve(repo.projectDir, ".env.staging");
  await writeFile(staging, `KEPT_SETTING=${STAGING_VALUE}\n`);
  await git({ repo, args: ["add", "-f", ".hack/.env.staging"] });
  const copies: Record<string, string> = {
    ".env.example": "KEPT_SETTING=placeholder\n",
    ".env.bak": `KEPT_SETTING=${BASE_ONLY_VALUE}\n`,
  };
  for (const [name, text] of Object.entries(copies)) {
    await writeFile(resolve(repo.projectDir, name), text);
  }

  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  // The tracked overlay is migrated, but only the untracked .env is offered.
  expect(migrated.migratedOverlays).toEqual(["staging"]);
  expect(await readLayerValues(repo, "hack.env.staging.local.yaml")).toEqual({
    global: { KEPT_SETTING: STAGING_VALUE },
  });
  expect(migrated.cleanupCandidates).toEqual([
    resolve(repo.projectDir, ".env"),
  ]);
  for (const [name, text] of Object.entries(copies)) {
    expect(await readFile(resolve(repo.projectDir, name), "utf8")).toBe(text);
  }
  const entries = await hackDirEntries(repo);
  expect(entries).not.toContain("hack.env.example.yaml");
  expect(entries).not.toContain("hack.env.bak.yaml");
}, 60_000);

test.skipIf(RUNS_AS_ROOT)(
  "the migration refuses an unreadable legacy file instead of migrating it as empty",
  async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `KEPT_SETTING=${KEPT_VALUE}\n`
    );
    const staging = resolve(repo.projectDir, ".env.staging");
    await writeFile(staging, `KEPT_SETTING=${STAGING_VALUE}\n`);
    await chmod(staging, 0o000);
    const before = await hackDirEntries(repo);
    try {
      const error = await migrateLegacyRepo(repo, {
        migrateUndeclaredDotenv: true,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
      const refusal = error as LegacyDotenvMigrationRefusalError;
      expect(refusal.code).toBe("E_PERMISSION");
      expect(refusal.message).toContain(`${staging} exists but cannot be read`);
      expect(refusal.message).not.toContain(KEPT_VALUE);
      expect(await hackDirEntries(repo)).toEqual(before);
    } finally {
      await chmod(staging, 0o600);
    }
    expect(await readFile(staging, "utf8")).toBe(
      `KEPT_SETTING=${STAGING_VALUE}\n`
    );
  }
);

test.skipIf(RUNS_AS_ROOT)(
  "the migration refuses when a read-only .hack/.gitignore leaves the machine-local layer unignored",
  async () => {
    const repo = await createLegacyRepo();
    await git({ repo, args: ["init", "-q"] });
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `KEPT_SETTING=${KEPT_VALUE}\n`
    );
    const gitignore = resolve(repo.projectDir, ".gitignore");
    await writeFile(gitignore, "# no managed block\n");
    await chmod(gitignore, 0o444);
    try {
      await expectMigrationRefusal({
        repo,
        code: "E_PATH_CONFLICT",
        reason: `git does not ignore the machine-local env layer ${resolve(repo.projectDir, "hack.env.local.yaml")}`,
        hidden: [KEPT_VALUE],
      });
    } finally {
      await chmod(gitignore, 0o644);
    }
  },
  60_000
);

test("the migration creates machine-local layers as private 0600 files", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `KEPT_SETTING=${STAGING_VALUE}\n`
  );
  const previous = process.umask(0o022);
  try {
    await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  } finally {
    process.umask(previous);
  }
  for (const name of ["hack.env.local.yaml", "hack.env.staging.local.yaml"]) {
    const mode = (await lstat(resolve(repo.projectDir, name))).mode & 0o777;
    expect({ name, mode }).toEqual({ name, mode: 0o600 });
  }
});

test("the migration carries a symlinked legacy overlay's values and refuses one it cannot read", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const target = resolve(repo.projectDir, "shared-staging.env");
  const targetText = `KEPT_SETTING=${KEPT_VALUE}-linked\n`;
  await writeFile(target, targetText);
  const link = resolve(repo.projectDir, ".env.staging");
  await symlink(target, link);

  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.migratedOverlays).toContain("staging");
  expect(
    await readFile(
      resolve(repo.projectDir, "hack.env.staging.local.yaml"),
      "utf8"
    )
  ).toContain(`${KEPT_VALUE}-linked`);
  expect(migrated.cleanupCandidates).toContain(link);
  expect(await readFile(target, "utf8")).toBe(targetText);

  for (const place of [
    (root: string) => resolve(root, "missing"),
    // A link to a directory inside .hack: reading it fails.
    (root: string) => resolve(root, "repo", ".hack"),
  ]) {
    const unusable = await createLegacyRepo();
    await symlink(
      place(unusable.root),
      resolve(unusable.projectDir, ".env.staging")
    );
    const before = await hackDirEntries(unusable);
    const error = await migrateLegacyRepo(unusable, {
      migrateUndeclaredDotenv: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
    expect((error as LegacyDotenvMigrationRefusalError).code).toBe(
      "E_PERMISSION"
    );
    expect(await hackDirEntries(unusable)).toEqual(before);
  }
});

test("the migration refuses when Compose uses a legacy file it would leave out", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env.sample\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env.sample"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: 'Compose env_file uses ".env.sample"',
    hidden: [KEPT_VALUE],
  });
});

test("the migration refuses when Compose uses an overlay a launch would not select", async () => {
  const repo = await createLegacyRepo();
  const compose = resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME);
  await writeFile(
    compose,
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env.staging\n"
  );
  await writeFile(resolve(repo.projectDir, ".env"), "SHARED=base\n");
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `SHARED=base\nKEPT_SETTING=${KEPT_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: 'Compose env_file uses ".env.staging"',
    hidden: [KEPT_VALUE],
  });

  // Selected by default, every launch still gets the values.
  await writeFile(
    resolve(repo.projectDir, "hack.config.json"),
    `${JSON.stringify({ env: { defaultOverlay: "staging" } })}\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.migratedOverlays).toContain("staging");
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api"],
  });
  if (!resolved) {
    throw new Error("expected env layers");
  }
  expect(
    selectProjectEnvValues({ resolved, scopeName: "api" }).KEPT_SETTING
  ).toBe(KEPT_VALUE);
});

test("the migration accepts a Compose overlay that adds nothing to the base", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env.staging\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.migratedOverlays).toContain("staging");
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api"],
  });
  if (!resolved) {
    throw new Error("expected env layers");
  }
  expect(
    selectProjectEnvValues({ resolved, scopeName: "api" }).KEPT_SETTING
  ).toBe(KEPT_VALUE);
});

test("after the migration, a migrated key's service override takes effect only with --local", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  const apiValue = async (): Promise<string | undefined> => {
    const resolved = await resolveProjectEnvConfig({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      serviceNames: ["api"],
    });
    if (!resolved) {
      throw new Error("expected env layers");
    }
    return selectProjectEnvValues({ resolved, scopeName: "api" }).KEPT_SETTING;
  };
  const set = async (extra: readonly string[]): Promise<void> => {
    const run = await runCli({
      repo,
      args: [
        "env",
        "set",
        "KEPT_SETTING",
        "--service",
        "api",
        ...extra,
        "--value-stdin",
        "--path",
        repo.projectRoot,
      ],
      stdin: `${NEW_VALUE}\n`,
    });
    expect(run.exitCode).toBe(0);
  };

  await set([]);
  expect(await apiValue()).toBe(KEPT_VALUE);
  await set(["--local"]);
  expect(await apiValue()).toBe(NEW_VALUE);
}, 60_000);

test("the migration refuses when a Compose environment value would lose precedence to a migrated .env value", async () => {
  const repo = await createLegacyRepo();
  const composeLegacyPort = ["3", "000"].join("");
  const composeExplicitPort = ["4", "000"].join("");
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    `services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n    environment:\n      PORT: "${composeExplicitPort}"\n  worker:\n    image: alpine:3.20\n    env_file: .env\n    environment:\n      - OTHER=1\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `PORT=${composeLegacyPort}\nKEPT_SETTING=${KEPT_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason:
      'Compose environment sets "PORT" in "api", which the legacy .env files also set',
    hidden: [composeLegacyPort, composeExplicitPort, KEPT_VALUE],
  });

  // Without the overlapping key the same shape migrates.
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { KEPT_SETTING: KEPT_VALUE },
  });
});

test("the .env-only migration refuses a legacy symlink that leaves .hack", async () => {
  for (const link of [".env", ".env.staging"]) {
    const repo = await createLegacyRepo();
    const target = resolve(repo.projectRoot, ".env");
    await writeFile(target, `KEPT_SETTING=${KEPT_VALUE}\n`);
    await symlink(target, resolve(repo.projectDir, link));
    await expectMigrationRefusal({
      repo,
      code: "E_PATH_CONFLICT",
      reason: `"${link}" is a symlink to a file outside .hack`,
      hidden: [KEPT_VALUE],
    });
  }
});

test("the contract migration does not copy a symlinked overlay's values into a tracked layer", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "KEPT_SETTING", source: "plain_env", required: false }],
    })}\n`
  );
  await writeFile(resolve(repo.projectDir, ".env"), "OTHER=1\n");
  const target = resolve(repo.projectRoot, ".env");
  await writeFile(target, `KEPT_SETTING=${KEPT_VALUE}\n`);
  await symlink(target, resolve(repo.projectDir, ".env.staging"));

  const migrated = await migrateLegacyRepo(repo, {});
  expect(migrated.migratedOverlays).not.toContain("staging");
  expect(
    await lstat(resolve(repo.projectDir, "hack.env.staging.yaml")).catch(
      () => null
    )
  ).toBeNull();
  for (const name of await readdir(repo.projectDir)) {
    if (name.startsWith("hack.env.") && name.endsWith(".yaml")) {
      expect(
        await readFile(resolve(repo.projectDir, name), "utf8")
      ).not.toContain(KEPT_VALUE);
    }
  }
});

test("the migration refuses when another Compose env_file sets a migrated key", async () => {
  const repo = await createLegacyRepo();
  const legacyPort = ["3", "000"].join("");
  const servicePort = ["4", "000"].join("");
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file:\n      - .env\n      - service.env\n      - path: absent.env\n        required: false\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `PORT=${legacyPort}\nKEPT_SETTING=${KEPT_VALUE}\n`
  );
  const serviceEnv = resolve(repo.projectDir, "service.env");
  await writeFile(serviceEnv, `PORT=${servicePort}\n`);
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: 'Compose env_file sets "PORT" ("service.env" in "api")',
    hidden: [legacyPort, servicePort, KEPT_VALUE],
  });

  // With no shared key, the same shape migrates.
  await writeFile(serviceEnv, "SERVICE_ONLY=1\n");
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the migration refuses when only some Compose services list a legacy file", async () => {
  const repo = await createLegacyRepo();
  const compose = resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME);
  await writeFile(
    compose,
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n  worker:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: '"worker" does not list ".env" in env_file',
    hidden: [KEPT_VALUE],
  });

  // Once every service lists it, none receives anything new.
  await writeFile(
    compose,
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n  worker:\n    image: alpine:3.20\n    env_file: [.env]\n"
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { KEPT_SETTING: KEPT_VALUE },
  });
});

test("the migration refuses a legacy overlay only some services list, and accepts one that adds nothing", async () => {
  const repo = await createLegacyRepo();
  const compose = resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME);
  await writeFile(
    resolve(repo.projectDir, "hack.config.json"),
    `${JSON.stringify({ env: { defaultOverlay: "staging" } })}\n`
  );
  await writeFile(
    compose,
    "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n  worker:\n    image: alpine:3.20\n    env_file: .env\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const overlay = resolve(repo.projectDir, ".env.staging");
  await writeFile(overlay, `KEPT_SETTING=${KEPT_VALUE}-staging\n`);
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: '"worker" does not list ".env.staging" in env_file',
    hidden: [KEPT_VALUE],
  });

  await writeFile(overlay, `KEPT_SETTING=${KEPT_VALUE}\n`);
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the migration goes ahead when no Compose service lists the legacy file", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n  worker:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { KEPT_SETTING: KEPT_VALUE },
  });
});

for (const entry of [
  "PORT: ${PORT}",
  "PORT: $PORT",
  "PORT: ${PORT:-1}",
  "PORT: ${PORT-1}",
  "PORT: ${PORT:?required}",
  "PORT: ${OTHER}",
  "PORT: ${PORT:-${OTHER}}",
  "PORT:",
]) {
  test(`a Compose environment entry "${entry}" stays a conflict`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
      `services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n    environment:\n      ${entry}\n`
    );
    await writeFile(resolve(repo.projectDir, ".env"), "PORT=2\n");
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: 'Compose environment sets "PORT" in "api"',
      hidden: [],
    });
  });
}

for (const line of [
  `PORT=3000 # ${KEPT_VALUE}`,
  `PORT=${KEPT_VALUE}$OTHER`,
  `PORT="${KEPT_VALUE}\${OTHER}"`,
]) {
  test(`the migration refuses a line Compose reads differently: ${line.slice(0, 7)}`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
      "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n"
    );
    await writeFile(resolve(repo.projectDir, ".env"), `${line}\n`);
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: "Compose reads 1 line in .env differently from Hack",
      hidden: [KEPT_VALUE],
    });
  });
}

test("the migration keeps values Compose and Hack read the same", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    [
      "# a comment with $ and # in it",
      `SINGLE='${KEPT_VALUE}$literal # kept'`,
      `QUOTED="${KEPT_VALUE} # kept"`,
      `FRAGMENT=${KEPT_VALUE}#kept`,
      "",
    ].join("\n")
  );
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: {
      SINGLE: `${KEPT_VALUE}$literal # kept`,
      QUOTED: `${KEPT_VALUE} # kept`,
      FRAGMENT: `${KEPT_VALUE}#kept`,
    },
  });
});

test("the migration refuses a service that gains keys from a file only another service lists as an identical overlay", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env.staging\n  worker:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: '"worker" lists no legacy file that sets "KEPT_SETTING"',
    hidden: [KEPT_VALUE],
  });
});

const UNCHECKABLE_COMPOSE: readonly (readonly [string, string, string])[] = [
  [
    "a service extends",
    "services:\n  api:\n    image: alpine:3.20\n    extends: {file: base.yml, service: b}\n  worker:\n    image: alpine:3.20\n",
    'extends in "api"',
  ],
  [
    "a top-level include",
    "include:\n  - other.yml\nservices:\n  worker:\n    image: alpine:3.20\n",
    "top-level include",
  ],
  [
    "a variable env_file path",
    "services:\n  api:\n    image: alpine:3.20\n    env_file: ${D:-.}/.env\n  worker:\n    image: alpine:3.20\n",
    'a variable env_file path in "api"',
  ],
  [
    "a repeated env_file entry",
    "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env.staging, .env, .env.staging]\n",
    'a repeated env_file entry in "api"',
  ],
  [
    "the same file spelled twice in env_file",
    "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, ./.env]\n",
    'a repeated env_file entry in "api"',
  ],
  [
    "a home-relative env_file path",
    "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, ~/x.env]\n",
    'a home-relative env_file path in "api"',
  ],
  [
    "a !reset tag",
    "services:\n  api:\n    image: alpine:3.20\n    env_file: !reset [.env]\n",
    "a !reset or !override tag",
  ],
  [
    "an !override tag",
    "services:\n  api:\n    image: alpine:3.20\n    env_file: !override [.env]\n",
    "a !reset or !override tag",
  ],
  [
    "an env_file format",
    "services:\n  api:\n    image: alpine:3.20\n    env_file:\n      - path: .env\n        format: raw\n",
    'an env_file format in "api"',
  ],
];

for (const [name, compose, reason] of UNCHECKABLE_COMPOSE) {
  test(`the migration refuses ${name} it cannot check`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
      compose
    );
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `KEPT_SETTING=${KEPT_VALUE}\n`
    );
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason,
      hidden: [KEPT_VALUE],
    });
  });
}

test("the migration names the keys every service gains when no service lists the legacy file", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\nOTHER=1\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.keysNewToEveryService).toEqual(["KEPT_SETTING", "OTHER"]);
  expect(JSON.stringify(migrated)).not.toContain(KEPT_VALUE);
});

test("the migration reports no new keys when every service lists the legacy file", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: ./.env\n  worker:\n    image: alpine:3.20\n    env_file:\n      - path: ../.hack/.env\n        required: false\n"
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.keysNewToEveryService).toEqual([]);
});

for (const [name, link, config] of [
  [".hack/.env", ".env", null],
  ["a default overlay", ".env.staging", "staging"],
] as const) {
  test(`the contract migration refuses ${name} linked out of .hack before writing`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, "hack.env.json"),
      `${JSON.stringify({
        version: 1,
        vars: [{ key: "KEPT_SETTING", source: "plain_env", required: false }],
      })}\n`
    );
    if (config) {
      await writeFile(
        resolve(repo.projectDir, PROJECT_CONFIG_FILENAME),
        `${JSON.stringify({ name: "env-legacy-scope", dev_host: "env-legacy-scope.hack", env: { defaultOverlay: config } })}\n`
      );
    }
    const target = resolve(repo.projectRoot, ".env");
    await writeFile(target, `KEPT_SETTING=${KEPT_VALUE}\n`);
    await symlink(target, resolve(repo.projectDir, link));
    const before = await hackDirEntries(repo);
    const error = await migrateLegacyRepo(repo, {}).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
    expect((error as LegacyDotenvMigrationRefusalError).code).toBe(
      "E_PATH_CONFLICT"
    );
    expect((error as Error).message).toContain(`"${link}" is a symlink`);
    expect((error as Error).message).not.toContain(KEPT_VALUE);
    expect(await hackDirEntries(repo)).toEqual(before);
  });
}

const COMPOSE_READS_DIFFERENTLY: readonly (readonly [string, string])[] = [
  ["a double-quoted escape", `P="${KEPT_VALUE}\\nabc"`],
  ["a double-quoted tab escape", `P="${KEPT_VALUE}\\tz"`],
  ["a multi-line $", `P="${KEPT_VALUE}\n$OTHER"`],
  ["a multi-line escape", `P="${KEPT_VALUE}\nabc\\n"`],
  ["a colon form", `P: ${KEPT_VALUE}`],
  ["a bare key", "P"],
  ["an entry after a single-quoted value", `P='${KEPT_VALUE}' B=2`],
  ["an entry after a double-quoted value", `P="${KEPT_VALUE}" B=2`],
  ["an entry touching a closing quote", `P='${KEPT_VALUE}'B=2`],
  ["a colon entry after a closing quote", `P='${KEPT_VALUE}' B: 2`],
  ["a double backslash in single quotes", `P='${KEPT_VALUE}\\\\b'`],
  ["an escaped quote in single quotes", `P='${KEPT_VALUE}\\'`],
];

for (const [name, content] of COMPOSE_READS_DIFFERENTLY) {
  test(`the migration refuses ${name}`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(resolve(repo.projectDir, ".env"), `${content}\n`);
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: "Compose reads 1 line in .env differently from Hack",
      hidden: [KEPT_VALUE],
    });
  });
}

test("the migration keeps a multi-line value in single quotes and does not read its lines as entries", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `PEM='${KEPT_VALUE}\nnot an entry $ =\nend'\nAFTER=1\nQUOTED="a\nb"\n`
  );
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: {
      PEM: `${KEPT_VALUE}\nnot an entry $ =\nend`,
      AFTER: "1",
      QUOTED: "a\nb",
    },
  });
});

async function writeDefaultOverlayRepo(opts: {
  readonly compose: string;
  readonly base: string;
  readonly overlay: string;
}): Promise<Repo> {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "env-legacy-scope", dev_host: "env-legacy-scope.hack", env: { defaultOverlay: "staging" } })}\n`
  );
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    opts.compose
  );
  await writeFile(resolve(repo.projectDir, ".env"), opts.base);
  await writeFile(resolve(repo.projectDir, ".env.staging"), opts.overlay);
  return repo;
}

test("the migration refuses a default overlay no service lists when a service lists the base", async () => {
  const repo = await writeDefaultOverlayRepo({
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n  worker:\n    image: alpine:3.20\n    env_file: .env\n",
    base: "A=1\n",
    overlay: `NEW=${KEPT_VALUE}\n`,
  });
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: '"api", "worker" do not list ".env.staging" in env_file',
    hidden: [KEPT_VALUE],
  });
});

test("the migration names an overlay's keys when no service lists that non-default overlay", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n"
  );
  await writeFile(resolve(repo.projectDir, ".env"), "A=1\n");
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `NEW=${KEPT_VALUE}\n`
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.keysNewToEveryService).toEqual(["NEW"]);
});

for (const reference of ["${PORT}", "$PORT", "${PORT:-1}"]) {
  test(`the migration refuses ${reference} when the default overlay changes that key`, async () => {
    const repo = await writeDefaultOverlayRepo({
      compose: `services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n    command: run ${reference}\n`,
      base: "PORT=2\n",
      overlay: "PORT=3\n",
    });
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: 'Compose reads "PORT"',
      hidden: [],
    });
  });
}

test("the migration allows interpolating a key the default overlay leaves alone or a longer name", async () => {
  const repo = await writeDefaultOverlayRepo({
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n    command: run ${A} $PORT_EXTRA\n",
    base: "A=1\nPORT=2\n",
    overlay: "A=1\nPORT=3\n",
  });
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the migration keeps a comment after a closing quote", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `SPACED='${KEPT_VALUE}' # note\nTOUCHING="${KEPT_VALUE}"#note\n`
  );
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { SPACED: KEPT_VALUE, TOUCHING: KEPT_VALUE },
  });
});

test("a backslash before a single quote cannot hide a later line from the migration", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `Z=1\nA='q\\'\nB='r\nC=$Z\n`
  );
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: "differently from Hack",
    hidden: [],
  });
});

test("the migration does not read a longer interpolated name as the overlay's key", async () => {
  const repo = await writeDefaultOverlayRepo({
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n    command: run ${PORT_X}\n",
    base: "PORT=2\n",
    overlay: "PORT=3\n",
  });
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the migration refuses an env_file order that gives a key a different value from the layers", async () => {
  const compose = (order: string) =>
    `services:\n  api:\n    image: alpine:3.20\n    env_file: ${order}\n`;
  const repo = await writeDefaultOverlayRepo({
    compose: compose("[.env.staging, .env]"),
    base: `PORT=${KEPT_VALUE}-base\nSAME=1\n`,
    overlay: `PORT=${KEPT_VALUE}-staging\nSAME=1\n`,
  });
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: 'the order of Compose env_file gives "PORT" in "api"',
    hidden: [KEPT_VALUE],
  });

  // In the order the layers apply, the value is the same before and after.
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    compose("[.env, .env.staging]")
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the migration accepts any env_file order when the files agree", async () => {
  const repo = await writeDefaultOverlayRepo({
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env.staging, .env]\n",
    base: "PORT=1\n",
    overlay: "PORT=1\nONLY=2\n",
  });
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the contract migration refuses a link that stays in .hack, so a local credential stays out of tracked layers", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "KEPT_SETTING", source: "plain_env", required: false }],
    })}\n`
  );
  await writeFile(
    resolve(repo.projectDir, ".env.local"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  await symlink(".env.local", resolve(repo.projectDir, ".env"));
  const before = await hackDirEntries(repo);
  const error = await migrateLegacyRepo(repo, {}).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
  expect((error as LegacyDotenvMigrationRefusalError).code).toBe(
    "E_PATH_CONFLICT"
  );
  expect((error as Error).message).toContain('".env" is a symlink');
  expect((error as Error).message).not.toContain(KEPT_VALUE);
  expect(await hackDirEntries(repo)).toEqual(before);
});

test("the contract migration refuses a dangling legacy link", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [] })}\n`
  );
  await symlink("missing.env", resolve(repo.projectDir, ".env"));
  const error = await migrateLegacyRepo(repo, {}).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
});

test("the migration does not count a parent-directory env_file as a repeat", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, ../.env]\n"
  );
  await writeFile(resolve(repo.projectDir, ".env"), "A=1\n");
  await writeFile(resolve(repo.projectRoot, ".env"), "OTHER=2\n");
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

for (const section of ["secrets", "configs"]) {
  test(`the migration refuses top-level ${section} reading a key the default overlay changes`, async () => {
    const repo = await writeDefaultOverlayRepo({
      compose: `services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n${section}:\n  item:\n    environment: PORT\n`,
      base: "PORT=2\n",
      overlay: "PORT=3\n",
    });
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: 'Compose reads "PORT"',
      hidden: [],
    });
  });
}

for (const [name, block] of [
  [
    "a bare build.args list entry",
    "    build:\n      context: .\n      args: [PORT]\n",
  ],
  [
    "a bare build.args map entry",
    "    build:\n      context: .\n      args:\n        PORT:\n",
  ],
] as const) {
  test(`the migration refuses ${name} the default overlay changes`, async () => {
    const repo = await writeDefaultOverlayRepo({
      compose: `services:\n  api:\n    image: alpine:3.20\n${block}    env_file: [.env, .env.staging]\n`,
      base: "PORT=2\n",
      overlay: "PORT=3\n",
    });
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: 'Compose reads "PORT"',
      hidden: [],
    });
  });
}

test("the migration refuses a Compose setting the default overlay changes, even if the file never names it", async () => {
  const repo = await writeDefaultOverlayRepo({
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n",
    base: "A=1\n",
    overlay: "A=1\nCOMPOSE_PROFILES=dev\n",
  });
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: 'Compose reads "COMPOSE_PROFILES"',
    hidden: [],
  });
});

test("the migration allows a default overlay key the Compose file never uses, including as part of a longer name", async () => {
  const repo = await writeDefaultOverlayRepo({
    compose:
      "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging]\n    environment:\n      MY_PORT_X: fixed\n",
    base: "PORT=2\n",
    overlay: "PORT=3\n",
  });
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

for (const reference of ["Z=${PORT}", "Z=$PORT"]) {
  test(`the migration refuses another env_file with ${reference} when the default overlay changes that key`, async () => {
    const repo = await writeDefaultOverlayRepo({
      compose:
        "services:\n  api:\n    image: alpine:3.20\n    env_file: [.env, .env.staging, other.env]\n",
      base: "PORT=2\n",
      overlay: "PORT=3\n",
    });
    await writeFile(resolve(repo.projectDir, "other.env"), `${reference}\n`);
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: 'Compose reads "PORT"',
      hidden: [],
    });
  });
}

test("the migration refuses a Compose file with several documents", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n---\nservices:\n  api:\n    environment:\n      A: fixed\n"
  );
  await writeFile(resolve(repo.projectDir, ".env"), `A=${KEPT_VALUE}\n`);
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: "is not a single YAML document",
    hidden: [KEPT_VALUE],
  });
});

for (const key of [
  "DOCKER_HOST",
  "BUILDKIT_PROGRESS",
  "BUILDX_BUILDER",
  "HTTP_PROXY",
  "NO_PROXY",
  "SOURCE_DATE_EPOCH",
  "HOME",
  "PATH",
]) {
  test(`the migration refuses ${key} in a legacy file, changed or not`, async () => {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, ".env"),
      `${key}=${KEPT_VALUE}\nA=1\n`
    );
    await expectMigrationRefusal({
      repo,
      code: "E_CONFIG_INVALID",
      reason: `the legacy .env files set "${key}"`,
      hidden: [KEPT_VALUE],
    });
  });
}

test("the migration allows a name that only starts like a tool setting", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, ".env"),
    "HOME_PAGE=/x\nPATH_PREFIX=/y\nMY_DOCKER_HOST=z\n"
  );
  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
});

test("the migration refuses a Compose file with include and no services", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_COMPOSE_FILENAME),
    "include:\n  - inc.yml\n"
  );
  await writeFile(resolve(repo.projectDir, ".env"), `A=${KEPT_VALUE}\n`);
  await expectMigrationRefusal({
    repo,
    code: "E_CONFIG_INVALID",
    reason: "top-level include",
    hidden: [KEPT_VALUE],
  });
});

async function writeTeammateCheckout(): Promise<Repo> {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    LAYER_EMPTY
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `KEPT_SETTING=${KEPT_VALUE}\n`
  );
  return repo;
}

const LAYER_EMPTY =
  "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n";

function unmigratedIn(repo: Repo) {
  return findUnmigratedLegacyDotenv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api"],
  });
}

test("a checkout with only its own .env migrates to its local layer after a teammate's migration landed", async () => {
  const repo = await writeTeammateCheckout();
  const tracked = await readFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    "utf8"
  );
  expect((await unmigratedIn(repo)).keys).toEqual(["KEPT_SETTING"]);

  const migrated = await migrateLegacyRepo(repo, {
    migrateUndeclaredDotenv: true,
  });
  expect(migrated.legacyDetected).toBe(true);
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { KEPT_SETTING: KEPT_VALUE },
  });
  expect(
    await readFile(resolve(repo.projectDir, "hack.env.default.yaml"), "utf8")
  ).toBe(tracked);
  // Now delivered: nothing is unmigrated, and a second run refuses.
  expect((await unmigratedIn(repo)).keys).toEqual([]);
  await expectMigrationRefusal({
    repo,
    code: "E_PATH_CONFLICT",
    reason: "env layer files already exist",
    hidden: [KEPT_VALUE],
  });
});

test("an unrelated local layer doesn't hide a checkout's undelivered values, and migrating adds to its layer", async () => {
  const repo = await writeTeammateCheckout();
  await writeFile(
    resolve(repo.projectDir, "hack.env.x.local.yaml"),
    LAYER_EMPTY.replace("environment: default", "environment: x")
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.local.yaml"),
    `${LAYER_EMPTY.replace("global: {}", "global:\n    OTHER: kept")}`
  );
  expect((await unmigratedIn(repo)).keys).toEqual(["KEPT_SETTING"]);
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { OTHER: "kept", KEPT_SETTING: KEPT_VALUE },
  });
  expect((await unmigratedIn(repo)).keys).toEqual([]);
});

test("a stray state file doesn't hide undelivered values", async () => {
  const repo = await writeTeammateCheckout();
  await writeFile(resolve(repo.projectDir, ".env.state.json"), "{}\n");
  expect((await unmigratedIn(repo)).keys).toEqual(["KEPT_SETTING"]);
});

test("the migration refuses a key the local layer sets differently, and keeps both", async () => {
  const repo = await writeTeammateCheckout();
  const layer = LAYER_EMPTY.replace(
    "global: {}",
    "global:\n    KEPT_SETTING: other"
  );
  await writeFile(resolve(repo.projectDir, "hack.env.local.yaml"), layer);
  await expectMigrationRefusal({
    repo,
    code: "E_PATH_CONFLICT",
    reason: '"KEPT_SETTING" in hack.env.local.yaml',
    hidden: [KEPT_VALUE],
  });
  expect(
    await readFile(resolve(repo.projectDir, "hack.env.local.yaml"), "utf8")
  ).toBe(layer);
});

test("the migration doesn't copy a value the tracked layers already deliver", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    LAYER_EMPTY.replace("global: {}", "global:\n    SAME: team")
  );
  await writeFile(
    resolve(repo.projectDir, ".env"),
    `SAME=team\nMINE=${KEPT_VALUE}\n`
  );
  expect((await unmigratedIn(repo)).keys).toEqual(["MINE"]);
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  expect(await readLayerValues(repo, "hack.env.local.yaml")).toEqual({
    global: { MINE: KEPT_VALUE },
  });
});

test("an overlay-only checkout is reported, and migrates", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "env-legacy-scope", dev_host: "env-legacy-scope.hack", env: { defaultOverlay: "staging" } })}\n`
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    LAYER_EMPTY
  );
  await writeFile(
    resolve(repo.projectDir, "hack.env.staging.yaml"),
    LAYER_EMPTY.replace("environment: default", "environment: staging")
  );
  await writeFile(
    resolve(repo.projectDir, ".env.staging"),
    `ONLY_HERE=${KEPT_VALUE}\n`
  );
  expect((await unmigratedIn(repo)).keys).toEqual(["ONLY_HERE"]);
  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  expect(await readLayerValues(repo, "hack.env.staging.local.yaml")).toEqual({
    global: { ONLY_HERE: KEPT_VALUE },
  });
  expect((await unmigratedIn(repo)).keys).toEqual([]);
});

test("a contract project or a linked layer keeps the older behaviour", async () => {
  const contract = await writeTeammateCheckout();
  await writeFile(
    resolve(contract.projectDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [] })}\n`
  );
  expect((await unmigratedIn(contract)).keys).toEqual([]);

  const linked = await writeTeammateCheckout();
  const target = resolve(linked.root, "elsewhere.yaml");
  await writeFile(
    target,
    LAYER_EMPTY.replace("environment: default", "environment: staging")
  );
  await symlink(target, resolve(linked.projectDir, "hack.env.staging.yaml"));
  await expectMigrationRefusal({
    repo: linked,
    code: "E_PATH_CONFLICT",
    reason: "env layer files already exist",
    hidden: [KEPT_VALUE],
  });
});

test("diagnostics never echo a malformed entry, and it still blocks materialize", async () => {
  const secret = ["hunter", "2-synthetic"].join("");
  for (const line of [
    `sk-${secret}=x`,
    `postgres://u:${secret}@db/app?x=1`,
    `SECRET ${secret}=1`,
    `\u001b[31m${secret}=1`,
  ]) {
    const repo = await createLegacyRepo();
    await writeFile(
      resolve(repo.projectDir, "hack.env.default.yaml"),
      LAYER_EMPTY
    );
    await writeFile(resolve(repo.projectDir, ".env"), `${line}\n`);
    const unmigrated = await unmigratedIn(repo);
    expect(unmigrated.keys).toEqual([]);
    expect(unmigrated.malformedCount).toBe(1);
    const inspected = await inspectProjectEnvMaterialization({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      serviceNames: ["api"],
    });
    expect(inspected.message).toContain("1 malformed entry");
    expect(inspected.message).not.toContain(secret);
    const run = await runCli({
      repo,
      args: ["env", "materialize", "--path", repo.projectRoot],
    });
    expect(run.exitCode).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toContain(secret);
    expect(await readFile(resolve(repo.projectDir, ".env"), "utf8")).toContain(
      secret
    );
  }
}, 120_000);

test("an unreadable legacy file is reported and goes to the migration, which refuses it", async () => {
  const repo = await createLegacyRepo();
  await writeFile(
    resolve(repo.projectDir, "hack.env.default.yaml"),
    LAYER_EMPTY
  );
  const envPath = resolve(repo.projectDir, ".env");
  await writeFile(envPath, `KEPT_SETTING=${KEPT_VALUE}\n`);
  await chmod(envPath, 0o000);
  try {
    expect((await unmigratedIn(repo)).unreadableFiles).toEqual([".env"]);
    const inspected = await inspectProjectEnvMaterialization({
      projectRoot: repo.projectRoot,
      projectDir: repo.projectDir,
      serviceNames: ["api"],
    });
    expect(inspected.message).toContain("can't read .env");
    expect(inspected.message).toContain("hack doctor --migrate-env-config");
    const error = await migrateLegacyRepo(repo, {
      migrateUndeclaredDotenv: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
    expect((error as LegacyDotenvMigrationRefusalError).code).toBe(
      "E_PERMISSION"
    );
  } finally {
    await chmod(envPath, 0o600);
  }
});

test("hack env materialize refuses to replace a checkout's only copy, and keeps the file", async () => {
  const repo = await writeTeammateCheckout();
  const envPath = resolve(repo.projectDir, ".env");
  const run = await runCli({
    repo,
    args: ["env", "materialize", "--path", repo.projectRoot],
  });
  expect(run.exitCode).not.toBe(0);
  const output = `${run.stdout}${run.stderr}`;
  expect(output).toContain("E_CONFIG_INVALID");
  expect(output).toContain("KEPT_SETTING");
  expect(output).not.toContain(KEPT_VALUE);
  expect(await readFile(envPath, "utf8")).toContain(KEPT_VALUE);

  await migrateLegacyRepo(repo, { migrateUndeclaredDotenv: true });
  const after = await runCli({
    repo,
    args: ["env", "materialize", "--path", repo.projectRoot],
  });
  expect(after.exitCode).toBe(0);
  expect(await readFile(envPath, "utf8")).toContain(KEPT_VALUE);
}, 60_000);

test("doctor names a checkout's unmigrated keys, not their values", async () => {
  const repo = await writeTeammateCheckout();
  const inspected = await inspectProjectEnvMaterialization({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api"],
  });
  expect(inspected.message).toContain("KEPT_SETTING");
  expect(inspected.message).toContain("hack doctor --migrate-env-config");
  expect(inspected.message).not.toContain(KEPT_VALUE);
});
