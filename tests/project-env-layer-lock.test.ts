import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { YAML } from "bun";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import { parseDotEnv } from "../src/lib/env.ts";
import {
  EnvLayerLockRefusedError,
  EnvLayerLockTimeoutError,
  resolveEnvLayerLockPath,
} from "../src/lib/env-layer-lock.ts";
import {
  AtomicWriteConflictError,
  AtomicWriteRefusedError,
} from "../src/lib/fs.ts";
import { removeDotEnvKey, upsertDotEnvValue } from "../src/lib/hack-env.ts";
import {
  resolveProjectEnvConfig,
  resolveProjectEnvConfigPath,
  resolveProjectEnvLocalConfigPath,
  resolveProjectEnvSharedKeyLocation,
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";
import { createSecretWorktreeFixture } from "./helpers/secret-fixture.ts";

/**
 * HACK-1376: concurrent writers of one env layer must not lose each other's
 * update. Before the fix, `hack env set` read the layer, changed it in memory
 * and renamed a new file over it with no lock, so the last rename won and the
 * other key silently disappeared while both commands exited 0.
 *
 * Stress cases start WORKERS fresh processes (no shared module state), hold
 * them at a stdin barrier and release them together, then require that every
 * process succeeded and every key is present. Removing the layer lock from
 * `setProjectEnvValue`/`unsetProjectEnvValue`/`upsertDotEnvValue` makes them
 * fail (lost keys, or compare-and-swap conflicts).
 *
 * Isolation: every case runs in a temp root with a private HOME, HACK_HOME,
 * global config and Docker client config; the keychain fallback is disabled
 * and git reads no global or system config. Every value is a synthetic test
 * string; no output is checked for values beyond proving their absence.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const PROJECT_ENV_MODULE = resolve(
  REPO_ROOT,
  "src",
  "lib",
  "project-env-config.ts"
);
const HACK_ENV_MODULE = resolve(REPO_ROOT, "src", "lib", "hack-env.ts");
const WORKERS = 8;
const PARENT_ENV_KEYS = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_ENV_SECRET_KEY",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
] as const;

let root: string | null = null;
const previousEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-env-layer-lock-"));
  for (const key of PARENT_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
  }
  process.env.HOME = privateCliHome(root);
  process.env.HACK_HOME = join(root, "hack-home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "hack.config.json");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
  for (const key of PARENT_ENV_KEYS) {
    restoreEnv(key, previousEnv.get(key));
  }
  previousEnv.clear();
});

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

type Project = {
  readonly projectRoot: string;
  readonly projectDir: string;
};

/** A non-git Hack project; the env layer file is created by each case. */
async function createProject(): Promise<Project> {
  const projectRoot = join(requireRoot(), "project");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "layer-lock", dev_host: "layer-lock.hack" }, null, 2)}\n`
  );
  return { projectRoot, projectDir };
}

/** The bytes Hack itself writes for this layer, so a no-op leaves them unchanged. */
function layerText(global: Readonly<Record<string, string>>): string {
  const yaml = YAML.stringify(
    {
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global },
    },
    null,
    2
  );
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

function synthetic(key: string): string {
  return `synthetic-${key.toLowerCase()}-value`;
}

function childEnv(): Record<string, string> {
  return privateCliEnv({
    root: requireRoot(),
    env: {
      HACK_HOME: process.env.HACK_HOME,
      HACK_GLOBAL_CONFIG_PATH: process.env.HACK_GLOBAL_CONFIG_PATH,
      HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
      HACK_LOGGER: "console",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

type WorkerExit = { readonly code: number; readonly stderr: string };

/**
 * Starts one process per command, waits until every one printed `loaded`,
 * then releases them together by writing `go` to each stdin.
 */
async function runReleasedTogether(
  commands: readonly (readonly string[])[]
): Promise<readonly WorkerExit[]> {
  const workers = commands.map((cmd) =>
    Bun.spawn({
      cmd: [process.execPath, ...cmd],
      cwd: requireRoot(),
      env: childEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  );
  try {
    await Promise.all(
      workers.map(async (worker) => {
        const reader = worker.stdout.getReader();
        let seen = "";
        while (!seen.includes("loaded\n")) {
          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error("worker exited before loading");
          }
          seen += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
      })
    );
    for (const worker of workers) {
      worker.stdin.write("go\n");
      await worker.stdin.flush();
    }
  } catch (error: unknown) {
    for (const worker of workers) {
      worker.kill();
    }
    throw error;
  } finally {
    for (const worker of workers) {
      await worker.stdin.end();
    }
  }
  return await Promise.all(
    workers.map(async (worker) => ({
      code: await worker.exited,
      stderr: await new Response(worker.stderr).text(),
    }))
  );
}

/**
 * A worker script: imports `module`, prints `loaded`, waits for `go` on
 * stdin, then runs `body` (which may use `args`, the worker's argv).
 */
async function writeWorker(opts: {
  readonly name: string;
  readonly imports: string;
  readonly module: string;
  readonly body: string;
}): Promise<string> {
  const path = join(requireRoot(), opts.name);
  await writeFile(
    path,
    [
      `import { ${opts.imports} } from ${JSON.stringify(opts.module)};`,
      "const args = process.argv.slice(2);",
      "process.stdout.write('loaded\\n');",
      "const reader = Bun.stdin.stream().getReader();",
      "let seen = '';",
      "while (!seen.includes('go\\n')) {",
      "  const chunk = await reader.read();",
      "  if (chunk.done) { process.exit(3); }",
      "  seen += new TextDecoder().decode(chunk.value);",
      "}",
      opts.body,
      "",
    ].join("\n")
  );
  return path;
}

function expectAllSucceeded(exits: readonly WorkerExit[]): void {
  for (const exit of exits) {
    expect({ code: exit.code, stderr: exit.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
  }
}

async function resolvedGlobal(
  project: Project
): Promise<Record<string, string>> {
  const resolved = await resolveProjectEnvConfig({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  return { ...(resolved?.globalEnv ?? {}) };
}

function keys(prefix: string): string[] {
  return Array.from({ length: WORKERS }, (_, index) => `${prefix}_${index}`);
}

const PROJECT_WORKER_BODY = [
  "const [projectRoot, projectDir, op, layer, key] = args;",
  "const base = { projectRoot, projectDir, envName: null, scope: 'global', key, local: layer === 'local' };",
  "if (op === 'set') {",
  "  await setProjectEnvValue({ ...base, value: `synthetic-${key.toLowerCase()}-value`, secret: layer === 'local' });",
  "} else {",
  "  await unsetProjectEnvValue(base);",
  "}",
].join("\n");

for (const layer of ["tracked", "local"] as const) {
  test(`${WORKERS} concurrent sets of distinct keys on the ${layer} layer all survive`, async () => {
    const project = await createProject();
    const file =
      layer === "local"
        ? resolveProjectEnvLocalConfigPath({
            projectDir: project.projectDir,
            envName: null,
          })
        : resolveProjectEnvConfigPath({
            projectDir: project.projectDir,
            envName: null,
          });
    await writeFile(file, layerText({ PRESET: synthetic("PRESET") }));
    const script = await writeWorker({
      name: "project-env-worker.ts",
      imports: "setProjectEnvValue, unsetProjectEnvValue",
      module: PROJECT_ENV_MODULE,
      body: PROJECT_WORKER_BODY,
    });

    const added = keys("ADDED");
    expectAllSucceeded(
      await runReleasedTogether(
        added.map((key) => [
          script,
          project.projectRoot,
          project.projectDir,
          "set",
          layer,
          key,
        ])
      )
    );

    const global = await resolvedGlobal(project);
    for (const key of ["PRESET", ...added]) {
      expect(global[key]).toBe(synthetic(key));
    }
    // The lock leaves nothing behind: no lock, owner or staging file.
    expect(await readdir(join(project.projectDir, ".internal"))).toEqual([]);
    expect(
      (await readdir(project.projectDir)).filter((name) =>
        name.endsWith(".tmp")
      )
    ).toEqual([]);
  }, 60_000);
}

test("concurrent sets and unsets of different keys on one layer all apply", async () => {
  const project = await createProject();
  const file = resolveProjectEnvConfigPath({
    projectDir: project.projectDir,
    envName: null,
  });
  const kept = keys("KEPT");
  const dropped = keys("DROPPED");
  await writeFile(
    file,
    layerText(
      Object.fromEntries(
        [...kept, ...dropped].map((key) => [key, synthetic(key)])
      )
    )
  );
  const script = await writeWorker({
    name: "project-env-mixed-worker.ts",
    imports: "setProjectEnvValue, unsetProjectEnvValue",
    module: PROJECT_ENV_MODULE,
    body: PROJECT_WORKER_BODY,
  });

  const added = keys("ADDED");
  const base = [script, project.projectRoot, project.projectDir];
  expectAllSucceeded(
    await runReleasedTogether([
      ...added.map((key) => [...base, "set", "tracked", key]),
      ...dropped.map((key) => [...base, "unset", "tracked", key]),
    ])
  );

  const global = await resolvedGlobal(project);
  expect(Object.keys(global).sort()).toEqual([...kept, ...added].sort());
  for (const key of [...kept, ...added]) {
    expect(global[key]).toBe(synthetic(key));
  }
}, 60_000);

test(`${WORKERS} concurrent \`hack env set\` commands all keep their key`, async () => {
  const project = await createProject();
  const file = resolveProjectEnvConfigPath({
    projectDir: project.projectDir,
    envName: null,
  });
  await writeFile(file, layerText({ PRESET: synthetic("PRESET") }));
  // A preload holds each CLI process at the barrier before the CLI loads.
  const preload = join(requireRoot(), "cli-barrier.ts");
  await writeFile(
    preload,
    [
      "process.stdout.write('loaded\\n');",
      "const reader = Bun.stdin.stream().getReader();",
      "let seen = '';",
      "while (!seen.includes('go\\n')) {",
      "  const chunk = await reader.read();",
      "  if (chunk.done) { process.exit(3); }",
      "  seen += new TextDecoder().decode(chunk.value);",
      "}",
      "reader.releaseLock();",
      "",
    ].join("\n")
  );
  const added = keys("CLI_ADDED");
  const exits = await runReleasedTogether(
    added.map((key) => [
      "--preload",
      preload,
      ENTRYPOINT,
      "env",
      "set",
      key,
      synthetic(key),
      "--path",
      project.projectRoot,
    ])
  );
  for (const exit of exits) {
    expect(exit.code).toBe(0);
    for (const key of added) {
      expect(exit.stderr).not.toContain(synthetic(key));
    }
  }
  const global = await resolvedGlobal(project);
  for (const key of ["PRESET", ...added]) {
    expect(global[key]).toBe(synthetic(key));
  }
}, 120_000);

