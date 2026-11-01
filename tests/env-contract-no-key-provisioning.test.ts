import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-1688: the check for shell-only contract values reads a mirrored backend
 * before the migration refuses, and that read must not create key material.
 * These runs leave HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK unset: with it set, the
 * read stops before any provisioning code, so it can't show this. The worker stubs
 * Bun.secrets, so the OS keychain isn't reached.
 */

const WORKER = resolve(
  import.meta.dir,
  "fixtures",
  "contract-migration-keychain-worker.ts"
);
const SHELL_KEY = "NO_PROVISION_SHELL_KEY";
const SHELL_VALUE = ["synthetic", "shell", "1688"].join("-");
const UNAVAILABLE = "the secret backend's key isn't available";

const children = fixtureChildren("env-contract-no-key-provisioning");
const roots: string[] = [];

afterEach(async () => {
  await children.stopAll();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    out[relative(root, path)] = entry.isFile()
      ? `${(await stat(path)).mode.toString(8)}:${(await readFile(path)).toString("base64")}`
      : "not-a-file";
  }
  return out;
}

async function expectRefusedWithoutProvisioning(opts: {
  readonly keychain: "empty" | "key" | "throw";
  readonly configuredKeyPath: boolean;
  readonly unavailable: boolean;
}): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-no-provision-"))
  );
  roots.push(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  const keyPath = resolve(projectRoot, "secrets-file.key");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "contract-keychain",
      dev_host: "contract-keychain.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          storePlaintextInBackend: true,
          encryptedFile: {
            path: resolve(projectRoot, "secrets.enc.json"),
            ...(opts.configuredKeyPath ? { keyPath } : {}),
          },
        },
      },
    })}\n`
  );
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: SHELL_KEY, source: "plain_env", required: false }],
    })}\n`
  );
  const before = await snapshot(projectRoot);

  const run = await children.run({
    cmd: [process.execPath, WORKER],
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        [SHELL_KEY]: SHELL_VALUE,
        HACK_GLOBAL_CONFIG_PATH: join(root, "hack-config.json"),
        HACK_HOME: join(root, "hack-home"),
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: undefined,
        HACK_SECRETS_FILE_KEY: undefined,
        HACK_TEST_KEYCHAIN: opts.keychain,
        HACK_TEST_PROJECT_ROOT: projectRoot,
      },
    }),
  });

  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  const result = JSON.parse(run.stdout) as {
    readonly message: string | null;
    readonly calls: {
      readonly get: number;
      readonly set: number;
      readonly delete: number;
    };
  };
  expect(result.message).toContain(SHELL_KEY);
  expect(result.message).not.toContain(SHELL_VALUE);
  expect(result.message?.includes(UNAVAILABLE)).toBe(opts.unavailable);
  expect(await snapshot(projectRoot)).toEqual(before);
  expect(await lstat(keyPath).catch(() => null)).toBeNull();
  // Anywhere under the fixture, which holds the private HOME and the default key path.
  const everything = await readdir(root, { recursive: true });
  expect(
    everything.filter((path) => path.endsWith("secrets-file.key"))
  ).toEqual([]);
  // The keychain branch ran, so this input reached the code past the disable flag.
  expect(result.calls.get).toBeGreaterThan(0);
  expect(result.calls.set).toBe(0);
  expect(result.calls.delete).toBe(0);
}

test("a configured key path and an empty keychain create no key before the refusal", async () => {
  await expectRefusedWithoutProvisioning({
    keychain: "empty",
    configuredKeyPath: true,
    unavailable: true,
  });
}, 45_000);

test("a key in the keychain isn't copied to a configured key path before the refusal", async () => {
  await expectRefusedWithoutProvisioning({
    keychain: "key",
    configuredKeyPath: true,
    unavailable: false,
  });
}, 45_000);

test("the default key path and an empty keychain create no key before the refusal", async () => {
  await expectRefusedWithoutProvisioning({
    keychain: "empty",
    configuredKeyPath: false,
    unavailable: true,
  });
}, 45_000);

