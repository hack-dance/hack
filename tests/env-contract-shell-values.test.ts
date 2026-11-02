import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { findProcessOnlyContractValues } from "../src/lib/hack-env.ts";
import {
  LegacyDotenvMigrationRefusalError,
  migrateLegacyProjectEnv,
  resolveProjectEnvConfig,
  selectProjectEnvValues,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const SHELL_KEY = "HACK_1688_SYNTHETIC_TOKEN";
const SHELL_VALUE = ["synthetic", "shell", "1688"].join("-");
const DOTENV_VALUE = ["synthetic", "dotenv", "1688"].join("-");
const OTHER_SHELL_KEY = "HACK_1688_OTHER_SYNTHETIC_TOKEN";
const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const tempDirs = new Set<string>();

afterEach(async () => {
  delete process.env[SHELL_KEY];
  delete process.env[OTHER_SHELL_KEY];
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  Reflect.deleteProperty(process.env, "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK");
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
  readonly secrets?: (projectRoot: string) => Record<string, unknown>;
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
    `${JSON.stringify({
      name: "contract-shell",
      dev_host: "contract-shell.hack",
      ...(opts.secrets
        ? { controlPlane: { secrets: opts.secrets(projectRoot) } }
        : {}),
    })}\n`
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
  readonly env?: Readonly<Record<string, string>>;
}) {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.repo.projectRoot,
    env: privateCliEnv({
      root: opts.repo.root,
      env: {
        HACK_GLOBAL_CONFIG_PATH: join(opts.repo.root, "hack-config.json"),
        HACK_HOME: join(opts.repo.root, "hack-home"),
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...(opts.shellValue === undefined
          ? {}
          : { [SHELL_KEY]: opts.shellValue }),
        ...opts.env,
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

async function valueFor(repo: Repo, service: string, envName?: string) {
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    ...(envName ? { envName } : {}),
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
  expect(message).toContain(`hack env set ${SHELL_KEY} --service api --local`);
  expect(message).not.toContain(`hack env set ${SHELL_KEY} --local`);
});

test("a key set only in an overlay file is refused too, because the base still takes it from the shell", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({
      files: { ".env.staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    })
  );
  expect(message).toContain(
    `hack env set ${SHELL_KEY} --env staging --local --value-stdin`
  );
  expect(message).not.toContain(DOTENV_VALUE);
});

test("an overlay that leaves the key to the shell gets no overlay command", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({ files: { ".env.staging": "OTHER=1\n" } })
  );
  expect(message).not.toContain("--env staging");
});

for (const services of [undefined, ["api"]] as const) {
  const scope = services ? "a service-scoped key" : "an unscoped key";
  test(`the printed recovery keeps an overlay's own value for ${scope}`, async () => {
    const repo = await createContractRepo({
      ...(services ? { services } : {}),
      files: { ".env.staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    });
    const serviceFlags = services ? ["--service", "api"] : [];
    const set = (input: {
      readonly flags: readonly string[];
      readonly value: string;
    }) =>
      runHack({
        repo,
        args: [
          "env",
          "set",
          SHELL_KEY,
          ...input.flags,
          ...serviceFlags,
          "--local",
          "--value-stdin",
          "--path",
          repo.projectRoot,
        ],
        stdin: `${input.value}\n`,
      });

    const refused = await runHack({
      repo,
      args: ["env", "exec", "--path", repo.projectRoot, "--", "true"],
      shellValue: SHELL_VALUE,
    });
    expect(refused.exitCode).not.toBe(0);
    const migrated = await runHack({
      repo,
      args: ["env", "exec", "--path", repo.projectRoot, "--", "true"],
    });
    expect(migrated.exitCode).toBe(0);
    expect((await set({ flags: [], value: SHELL_VALUE })).exitCode).toBe(0);
    // Without this step, the local base above would replace staging's value.
    expect(await valueFor(repo, "api", "staging")).toBe(SHELL_VALUE);
    expect(
      (await set({ flags: ["--env", "staging"], value: DOTENV_VALUE })).exitCode
    ).toBe(0);

    expect(await valueFor(repo, "api")).toBe(SHELL_VALUE);
    expect(await valueFor(repo, "api", "staging")).toBe(DOTENV_VALUE);
    if (services) {
      expect(await valueFor(repo, "worker", "staging")).toBeUndefined();
    }
  }, 60_000);
}

test("a service name that isn't safe to paste is reported, and gets no command", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({ services: ["a b$(touch pwned)"] })
  );
  expect(message).not.toContain("--service 'a b$(touch pwned)'");
  expect(message).not.toContain("--service a b");
  expect(message).toContain(JSON.stringify("a b$(touch pwned)"));
});

test("the printed unset names every key it refuses", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env[OTHER_SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({
      otherVars: [
        { key: OTHER_SHELL_KEY, source: "plain_env", required: false },
      ],
    })
  );
  expect(message).toContain(
    `env -u ${OTHER_SHELL_KEY} -u ${SHELL_KEY} hack env exec -- true`
  );
});

test("a keychain var doesn't set up a store or write a key before the refusal", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  const repo = await createContractRepo({
    otherVars: [{ key: "SERVICE_TOKEN", source: "keychain", required: false }],
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  await expectShellValueRefused(repo);
  expect(
    await lstat(resolve(repo.projectRoot, "secrets-file.key")).catch(() => null)
  ).toBeNull();
});

test("a mirrored backend whose read works doesn't write a key file before the refusal", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  process.env.HACK_SECRETS_FILE_KEY = ["synthetic", "file", "1688"].join("-");
  const repo = await createContractRepo({
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      storePlaintextInBackend: true,
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  await expectShellValueRefused(repo);
  expect(
    await lstat(resolve(repo.projectRoot, "secrets-file.key")).catch(() => null)
  ).toBeNull();
});

test("a mirrored backend whose key isn't available refuses a shell key, and creates no key", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  const repo = await createContractRepo({
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      storePlaintextInBackend: true,
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  const message = await expectShellValueRefused(repo);
  expect(message).toContain("the secret backend's key isn't available");
  expect(
    await lstat(resolve(repo.projectRoot, "secrets-file.key")).catch(() => null)
  ).toBeNull();
});

test("an undetermined key still gets the overlay command, so recovery can't replace that overlay's value", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  const repo = await createContractRepo({
    files: { ".env.staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      storePlaintextInBackend: true,
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  const message = await expectShellValueRefused(repo);
  expect(message).toContain("the secret backend's key isn't available");
  expect(message).toContain(
    `hack env set ${SHELL_KEY} --env staging --local --value-stdin`
  );
  expect(message).not.toContain(DOTENV_VALUE);
});

test("a corrupt mirrored store stops the migration with its own error, not a shell-value refusal", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_FILE_KEY = ["synthetic", "file", "1688"].join("-");
  const repo = await createContractRepo({
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      storePlaintextInBackend: true,
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  await writeFile(resolve(repo.projectRoot, "secrets.enc.json"), "{not json\n");
  const before = await snapshotTree(repo);

  const error = await migrate(repo).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(LegacyDotenvMigrationRefusalError);
  expect((error as Error).message).toContain(
    "Invalid encrypted secret store JSON"
  );
  expect((error as Error).message).not.toContain(SHELL_VALUE);
  expect(await snapshotTree(repo)).toEqual(before);
});

test("with the key unset in the shell, the backend isn't read before the migration's own setup", async () => {
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  const repo = await createContractRepo({
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      storePlaintextInBackend: true,
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  expect(
    await findProcessOnlyContractValues({
      projectDir: repo.projectDir,
      projectName: "contract-shell",
      overlayNames: [],
    })
  ).toEqual([]);
});

test("a dotenv value wins over the shell with no backend read at all", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  const repo = await createContractRepo({
    files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      storePlaintextInBackend: true,
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  expect(
    await findProcessOnlyContractValues({
      projectDir: repo.projectDir,
      projectName: "contract-shell",
      overlayNames: [],
    })
  ).toEqual([]);
});

test("an encrypted value still migrates beside a dotenv value, and a shell value stays out", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  process.env.HACK_SECRETS_FILE_KEY = ["synthetic", "file", "1688"].join("-");
  const secret = ["synthetic", "encrypted", "1688"].join("-");
  const repo = await createContractRepo({
    otherVars: [
      {
        key: "SERVICE_TOKEN",
        source: "keychain",
        required: false,
        services: ["api"],
      },
    ],
    files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    secrets: (projectRoot) => ({
      backend: "encrypted_file",
      encryptedFile: {
        path: resolve(projectRoot, "secrets.enc.json"),
        keyPath: resolve(projectRoot, "secrets-file.key"),
      },
    }),
  });
  const store = await resolveSecretStore({
    projectName: "contract-shell",
    projectDir: repo.projectDir,
  });
  await store.set({ key: "SERVICE_TOKEN", value: secret });

  await migrate(repo);

  const layers = await layerTexts(repo);
  expect(layers).toContain(DOTENV_VALUE);
  expect(layers).not.toContain(SHELL_VALUE);
  expect(layers).not.toContain(secret);
  const resolved = await resolveProjectEnvConfig({
    projectRoot: repo.projectRoot,
    projectDir: repo.projectDir,
    serviceNames: ["api", "worker"],
  });
  expect(resolved?.serviceEnv.api?.SERVICE_TOKEN).toBe(secret);
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

const MIRRORED = (projectRoot: string) => ({
  backend: "encrypted_file",
  storePlaintextInBackend: true,
  encryptedFile: {
    path: resolve(projectRoot, "secrets.enc.json"),
    keyPath: resolve(projectRoot, "secrets-file.key"),
  },
});

for (const services of [undefined, ["api"]] as const) {
  const scope = services ? "a service-scoped key" : "an unscoped key";
  test(`an undetermined ${scope} recovers through the printed steps once the key is available`, async () => {
    const repo = await createContractRepo({
      ...(services ? { services } : {}),
      files: { ".env.staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
      secrets: MIRRORED,
    });
    const before = await snapshotTree(repo);
    const exec = ["env", "exec", "--path", repo.projectRoot, "--", "true"];

    const refused = await runHack({
      repo,
      args: exec,
      shellValue: SHELL_VALUE,
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.output).toContain(
      "the secret backend's key isn't available"
    );
    expect(refused.output).not.toContain(SHELL_VALUE);
    expect(await snapshotTree(repo)).toEqual(before);

    // Step 1 with the key still missing stops, and writes no layer.
    const stillMissing = await runHack({ repo, args: exec });
    expect(stillMissing.exitCode).not.toBe(0);
    expect(await snapshotTree(repo)).toEqual(before);

    const withKey = {
      HACK_SECRETS_FILE_KEY: ["synthetic", "file", "1688"].join("-"),
    };
    const serviceFlags = services ? ["--service", "api"] : [];
    const set = (flags: readonly string[], value: string) =>
      runHack({
        repo,
        args: [
          "env",
          "set",
          SHELL_KEY,
          ...flags,
          ...serviceFlags,
          "--local",
          "--value-stdin",
          "--path",
          repo.projectRoot,
        ],
        stdin: `${value}\n`,
        env: withKey,
      });
    expect((await runHack({ repo, args: exec, env: withKey })).exitCode).toBe(
      0
    );
    expect((await set([], SHELL_VALUE)).exitCode).toBe(0);
    expect((await set(["--env", "staging"], DOTENV_VALUE)).exitCode).toBe(0);

    expect(await valueFor(repo, "api")).toBe(SHELL_VALUE);
    expect(await valueFor(repo, "api", "staging")).toBe(DOTENV_VALUE);
    expect(await layerTextsTrackedOnly(repo)).not.toContain(SHELL_VALUE);
  }, 90_000);
}

/** Text of the tracked layers: the machine-local ones are meant to hold the value. */
async function layerTextsTrackedOnly(repo: Repo): Promise<string> {
  const names = (await readdir(repo.projectDir)).filter(
    (name) =>
      name.startsWith("hack.env.") &&
      name.endsWith(".yaml") &&
      !name.endsWith(".local.yaml") &&
      name !== "hack.env.local.yaml"
  );
  const texts = await Promise.all(
    names.map((name) => readFile(resolve(repo.projectDir, name), "utf8"))
  );
  return texts.join("\n");
}

for (const [file, flag] of [
  [".env.My_Staging", "--env"],
  [".env.local", "--env"],
  [".env.foo.bar", "--env"],
  [".env.default", "--env"],
  [".env.base", "--env"],
] as const) {
  test(`an overlay ${file} gets no command that --env can't select`, async () => {
    process.env[SHELL_KEY] = SHELL_VALUE;
    const repo = await createContractRepo({
      files: { [file]: `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    });
    const message = await expectShellValueRefused(repo);
    expect(message).not.toContain(`${flag} ${file.slice(".env.".length)}`);
    expect(message).toContain(JSON.stringify(file));
    expect(message).not.toContain(DOTENV_VALUE);
  });
}

for (const service of ["Api", "a b"]) {
  test(`a contract service ${JSON.stringify(service)} gets no command --service would refuse`, async () => {
    process.env[SHELL_KEY] = SHELL_VALUE;
    const repo = await createContractRepo({ services: [service] });
    const message = await expectShellValueRefused(repo);
    expect(message).not.toContain(`hack env set ${SHELL_KEY} --service`);
    expect(message).toContain(JSON.stringify(service));
  });
}

test("every command the refusal prints is accepted, for the names --env and --service take", async () => {
  const repo = await createContractRepo({
    services: ["api"],
    files: { ".env.staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
  });
  const exec = ["env", "exec", "--path", repo.projectRoot, "--", "true"];
  const refused = await runHack({ repo, args: exec, shellValue: SHELL_VALUE });
  expect(refused.exitCode).not.toBe(0);
  const printed = [
    ...refused.output.matchAll(/hack env set [^;.`\n]+--local --value-stdin/g),
  ].map((match) => match[0]);
  expect(printed).toHaveLength(2);
  expect((await runHack({ repo, args: exec })).exitCode).toBe(0);
  for (const command of printed) {
    const words = command.split(" ").slice(1);
    const run = await runHack({
      repo,
      args: [...words, "--path", repo.projectRoot],
      stdin: `${SHELL_VALUE}\n`,
    });
    expect(run.exitCode).toBe(0);
  }
}, 60_000);

const RESERVED_NAME = "reserved for Hack's own layers";

for (const file of [
  ".env.default",
  ".env.Default",
  ".env.local",
  ".env.LOCAL",
  ".env.staging.local",
]) {
  test(`step 1 refuses an overlay ${file} before any write, and a retry after renaming migrates it`, async () => {
    const repo = await createContractRepo({
      files: {
        ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n`,
        [file]: `${SHELL_KEY}=overlay-value\n`,
        ".env.staging": `${SHELL_KEY}=staging-value\n`,
      },
    });
    const before = await snapshotTree(repo);

    const error = await migrate(repo).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(RESERVED_NAME);
    expect((error as Error).message).toContain("No env layer was written");
    expect((error as Error).message).not.toContain("Nothing was written");
    expect((error as Error).message).toContain(JSON.stringify(file));
    expect((error as Error).message).not.toContain("overlay-value");
    expect(await snapshotTree(repo)).toEqual(before);

    await rename(
      resolve(repo.projectDir, file),
      resolve(repo.projectDir, ".env.renamed")
    );
    await migrate(repo);
    expect(await valueFor(repo, "api")).toBe(DOTENV_VALUE);
    expect(await valueFor(repo, "api", "staging")).toBe("staging-value");
    expect(await valueFor(repo, "api", "renamed")).toBe("overlay-value");
  });
}

test("an overlay .env.default that adds nothing to the base still migrates", async () => {
  const repo = await createContractRepo({
    files: {
      ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n`,
      ".env.default": `${SHELL_KEY}=${DOTENV_VALUE}\n`,
    },
  });
  await migrate(repo);
  expect(await valueFor(repo, "api")).toBe(DOTENV_VALUE);
});

test("step 1 refuses a contract scope a layer can't hold, before any write", async () => {
  const repo = await createContractRepo({
    services: ["Api"],
    files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
  });
  const before = await snapshotTree(repo);

  const error = await migrate(repo).catch((caught: unknown) => caught);

  expect((error as Error).message).toContain(JSON.stringify("Api"));
  expect((error as Error).message).toContain("isn't a valid env scope");
  expect((error as Error).message).toContain("No env layer was written");
  expect((error as Error).message).not.toContain(DOTENV_VALUE);
  expect(await snapshotTree(repo)).toEqual(before);
});

test("a contract scope a layer can't hold doesn't stop a migration with no value for it", async () => {
  const repo = await createContractRepo({ services: ["Api"] });
  const migrated = await migrate(repo);
  expect(migrated.legacyDetected).toBe(true);
  expect(await valueFor(repo, "api")).toBeUndefined();
});

test("a service list with usable and unusable names prints a command for the usable one", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({ services: ["api", "Api"] })
  );
  expect(message).toContain(`hack env set ${SHELL_KEY} --service api --local`);
  expect(message).not.toContain(`hack env set ${SHELL_KEY} --service Api`);
  expect(message).toContain(JSON.stringify("Api"));
});

test("names to fix come before the step that migrates, because a migration can't be redone", async () => {
  process.env[SHELL_KEY] = SHELL_VALUE;
  const message = await expectShellValueRefused(
    await createContractRepo({
      services: ["Api"],
      files: { ".env.My_Staging": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
    })
  );
  const unsetAt = message.indexOf("Unset it for one command");
  expect(unsetAt).toBeGreaterThan(-1);
  for (const name of [".env.My_Staging", "Api"]) {
    const at = message.indexOf(JSON.stringify(name));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(unsetAt);
  }
});

for (const [shape, text] of [
  ["malformed", "{not json\n"],
  ["wrong-shape", '{"version":99}\n'],
] as const) {
  test(`a ${shape} hack.env.json refuses before any write, without quoting the file`, async () => {
    const repo = await createContractRepo({
      files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\nOTHER=only-here\n` },
    });
    await writeFile(resolve(repo.projectDir, "hack.env.json"), text);
    const before = await snapshotTree(repo);

    const error = await migrate(repo).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("hack.env.json can't be read");
    expect((error as Error).message).not.toContain("not json");
    expect((error as Error).message).not.toContain("only-here");
    expect(await snapshotTree(repo)).toEqual(before);
  });
}

for (const kind of ["mode 000", "directory", "dangling link"] as const) {
  test.skipIf(kind === "mode 000" && process.geteuid?.() === 0)(
    `a hack.env.json that can't be opened (${kind}) refuses, and isn't read as no contract`,
    async () => {
      const repo = await createContractRepo({
        files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
      });
      const contract = resolve(repo.projectDir, "hack.env.json");
      if (kind === "mode 000") {
        await chmod(contract, 0o000);
      } else {
        await rm(contract);
        if (kind === "directory") {
          await mkdir(contract);
        } else {
          await symlink(resolve(repo.root, "contract-that-is-gone"), contract);
        }
      }
      const names = async () => (await readdir(repo.projectDir)).sort();
      const before = await names();

      const error = await migrateLegacyProjectEnv({
        projectRoot: repo.projectRoot,
        projectDir: repo.projectDir,
        projectName: "contract-shell",
        serviceNames: ["api", "worker"],
        materialize: false,
        migrateUndeclaredDotenv: true,
      })
        .catch((caught: unknown) => caught)
        .finally(async () => {
          if (kind === "mode 000") {
            await chmod(contract, 0o600);
          }
        });

      expect((error as Error).message).toContain("hack.env.json can't be read");
      expect((error as Error).message).not.toContain(DOTENV_VALUE);
      expect(await names()).toEqual(before);
    }
  );
}

test("env set says a contract it can't open can't be read, not that it's malformed", async () => {
  const repo = await createContractRepo({ files: {} });
  const contract = resolve(repo.projectDir, "hack.env.json");
  await rm(contract);
  await symlink(resolve(repo.root, "contract-that-is-gone"), contract);

  const run = await runHack({
    repo,
    args: [
      "env",
      "set",
      "NEW_SETTING",
      "--value-stdin",
      "--path",
      repo.projectRoot,
    ],
    stdin: "new-value\n",
  });

  expect(run.exitCode).not.toBe(0);
  expect(run.output).toContain("hack.env.json can't be read");
  expect(run.output).not.toContain("is malformed");
  expect(run.output).not.toContain("new-value");
}, 60_000);

test("doctor names a contract it can't open as the migration source, not as absent", async () => {
  const repo = await createContractRepo({
    files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
  });
  const contract = resolve(repo.projectDir, "hack.env.json");
  await rm(contract);
  await symlink(resolve(repo.root, "contract-that-is-gone"), contract);
  const tools = resolve(repo.root, "doctor-tools");
  await mkdir(tools);
  await writeFile(join(tools, "hack"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(tools, "docker"), "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  await writeFile(join(tools, "mutagen"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });

  const run = await runHack({
    repo,
    args: [
      "doctor",
      "--migrate-env-config",
      "--no-interactive",
      "--path",
      repo.projectRoot,
    ],
    env: {
      HACK_LOGGER: "console",
      HACK_MUTAGEN_PATH: join(tools, "mutagen"),
      PATH: `${tools}:/usr/bin:/bin`,
    },
  });

  expect(run.output).toContain("hack.env.json can't be read");
  // The env mode check also says "can't be read", so this proves the migration ran.
  expect(run.output).toContain("Refusing to migrate");
  expect(run.output).toContain("can't be read or parsed");
  expect(run.output).not.toContain("no hack.env.json");
  expect(run.output).not.toContain(
    "and no .hack/hack.env.default.yaml present"
  );
  expect(run.output).not.toContain("Legacy env format detected");
  const entries = await readdir(repo.projectDir);
  expect(entries).toContain("hack.env.json");
  expect(entries).not.toContain("hack.env.default.yaml");
  expect(await readFile(resolve(repo.projectDir, ".env"), "utf8")).toContain(
    DOTENV_VALUE
  );
  expect(run.output).not.toContain(DOTENV_VALUE);
}, 90_000);

for (const kind of ["mode 000", "directory", "dangling link"] as const) {
  test.skipIf(kind === "mode 000" && process.geteuid?.() === 0)(
    `an implicit migration refuses a hack.env.json that can't be opened (${kind}), before any layer`,
    async () => {
      const repo = await createContractRepo({
        files: { ".env": `${SHELL_KEY}=${DOTENV_VALUE}\n` },
      });
      const contract = resolve(repo.projectDir, "hack.env.json");
      if (kind === "mode 000") {
        await chmod(contract, 0o000);
      } else {
        await rm(contract);
        if (kind === "directory") {
          await mkdir(contract);
        } else {
          await symlink(resolve(repo.root, "contract-that-is-gone"), contract);
        }
      }
      const before = (await readdir(repo.projectDir)).sort();

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
        stdin: "new-value\n",
      });
      if (kind === "mode 000") {
        await chmod(contract, 0o600);
      }

      expect(run.exitCode).not.toBe(0);
      expect(run.output).toContain("hack.env.json can't be read");
      expect(run.output).not.toContain(DOTENV_VALUE);
      expect(run.output).not.toContain("new-value");
      expect((await readdir(repo.projectDir)).sort()).toEqual(before);
    },
    60_000
  );
}
