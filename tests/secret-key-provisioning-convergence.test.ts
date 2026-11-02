import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import {
  resolveProjectEnvConfig,
  resolveProjectEnvSharedKeyLocation,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";
import { createSecretWorktreeFixture } from "./helpers/secret-fixture.ts";

/**
 * Concurrent first-use key provisioning must converge on one key (HACK-1127).
 *
 * Each case starts several fresh worker processes (fresh module state, so no
 * in-process key cache can hide a race), releases them together through a
 * stdin barrier, and then proves that every worker ended up with the same key
 * and that every value it wrote decrypts with the key left on disk. Workers
 * report only a SHA-256 digest of the key, never the key.
 *
 * Isolation: private HOME, HACK_HOME and global config inside a temp root;
 * the encrypted-store case configures an explicit key path and resolves every
 * worker while the store is still empty, so the keychain fallback is never
 * reached; the parent reads back with the keychain fallback disabled.
 */

const SECRET_STORE_MODULE = resolve(
  import.meta.dir,
  "..",
  "src",
  "lib",
  "secret-store.ts"
);
const PROJECT_ENV_MODULE = resolve(
  import.meta.dir,
  "..",
  "src",
  "lib",
  "project-env-config.ts"
);
const WORKERS = 8;
const WRITES_PER_WORKER = 4;
const PARENT_ENV_KEYS = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_ENV_SECRET_KEY",
] as const;