test("a failed keychain read refuses as unavailable and creates no key", async () => {
  await expectRefusedWithoutProvisioning({
    keychain: "throw",
    configuredKeyPath: true,
    unavailable: true,
  });
}, 45_000);

/** One worker run with no shell value, or a stored backend, or the keychain backend. */
async function runWorker(opts: {
  readonly keychain: "empty" | "key" | "throw";
  readonly shell: boolean;
  readonly storePresent: boolean;
  readonly backend?: "encrypted_file" | "keychain";
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-no-provision-"))
  );
  roots.push(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  const keyPath = resolve(projectRoot, "secrets-file.key");
  const storePath = resolve(projectRoot, "secrets.enc.json");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "contract-keychain",
      dev_host: "contract-keychain.hack",
      controlPlane: {
        secrets:
          opts.backend === "keychain"
            ? { backend: "keychain", storePlaintextInBackend: true }
            : {
                backend: "encrypted_file",
                storePlaintextInBackend: true,
                encryptedFile: { path: storePath, keyPath },
              },
      },
    })}\n`
  );
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: SHELL_KEY, source: "plain_env", required: false }],
    })}\n`
  );
  if (opts.storePresent) {
    await writeFile(storePath, '{"version":1,"entries":{"x":"synthetic"}}\n');
  }
  const before = await snapshot(projectRoot);
  const run = await children.run({
    cmd: [process.execPath, WORKER],
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        ...(opts.shell ? { [SHELL_KEY]: SHELL_VALUE } : {}),
        HACK_GLOBAL_CONFIG_PATH: join(root, "hack-config.json"),
        HACK_HOME: join(root, "hack-home"),
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: undefined,
        HACK_SECRETS_FILE_KEY: undefined,
        HACK_TEST_KEYCHAIN: opts.keychain,
        HACK_TEST_PROJECT_ROOT: projectRoot,
      },
    }),
  });
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  return {
    result: JSON.parse(run.stdout) as {
      readonly message: string | null;
      readonly calls: {
        readonly get: number;
        readonly set: number;
        readonly delete: number;
      };
    },
    before,
    after: await snapshot(projectRoot),
    keyFile: await lstat(keyPath).catch(() => null),
  };
}

test("with nothing stored, the printed step 1 migrates and writes no shell value", async () => {
  const { result, after } = await runWorker({
    keychain: "empty",
    shell: false,
    storePresent: false,
  });
  expect(result.message).toBeNull();
  expect(Object.keys(after)).toContain(".hack/hack.env.default.yaml");
  expect(JSON.stringify(after)).not.toContain(
    Buffer.from(SHELL_VALUE).toString("base64")
  );
}, 45_000);

test("a store with no key refuses a shell value, and leaves the store and key path alone", async () => {
  const { result, before, after, keyFile } = await runWorker({
    keychain: "empty",
    shell: true,
    storePresent: true,
  });
  expect(result.message).toContain(UNAVAILABLE);
  expect(result.message).not.toContain(SHELL_VALUE);
  expect(after).toEqual(before);
  expect(keyFile).toBeNull();
  expect(result.calls.set).toBe(0);
}, 45_000);

test("a store with no key stops step 1 too, with no layer and no key", async () => {
  const { result, before, after, keyFile } = await runWorker({
    keychain: "empty",
    shell: false,
    storePresent: true,
  });
  expect(result.message).not.toBeNull();
  expect(after).toEqual(before);
  expect(keyFile).toBeNull();
  expect(result.calls.set).toBe(0);
}, 45_000);

test("a keychain backend read failure stops the migration with its own error", async () => {
  const { result, before, after } = await runWorker({
    keychain: "throw",
    shell: true,
    storePresent: false,
    backend: "keychain",
  });
  expect(result.message).toContain("stub keychain failure");
  expect(result.message).not.toContain(SHELL_VALUE);
  expect(after).toEqual(before);
  expect(result.calls.set).toBe(0);
}, 45_000);
