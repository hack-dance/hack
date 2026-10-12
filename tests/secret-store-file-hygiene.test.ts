import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

const STORE_KEY = "synthetic-store-hygiene-key-for-tests-only";
const STORE_SENTINEL = "synthetic-store-hygiene-value-never-in-errors";
const SECRET_STORE_MODULE = resolve(
  import.meta.dir,
  "..",
  "src",
  "lib",
  "secret-store.ts"
);
const WRITES_PER_PROCESS = 20;
const ISOLATED_ENV_KEYS = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
] as const;

let root: string | null = null;
const previousEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-secret-store-hygiene-"));
  for (const key of ISOLATED_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
  }
  // Temp HOME and global config; the env key wins, and the keychain fallback is
  // disabled so no test can reach the native keychain.
  process.env.HOME = join(root, "home");
  process.env.HACK_HOME = join(root, "home", ".hack");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "home", "hack.config.json");
  process.env.HACK_SECRETS_FILE_KEY = STORE_KEY;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
  for (const key of ISOLATED_ENV_KEYS) {
    restoreEnv(key, previousEnv.get(key));
  }
  previousEnv.clear();
});

async function configureEncryptedFileStore(): Promise<{
  readonly storeDir: string;
  readonly storePath: string;
}> {
  if (!root) {
    throw new Error("Missing temp root");
  }
  const storeDir = resolve(root, "store");
  await mkdir(storeDir);
  const storePath = resolve(storeDir, "secrets.enc.json");
  const configPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Missing HACK_GLOBAL_CONFIG_PATH");
  }
  await writeFile(
    configPath,
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath },
        },
      },
    })}\n`
  );
  return { storeDir, storePath };
}

async function nonEnvelopeEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(
    (name) => name !== "secrets.enc.json"
  );
}

test("encrypted_file store writes mode 0600 by atomic replace", async () => {
  const { storeDir, storePath } = await configureEncryptedFileStore();
  const store = await resolveSecretStore({ projectName: "app" });
  await store.set({ key: "TOKEN", value: "first" });
  expect((await stat(storePath)).mode & 0o777).toBe(0o600);

  // The old inode keeps its bytes only when the writer renames a new file over
  // the path instead of truncating and rewriting the existing one.
  const previousName = resolve(storeDir, "previous-inode");
  await link(storePath, previousName);
  const previousText = await readFile(storePath, "utf8");
  const before = await stat(storePath);

  await store.set({ key: "TOKEN", value: STORE_SENTINEL });

  const after = await stat(storePath);
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o600);
  expect(await readFile(previousName, "utf8")).toBe(previousText);
  expect(await store.get({ key: "TOKEN" })).toBe(STORE_SENTINEL);
  expect(await readFile(storePath, "utf8")).not.toContain(STORE_SENTINEL);

  expect(await store.delete({ key: "TOKEN" })).toBe(true);
  expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  // No staging file or lock receipt is left behind.
  expect(await nonEnvelopeEntries(storeDir)).toEqual(["previous-inode"]);
});

test("encrypted_file store refuses to write through a symlinked store path", async () => {
  if (!root) {
    throw new Error("Missing temp root");
  }
  const { storeDir, storePath } = await configureEncryptedFileStore();
  const outsideFile = resolve(root, "outside-store.json");
  // An empty target reads as an empty store, so only the write guard can stop
  // the set below.
  await writeFile(outsideFile, "");
  await symlink(outsideFile, storePath);

  const store = await resolveSecretStore({ projectName: "app" });
  const error = await store.set({ key: "TOKEN", value: STORE_SENTINEL }).then(
    () => null,
    (caught: unknown) => caught
  );

  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toBe(
    "Refused encrypted secret store write: the store path is a symlink or not a regular file. Replace it with a regular file and retry; values omitted."
  );
  for (const privateText of [STORE_SENTINEL, STORE_KEY, "TOKEN", outsideFile]) {
    expect(String(error)).not.toContain(privateText);
  }
  expect(await readFile(outsideFile, "utf8")).toBe("");
  expect((await lstat(storePath)).isSymbolicLink()).toBe(true);
  expect(await nonEnvelopeEntries(storeDir)).toEqual([]);
});

test("negative control: concurrent in-process writers do not lose an update", async () => {
  const { storeDir } = await configureEncryptedFileStore();
  const writers = await Promise.all(
    ["app", "app", "other", "other"].map((projectName) =>
      resolveSecretStore({ projectName })
    )
  );
  const writes: Promise<void>[] = [];
  for (let index = 0; index < 24; index += 1) {
    const writer = writers[index % writers.length];
    if (!writer) {
      throw new Error("missing writer");
    }
    writes.push(writer.set({ key: `KEY_${index}`, value: `value-${index}` }));
  }
  await Promise.all(writes);

  for (const projectName of ["app", "other"]) {
    const store = await resolveSecretStore({ projectName });
    for (let index = 0; index < 24; index += 1) {
      const writtenBy = index % 4 < 2 ? "app" : "other";
      expect(await store.get({ key: `KEY_${index}` })).toBe(
        writtenBy === projectName ? `value-${index}` : null
      );
    }
  }
  expect(await nonEnvelopeEntries(storeDir)).toEqual([]);
});

test("negative control: concurrent writer processes do not lose an update", async () => {
  if (!root) {
    throw new Error("Missing temp root");
  }
  const { storeDir } = await configureEncryptedFileStore();
  const script = resolve(root, "store-writer.ts");
  await writeFile(
    script,
    [
      `import { resolveSecretStore } from ${JSON.stringify(SECRET_STORE_MODULE)};`,
      "const prefix = process.argv[2] ?? 'P';",
      "const startAt = Number(process.argv[3]);",
      "const store = await resolveSecretStore({ projectName: 'app' });",
      "// Start together so the writers' read-modify-write cycles overlap.",
      "await Bun.sleep(Math.max(0, startAt - Date.now()));",
      `for (let index = 0; index < ${WRITES_PER_PROCESS}; index += 1) {`,
      "  await store.set({ key: `${prefix}_${index}`, value: `${prefix}-${index}` });",
      "}",
      "",
    ].join("\n")
  );
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  for (const key of ISOLATED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const prefixes = ["A", "B", "C"];
  const startAt = String(Date.now() + 750);
  const children = prefixes.map((prefix) =>
    Bun.spawn({
      cmd: [process.execPath, script, prefix, startAt],
      cwd: root ?? undefined,
      env: childEnv,
      stdout: "ignore",
      stderr: "pipe",
    })
  );
  const exits = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    }))
  );
  for (const exit of exits) {
    expect(exit).toEqual({ code: 0, stderr: "" });
  }

  const store = await resolveSecretStore({ projectName: "app" });
  for (const prefix of prefixes) {
    for (let index = 0; index < WRITES_PER_PROCESS; index += 1) {
      expect(await store.get({ key: `${prefix}_${index}` })).toBe(
        `${prefix}-${index}`
      );
    }
  }
  expect(await nonEnvelopeEntries(storeDir)).toEqual([]);
});