let root: string | null = null;
const previousEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-key-convergence-"));
  for (const key of PARENT_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
  }
  process.env.HOME = privateCliHome(root);
  process.env.HACK_HOME = join(root, "hack-home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "hack.config.json");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
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

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type WorkerReport = {
  readonly digest: string;
  readonly keyPath?: string;
  readonly created?: boolean;
};

type WorkerExit = {
  readonly code: number;
  readonly stderr: string;
  readonly report: WorkerReport | null;
};

/**
 * Runs `count` workers of `script`. Each worker prints `loaded`, waits for
 * `start`, does its provisioning, prints `ready <json>`, waits for `go`, does
 * its writes and exits. The parent releases each phase only after every
 * worker reached it, so provisioning overlaps and no write precedes the last
 * provisioning.
 */
async function runWorkers(opts: {
  readonly script: string;
  readonly args: (index: number) => readonly string[];
  readonly count: number;
}): Promise<readonly WorkerExit[]> {
  const base = requireRoot();
  const env = privateCliEnv({
    root: base,
    env: {
      HACK_HOME: process.env.HACK_HOME,
      HACK_GLOBAL_CONFIG_PATH: process.env.HACK_GLOBAL_CONFIG_PATH,
    },
  });
  const workers = Array.from({ length: opts.count }, (_, index) =>
    Bun.spawn({
      cmd: [process.execPath, opts.script, ...opts.args(index)],
      cwd: base,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  );
  const readers = workers.map((worker) => lineReader(worker.stdout));
  const waitAll = async (prefix: string): Promise<string[]> =>
    await Promise.all(
      readers.map(async (next) => {
        const line = await next();
        if (!line?.startsWith(prefix)) {
          throw new Error(`worker did not reach ${prefix}`);
        }
        return line.slice(prefix.length).trim();
      })
    );
  const release = async (word: string): Promise<void> => {
    for (const worker of workers) {
      worker.stdin.write(`${word}\n`);
      await worker.stdin.flush();
    }
  };
  let reports: string[] = [];
  try {
    await waitAll("loaded");
    await release("start");
    reports = await waitAll("ready");
    await release("go");
  } catch (error: unknown) {
    for (const worker of workers) {
      worker.kill();
    }
    const stderr = await Promise.all(
      workers.map(async (worker) => await new Response(worker.stderr).text())
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${stderr.join("\n")}`
    );
  } finally {
    for (const worker of workers) {
      await worker.stdin.end();
    }
  }
  return await Promise.all(
    workers.map(async (worker, index) => ({
      code: await worker.exited,
      stderr: await new Response(worker.stderr).text(),
      report: reports[index]
        ? (JSON.parse(reports[index] ?? "") as WorkerReport)
        : null,
    }))
  );
}

function lineReader(
  stream: ReadableStream<Uint8Array>
): () => Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        return null;
      }
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    const at = buffered.indexOf("\n");
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return line;
  };
}

/** Worker preamble: phase barrier on stdin. */
const BARRIER_PREAMBLE = [
  "const lines = (async function* () {",
  "  let buffered = '';",
  "  for await (const chunk of Bun.stdin.stream()) {",
  "    buffered += new TextDecoder().decode(chunk);",
  "    let at = buffered.indexOf('\\n');",
  "    while (at >= 0) { yield buffered.slice(0, at); buffered = buffered.slice(at + 1); at = buffered.indexOf('\\n'); }",
  "  }",
  "})();",
  "async function waitFor(word) {",
  "  const next = await lines.next();",
  "  if (next.done || next.value !== word) { process.exit(3); }",
  "}",
  "process.stdout.write('loaded\\n');",
  "await waitFor('start');",
].join("\n");

async function writeGlobalStoreConfig(opts: {
  readonly storePath: string;
  readonly keyPath: string;
}): Promise<void> {
  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH ?? "",
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: opts.storePath, keyPath: opts.keyPath },
        },
      },
    })}\n`
  );
}

test("concurrent first use of an encrypted_file store converges on one key and loses no value", async () => {
  const base = requireRoot();
  const storePath = join(base, "store", "secrets.enc.json");
  const keyPath = join(base, "keys", "secrets-file.key");
  await writeGlobalStoreConfig({ storePath, keyPath });
  const script = join(base, "store-worker.ts");
  await writeFile(
    script,
    [
      `import { resolveSecretStore } from ${JSON.stringify(SECRET_STORE_MODULE)};`,
      BARRIER_PREAMBLE,
      "const id = process.argv[2] ?? 'W';",
      "const store = await resolveSecretStore({ projectName: 'app' });",
      "process.stdout.write(`ready ${JSON.stringify({ digest: 'n/a' })}\\n`);",
      "await waitFor('go');",
      `for (let index = 0; index < ${WRITES_PER_WORKER}; index += 1) {`,
      "  await store.set({ key: `${id}_${index}`, value: `synthetic-${id}-${index}` });",
      "}",
      "",
    ].join("\n")
  );
  const exits = await runWorkers({
    script,
    count: WORKERS,
    args: (index) => [`W${index}`],
  });
  for (const exit of exits) {
    expect({ code: exit.code, stderr: exit.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
  }

  // One complete key file, private, with no staging leftovers.
  const keyInfo = await lstat(keyPath);
  expect(keyInfo.isFile()).toBe(true);
  expect(keyInfo.mode & 0o777).toBe(0o600);
  expect(keyInfo.nlink).toBe(1);
  expect((await readFile(keyPath, "utf8")).trim().length).toBeGreaterThan(0);
  expect(await readdir(join(base, "keys"))).toEqual(["secrets-file.key"]);

  // Every worker's values decrypt with the key on disk (keychain disabled).
  const store = await resolveSecretStore({ projectName: "app" });
  for (let worker = 0; worker < WORKERS; worker += 1) {
    for (let index = 0; index < WRITES_PER_WORKER; index += 1) {
      expect(await store.get({ key: `W${worker}_${index}` })).toBe(
        `synthetic-W${worker}-${index}`
      );
    }
  }
});

test("concurrent project key creation from primary and linked checkouts converges", async () => {
  const base = requireRoot();
  const fixture = await createSecretWorktreeFixture({
    parent: base,
    home: privateCliHome(base),
    name: "key-convergence",
  });
  const script = join(base, "project-key-worker.ts");
  await writeFile(
    script,
    [
      `import { createHash } from "node:crypto";`,
      `import { ensureProjectEnvSecretKey } from ${JSON.stringify(PROJECT_ENV_MODULE)};`,
      BARRIER_PREAMBLE,
      "const ensured = await ensureProjectEnvSecretKey({ projectRoot: process.argv[2] ?? '' });",
      "const digest = createHash('sha256').update(ensured.keyText, 'utf8').digest('hex');",
      "process.stdout.write(`ready ${JSON.stringify({ digest, keyPath: ensured.keyPath, created: ensured.created })}\\n`);",
      "await waitFor('go');",
      "",
    ].join("\n")
  );
  const exits = await runWorkers({
    script,
    count: WORKERS,
    args: (index) => [
      index % 2 === 0 ? fixture.primaryRoot : fixture.linkedRoot,
    ],
  });
  for (const exit of exits) {
    expect({ code: exit.code, stderr: exit.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
  }
  const digests = new Set(exits.map((exit) => exit.report?.digest));
  expect(digests.size).toBe(1);
  expect(exits.filter((exit) => exit.report?.created).length).toBe(1);

  // Every key file that exists holds that one key.
  const shared = await resolveProjectEnvSharedKeyLocation({
    projectRoot: fixture.linkedRoot,
  });
  const candidates = [
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME),
    resolve(fixture.linkedRoot, PROJECT_ENV_KEY_FILENAME),
    shared?.path ?? "",
  ];
  let present = 0;
  for (const path of candidates) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) {
      present += 1;
      expect(digest(text.trim())).toBe([...digests][0] ?? "");
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
  }
  expect(present).toBeGreaterThan(0);

  // A value encrypted in one checkout decrypts in the other.
  for (const [writer, reader] of [
    [fixture.primaryRoot, fixture.linkedRoot],
    [fixture.linkedRoot, fixture.primaryRoot],
  ] as const) {
    await setProjectEnvValue({
      projectRoot: writer,
      projectDir: join(writer, ".hack"),
      envName: null,
      scope: "global",
      key: "CROSS_CHECKOUT",
      value: "synthetic-cross-checkout-value",
      secret: true,
      local: true,
    });
    await writeFile(
      join(reader, ".hack", "hack.env.local.yaml"),
      await readFile(join(writer, ".hack", "hack.env.local.yaml"), "utf8")
    );
    const resolved = await resolveProjectEnvConfig({
      projectRoot: reader,
      projectDir: join(reader, ".hack"),
      envName: null,
      serviceNames: ["api"],
    });
    expect(resolved?.globalEnv.CROSS_CHECKOUT).toBe(
      "synthetic-cross-checkout-value"
    );
  }
});
