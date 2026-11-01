import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  LegacyDotenvMigrationRefusalError,
  migrateLegacyProjectEnv,
  resolveProjectEnvConfig,
  selectProjectEnvValues,
} from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const SHELL_KEY = "HACK_1688_SYNTHETIC_TOKEN";
const SHELL_VALUE = ["synthetic", "shell", "1688"].join("-");
const DOTENV_VALUE = ["synthetic", "dotenv", "1688"].join("-");
const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const tempDirs = new Set<string>();

afterEach(async () => {
  delete process.env[SHELL_KEY];
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

type Repo = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
};

async function createContractRepo(opts: {
  readonly services?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly otherVars?: readonly Record<string, unknown>[];
}): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-contract-shell-"));
  tempDirs.add(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n  worker:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "contract-shell", dev_host: "contract-shell.hack" })}\n`
  );
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [
        {
          key: SHELL_KEY,
          source: "plain_env",
          required: false,
          ...(opts.services ? { services: opts.services } : {}),
        },
        ...(opts.otherVars ?? []),
      ],
    })}\n`
  );
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    await writeFile(resolve(projectDir, name), text);
  }
  return { root, projectRoot, projectDir };
}

function migrate(repo: Repo) {
  return migrateLegacyProjectEnv({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    projectName: "contract-shell",
    serviceNames: ["api", "worker"],
    materialize: false,
  });
}

async function layerTexts(repo: Repo): Promise<string> {
  const names = (await readdir(repo.projectDir)).filter(
    (name) => name.startsWith("hack.env.") && name.endsWith(".yaml")
  );
  const texts = await Promise.all(
    names.map((name) => readFile(resolve(repo.projectDir, name), "utf8"))
  );
  return texts.join("\n");
}

/** Every file under the fixture root, with its bytes and mode, so a partial write can't pass. */
async function snapshotTree(
  repo: Repo
): Promise<Readonly<Record<string, string>>> {
  const entries = await readdir(repo.projectRoot, {
    withFileTypes: true,
    recursive: true,
  });
  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const label = relative(repo.projectRoot, path);
    snapshot[label] = entry.isFile()
      ? `${(await stat(path)).mode.toString(8)}:${(await readFile(path)).toString("base64")}`
      : "not-a-file";
  }
  return snapshot;
}

async function expectShellValueRefused(repo: Repo): Promise<string> {
  const before = await snapshotTree(repo);
  const error = await migrate(repo).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LegacyDotenvMigrationRefusalError);
  const { message } = error as Error;
  expect(message).toContain(SHELL_KEY);
  expect(message).not.toContain(SHELL_VALUE);
  expect(await snapshotTree(repo)).toEqual(before);
  return message;
}

async function runHack(opts: {
  readonly repo: Repo;
  readonly args: readonly string[];
  readonly shellValue?: string;
  readonly stdin?: string;
}) {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.repo.projectRoot,
    env: privateCliEnv({
      root: opts.repo.root,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
        HACK_HOME: join(opts.repo.root, "hack-home"),
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...(opts.shellValue === undefined
          ? {}
          : { [SHELL_KEY]: opts.shellValue }),
      },
    }),
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
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

async function valueFor(repo: Repo, service: string) {
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api", "worker"],
  });
  if (!resolved) {
    throw new Error("expected env layers");
  }
  return selectProjectEnvValues({ resolved, scopeName: service })[SHELL_KEY];
}

test("a shell-only plain_env value never reaches a layer, and the migration refuses", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  await expectShellValueRefused(await createContractRepo({}));
});

test("a service-scoped shell-only plain_env value is refused the same way", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({ services: ["api"] })
  );
  expect(message).toContain(
    `hack env set ${SHELL_KEY} --service "api" --local`
  );
  expect(message).not.toContain(`hack env set ${SHELL_KEY} --local`);
});

test("a key set only in an overlay file is refused too, because the base still takes it from the shell", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  await expectShellValueRefused(
    await createContractRepo({
      files: { ".env.staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    })
  );
});

test("a contract mixing a dotenv key and a shell key writes nothing at all", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  await expectShellValueRefused(
    await createContractRepo({
      otherVars: [{ key: "FROM_DOTENV", source: "plain_env", required: false }],
      files: { ".env": `FROM_DOTENV=${DOTENV_VALUE}\n` },
    })
  );
});

test("an overlay with no shell-origin key adds no refusal: the key in the base file wins over the shell", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const repo = await createContractRepo({
    files: {
      ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n`,
      ".env.staging": "OTHER=1\n",
    },
  });
  await migrate(repo);
  expect(await layerTexts(repo)).not.toContain(SHELL_VALUE);
});

test("implicit env exec refuses with the shell value set, then the printed recovery keeps the contract's scope", async () => {
  const repo = await createContractRepo({ services: ["api"] });
  const before = await snapshotTree(repo);

  const refused = await runHack({
    repo,
    args: ["env", "exec", "--path", repo.projectRoot, "--", "true"],
    shellValue: SHELL_VALUE,
  });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.output).toContain("E_CONFIG_INVALID");
  expect(refused.output).toContain(SHELL_KEY);
  expect(refused.output).not.toContain(SHELL_VALUE);
  expect(await snapshotTree(repo)).toEqual(before);

  // Step 1: one command without the variable lets the migration run.
  const migrated = await runHack({
    repo,
    args: ["env", "exec", "--path", repo.projectRoot, "--", "true"],
  });
  expect(migrated.exitCode).toBe(0);
  expect(await layerTexts(repo)).not.toContain(SHELL_VALUE);
  expect(await valueFor(repo, "api")).toBeUndefined();

  // Step 2: the scoped command delivers it to the declared service only.
  const set = await runHack({
    repo,
    args: [
      "env",
      "set",
      SHELL_KEY,
      "--service",
      "api",
      "--local",
      "--value-stdin",
      "--path",
      repo.projectRoot,
    ],
    stdin: `${DOTENV_VALUE}\n`,
  });
  expect(set.exitCode).toBe(0);
  expect(set.output).not.toContain(DOTENV_VALUE);
  expect(await valueFor(repo, "api")).toBe(DOTENV_VALUE);
  expect(await valueFor(repo, "worker")).toBeUndefined();

  // A shell value still reaches a host command, and no longer blocks anything.
  const hostValue = await runHack({
    repo,
    args: [
      "env",
      "exec",
      "--path",
      repo.projectRoot,
      "--",
      "/usr/bin/printenv",
      SHELL_KEY,
    ],
    shellValue: SHELL_VALUE,
  });
  expect(hostValue.exitCode).toBe(0);
  expect(hostValue.output).toContain(SHELL_VALUE);
  expect(await layerTexts(repo)).not.toContain(SHELL_VALUE);
}, 60_000);

test("a dotenv value still migrates as documented, and a same-named shell value stays out", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const repo = await createContractRepo({
    files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
  });
  const migrated = await migrate(repo);
  expect(migrated.legacyDetected).toBe(true);
  const layers = await layerTexts(repo);
  expect(layers).toContain(DOTENV_VALUE);
  expect(layers).not.toContain(SHELL_VALUE);
});

test("with the key unset in the shell, the migration proceeds and writes no value for it", async () => {
  const repo = await createContractRepo({});
  const migrated = await migrate(repo);
  expect(migrated.legacyDetected).toBe(true);
  expect(await layerTexts(repo)).not.toContain(SHELL_KEY);
  expect(
    await lstat(resolve(repo.projectDir, "hack.env.default.yaml")).catch(
      () => null
    )
  ).not.toBeNull();
});
