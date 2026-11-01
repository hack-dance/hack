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
  const target = resolve(repo.root, "shared-staging.env");
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
    (root: string) => root,
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
    `services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n    environment:\n      PORT: "${composeExplicitPort}"\n  worker:\n    image: alpine:3.20\n    environment:\n      - OTHER=1\n`
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
