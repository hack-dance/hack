import { afterEach, expect, test } from "bun:test";
import {
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

import { LEGACY_ENV_SERVICE_SCOPE_MESSAGE } from "../src/cli/env-arguments.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { ClosedCliError, HackCliError } from "../src/lib/cli-result.ts";
import {
  ENV_SCOPE_INVALID_MESSAGE,
  ProjectEnvLayerPathConflictError,
  projectEnvConfigExistsForMutation,
  resolveProjectEnvConfig,
} from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1370: `hack env set`/`unset` in a legacy `.hack/.env` project refuse a
 * `--service` scope instead of silently changing the global value; a layer
 * entry that is not a usable file refuses (E_PATH_CONFLICT) instead of
 * selecting the legacy file; and reads of an invalid layer print one closed
 * line, never a stack.
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