test("concurrent legacy dotenv sets and removals of different keys all apply", async () => {
  const project = await createProject();
  const envFile = join(project.projectDir, ".env");
  const kept = keys("KEPT");
  const dropped = keys("DROPPED");
  await writeFile(
    envFile,
    [...kept, ...dropped].map((key) => `${key}=${synthetic(key)}\n`).join(""),
    { mode: 0o600 }
  );
  const script = await writeWorker({
    name: "dotenv-worker.ts",
    imports: "removeDotEnvKey, upsertDotEnvValue",
    module: HACK_ENV_MODULE,
    body: [
      "const [envFile, op, key] = args;",
      "if (op === 'set') {",
      "  await upsertDotEnvValue({ envFile, key, value: `synthetic-${key.toLowerCase()}-value` });",
      "} else {",
      "  await removeDotEnvKey({ envFile, key });",
      "}",
    ].join("\n"),
  });

  const added = keys("ADDED");
  expectAllSucceeded(
    await runReleasedTogether([
      ...added.map((key) => [script, envFile, "set", key]),
      ...dropped.map((key) => [script, envFile, "remove", key]),
    ])
  );

  const env = parseDotEnv(await readFile(envFile, "utf8"));
  expect(Object.keys(env).sort()).toEqual([...kept, ...added].sort());
  for (const key of [...kept, ...added]) {
    expect(env[key]).toBe(synthetic(key));
  }
}, 60_000);

/** Publishes a live owner receipt (this test process) at the layer's lock. */
async function holdLayerLock(layerPath: string): Promise<string> {
  const lockPath = resolveEnvLayerLockPath({ layerPath });
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${process.pid}\n${randomUUID()}\n`, {
    mode: 0o600,
  });
  return lockPath;
}

async function closedRefusalOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error: unknown) {
    if (error instanceof ClosedCliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a closed refusal");
}

test("a writer that cannot get the layer lock in time refuses closed and writes nothing", async () => {
  const project = await createProject();
  const file = resolveProjectEnvConfigPath({
    projectDir: project.projectDir,
    envName: null,
  });
  const original = layerText({ PRESET: synthetic("PRESET") });
  await writeFile(file, original);
  const envFile = join(project.projectDir, ".env");
  const originalDotEnv = `PRESET=${synthetic("PRESET")}\n`;
  await writeFile(envFile, originalDotEnv, { mode: 0o600 });
  const lockPath = await holdLayerLock(file);
  const dotEnvLockPath = await holdLayerLock(envFile);
  const base = {
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: null,
    scope: "global",
    layerLockTimeoutMs: 300,
  };

  const refusals = [
    await closedRefusalOf(
      setProjectEnvValue({
        ...base,
        key: "BLOCKED",
        value: synthetic("BLOCKED"),
        secret: false,
      })
    ),
    await closedRefusalOf(unsetProjectEnvValue({ ...base, key: "PRESET" })),
    await closedRefusalOf(
      upsertDotEnvValue({
        envFile,
        key: "BLOCKED",
        value: synthetic("BLOCKED"),
        layerLockTimeoutMs: 300,
      })
    ),
    await closedRefusalOf(
      removeDotEnvKey({ envFile, key: "PRESET", layerLockTimeoutMs: 300 })
    ),
  ];
  for (const [index, refusal] of refusals.entries()) {
    const layer = index < 2 ? file : envFile;
    expect(refusal).toBeInstanceOf(EnvLayerLockTimeoutError);
    expect(refusal.message).toBe(
      `Another hack env command is writing ${layer}; gave up after waiting 300ms for it. Nothing was written. Retry when it finishes.`
    );
    expect(refusal.message).not.toContain(synthetic("BLOCKED"));
    expect(refusal.message).not.toContain(synthetic("PRESET"));
  }
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await readFile(envFile, "utf8")).toBe(originalDotEnv);

  // Once the holder releases, the same write goes through.
  await rm(lockPath);
  await rm(dotEnvLockPath);
  const done = await setProjectEnvValue({
    ...base,
    key: "BLOCKED",
    value: synthetic("BLOCKED"),
    secret: false,
  });
  expect(done.changed).toBe(true);
  expect((await resolvedGlobal(project)).BLOCKED).toBe(synthetic("BLOCKED"));
  expect(await readdir(dirname(lockPath))).toEqual([]);
});

// Permission bits do not bind root, so a read-only directory only exists for others.
const RUNS_AS_ROOT = (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0;

test.skipIf(RUNS_AS_ROOT)(
  "in a read-only .hack directory a no-op set or unset still succeeds and a change is refused",
  async () => {
    const project = await createProject();
    const file = resolveProjectEnvConfigPath({
      projectDir: project.projectDir,
      envName: null,
    });
    const original = layerText({ PRESET: synthetic("PRESET") });
    await writeFile(file, original);
    const base = {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      envName: null,
      scope: "global",
    };
    await chmod(project.projectDir, 0o555);
    try {
      // No lock can be created here, and none is needed: nothing can be
      // replaced, so a no-op keeps working as it did before the lock.
      expect(
        (await unsetProjectEnvValue({ ...base, key: "ABSENT" })).changed
      ).toBe(false);
      expect(
        (
          await setProjectEnvValue({
            ...base,
            key: "PRESET",
            value: synthetic("PRESET"),
            secret: false,
          })
        ).changed
      ).toBe(false);
      const refusal = await closedRefusalOrCliError(
        setProjectEnvValue({
          ...base,
          key: "BLOCKED",
          value: synthetic("BLOCKED"),
          secret: false,
        })
      );
      expect(refusal).toBeInstanceOf(AtomicWriteRefusedError);
      expect(refusal.message).not.toContain(synthetic("BLOCKED"));
    } finally {
      await chmod(project.projectDir, 0o755);
    }
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readdir(project.projectDir)).not.toContain(".internal");
  }
);

async function closedRefusalOrCliError(
  pending: Promise<unknown>
): Promise<Error> {
  try {
    await pending;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the write to be refused");
}

test("a symlinked .internal beside the layer is refused before any lock or write", async () => {
  const project = await createProject();
  const file = resolveProjectEnvConfigPath({
    projectDir: project.projectDir,
    envName: null,
  });
  const original = layerText({ PRESET: synthetic("PRESET") });
  await writeFile(file, original);
  const elsewhere = join(requireRoot(), "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(project.projectDir, ".internal"));

  const refusal = await closedRefusalOf(
    setProjectEnvValue({
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      envName: null,
      scope: "global",
      key: "BLOCKED",
      value: synthetic("BLOCKED"),
      secret: false,
    })
  );
  expect(refusal).toBeInstanceOf(EnvLayerLockRefusedError);
  expect(refusal.message).toBe(
    `Refused to update ${file}: the .internal entry beside it is a symlink or not a directory, so its write lock cannot be taken safely. Replace it with a regular directory and retry. Nothing was written.`
  );
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await readdir(elsewhere)).toEqual([]);
});

test("a set refuses with a conflict when a writer that takes no lock changed the layer after its read", async () => {
  const base = requireRoot();
  const fixture = await createSecretWorktreeFixture({
    parent: base,
    home: privateCliHome(base),
    name: "layer-cas",
  });
  const projectDir = join(fixture.primaryRoot, ".hack");
  const file = resolveProjectEnvConfigPath({ projectDir, envName: null });
  await writeFile(file, layerText({ PRESET: synthetic("PRESET") }));
  // No project key exists yet, so a secret set creates one under the key
  // lock in the git common dir, after it has read the layer. Holding that
  // lock pauses the set between its read and its write.
  const shared = await resolveProjectEnvSharedKeyLocation({
    projectRoot: fixture.primaryRoot,
  });
  if (!shared) {
    throw new Error("Expected a shared key location in a git checkout");
  }
  const keyLockPath = `${shared.path}.lock`;
  await writeFile(keyLockPath, `${process.pid}\n${randomUUID()}\n`, {
    mode: 0o600,
  });

  const pending = setProjectEnvValue({
    projectRoot: fixture.primaryRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "SECRET_ADDED",
    value: synthetic("SECRET_ADDED"),
    secret: true,
  }).then(
    () => null,
    (error: unknown) => error
  );
  // The set is waiting once its owner receipt is staged beside the key lock.
  const lockDir = dirname(keyLockPath);
  const staged = `${basename(keyLockPath)}.`;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const names = await readdir(lockDir);
    if (
      names.some((name) => name.startsWith(staged) && name.endsWith(".owner"))
    ) {
      break;
    }
    await Bun.sleep(10);
  }
  const edited = layerText({
    PRESET: synthetic("PRESET"),
    HAND_EDITED: synthetic("HAND_EDITED"),
  });
  await writeFile(file, edited);
  await rm(keyLockPath);

  const error = await pending;
  expect(error).toBeInstanceOf(AtomicWriteConflictError);
  // The other writer's layer stands; the set wrote nothing.
  expect(await readFile(file, "utf8")).toBe(edited);
}, 30_000);
