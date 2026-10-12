/**
 * Characterization of v1 AES-GCM context binding (HACK-1127).
 *
 * These tests pin existing behavior; they do not change or endorse it. Both v1
 * formats (the encrypted_file store envelope and the legacy `v1:` secure env
 * value) derive the AES-256 key as SHA-256(key text), use a 12-byte IV and a
 * 16-byte tag, and authenticate NO associated data. Consequently a v1 envelope
 * is not bound to its file path, project, scope, overlay or variable name:
 *
 * - the store binds an entry to its project only through the scoped key inside
 *   the authenticated plaintext (`encodeURIComponent(scope)::encodeURIComponent(key)`);
 * - a legacy `v1:` value moved to another variable or scope still decrypts.
 *
 * Adding context binding requires a new envelope version; a v1 change that made
 * any of these tests fail would break existing v1 stores and values.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
} from "../src/constants.ts";
import {
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

const STORE_KEY = "synthetic-v1-binding-store-key";
const ENV_KEY = "synthetic-v1-binding-env-key";
const SENTINEL = "synthetic-v1-binding-value-never-in-errors";
const OTHER_SENTINEL = "synthetic-v1-binding-other-value";
/** Fixed test vector IV; production always draws a random IV. */
const FIXED_IV = Buffer.from("000102030405060708090a0b", "hex");
const ISOLATED_ENV_KEYS = [
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
  root = await mkdtemp(join(tmpdir(), "hack-v1-binding-"));
  for (const key of ISOLATED_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
  }
  process.env.HOME = join(root, "home");
  process.env.HACK_HOME = join(root, "home", ".hack");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "home", "hack.config.json");
  process.env.HACK_SECRETS_FILE_KEY = STORE_KEY;
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
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

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

function deriveKey(keyText: string): Buffer {
  return nodeCrypto.createHash("sha256").update(keyText, "utf8").digest();
}

/** AES-256-GCM seal with an optional AAD, mirroring the v1 parameters. */
function seal(opts: {
  readonly keyText: string;
  readonly plaintext: string;
  readonly aad?: Buffer;
}): { readonly iv: Buffer; readonly tag: Buffer; readonly ciphertext: Buffer } {
  const cipher = nodeCrypto.createCipheriv(
    "aes-256-gcm",
    deriveKey(opts.keyText),
    FIXED_IV,
    { authTagLength: 16 }
  );
  if (opts.aad) {
    cipher.setAAD(opts.aad);
  }
  const ciphertext = Buffer.concat([
    cipher.update(opts.plaintext, "utf8"),
    cipher.final(),
  ]);
  return { iv: FIXED_IV, tag: cipher.getAuthTag(), ciphertext };
}

function open(opts: {
  readonly keyText: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}): string {
  const decipher = nodeCrypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(opts.keyText),
    Buffer.from(opts.iv, "base64"),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(Buffer.from(opts.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(opts.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// encrypted_file store envelope
// ---------------------------------------------------------------------------

async function configureStore(opts: {
  readonly storePath: string;
  readonly cloud?: boolean;
}): Promise<void> {
  const configPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Missing HACK_GLOBAL_CONFIG_PATH");
  }
  const secrets = opts.cloud
    ? {
        backend: "cloud",
        encryptedFile: { path: opts.storePath },
        cloud: {
          provider: "aws",
          project: "dev-account",
          secretPrefix: "hack-cli",
        },
      }
    : { backend: "encrypted_file", encryptedFile: { path: opts.storePath } };
  await writeFile(
    configPath,
    `${JSON.stringify({ controlPlane: { secrets } })}\n`
  );
}

function storeEnvelopeText(opts: {
  readonly plaintext: string;
  readonly aad?: Buffer;
}): string {
  const sealed = seal({ keyText: STORE_KEY, ...opts });
  return `${JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: sealed.iv.toString("base64"),
    tag: sealed.tag.toString("base64"),
    ciphertext: sealed.ciphertext.toString("base64"),
  })}\n`;
}

const STORE_PLAINTEXT = JSON.stringify({
  version: 1,
  entries: { "app::TOKEN": SENTINEL },
});

test("v1 store: written envelope has the pinned fields and a scoped-key plaintext", async () => {
  const storePath = resolve(requireRoot(), "secrets.enc.json");
  await configureStore({ storePath });
  const store = await resolveSecretStore({ projectName: "app" });
  await store.set({ key: "TOKEN", value: SENTINEL });

  const envelope = JSON.parse(await readFile(storePath, "utf8")) as Record<
    string,
    string | number
  >;
  expect(Object.keys(envelope)).toEqual([
    "version",
    "algorithm",
    "iv",
    "tag",
    "ciphertext",
  ]);
  expect(envelope.version).toBe(1);
  expect(envelope.algorithm).toBe("aes-256-gcm");
  // Opening with SHA-256(key), no AAD, reproduces the exact v1 plaintext.
  expect(
    open({
      keyText: STORE_KEY,
      iv: String(envelope.iv),
      tag: String(envelope.tag),
      ciphertext: String(envelope.ciphertext),
    })
  ).toBe(STORE_PLAINTEXT);
});

test("v1 store: a test-vector envelope sealed without AAD opens", async () => {
  const storePath = resolve(requireRoot(), "secrets.enc.json");
  await configureStore({ storePath });
  await writeFile(storePath, storeEnvelopeText({ plaintext: STORE_PLAINTEXT }));
  const store = await resolveSecretStore({ projectName: "app" });
  expect(await store.get({ key: "TOKEN" })).toBe(SENTINEL);
});

for (const [label, aad] of [
  ["the store path", (storePath: string) => Buffer.from(storePath, "utf8")],
  ["the project scope", () => Buffer.from("app", "utf8")],
  ["the envelope version", () => Buffer.from("v1", "utf8")],
] as const) {
  test(`v1 store: an envelope sealed with ${label} as AAD is refused (no AAD is authenticated)`, async () => {
    const storePath = resolve(requireRoot(), "secrets.enc.json");
    await configureStore({ storePath });
    await writeFile(
      storePath,
      storeEnvelopeText({ plaintext: STORE_PLAINTEXT, aad: aad(storePath) })
    );
    const store = await resolveSecretStore({ projectName: "app" });
    const error = await store.get({ key: "TOKEN" }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "Cannot decrypt encrypted secret store at "
    );
    for (const privateText of [SENTINEL, STORE_KEY]) {
      expect(String(error)).not.toContain(privateText);
    }
  });
}

test("v1 store: an envelope is not bound to its file path", async () => {
  const firstPath = resolve(requireRoot(), "first.enc.json");
  await configureStore({ storePath: firstPath });
  const first = await resolveSecretStore({ projectName: "app" });
  await first.set({ key: "TOKEN", value: SENTINEL });

  const movedPath = resolve(requireRoot(), "moved", "second.enc.json");
  await mkdir(resolve(requireRoot(), "moved"));
  await copyFile(firstPath, movedPath);
  await configureStore({ storePath: movedPath });
  const moved = await resolveSecretStore({ projectName: "app" });
  expect(moved.descriptor.location).toBe(movedPath);
  expect(await moved.get({ key: "TOKEN" })).toBe(SENTINEL);
});

test("v1 store: project binding lives only in the scoped plaintext key", async () => {
  const storePath = resolve(requireRoot(), "secrets.enc.json");
  await configureStore({ storePath });
  // A test-vector entry under another project's scoped key is visible to that
  // project and invisible to this one; nothing outside the plaintext binds it.
  await writeFile(
    storePath,
    storeEnvelopeText({
      plaintext: JSON.stringify({
        version: 1,
        entries: {
          "app::TOKEN": SENTINEL,
          "my%20app::TOKEN": OTHER_SENTINEL,
        },
      }),
    })
  );
  expect(
    await (await resolveSecretStore({ projectName: "app" })).get({
      key: "TOKEN",
    })
  ).toBe(SENTINEL);
  expect(
    await (await resolveSecretStore({ projectName: "other" })).get({
      key: "TOKEN",
    })
  ).toBeNull();
  expect(
    await (await resolveSecretStore({ projectName: "my app" })).get({
      key: "TOKEN",
    })
  ).toBe(OTHER_SENTINEL);
});

test("v1 store: the cloud shim scope is a plaintext key prefix in the same envelope", async () => {
  const storePath = resolve(requireRoot(), "cloud.enc.json");
  await configureStore({ storePath, cloud: true });
  const store = await resolveSecretStore({ projectName: "app" });
  await store.set({ key: "API_TOKEN", value: SENTINEL });
  const envelope = JSON.parse(await readFile(storePath, "utf8")) as Record<
    string,
    string
  >;
  const plaintext = JSON.parse(
    open({
      keyText: STORE_KEY,
      iv: String(envelope.iv),
      tag: String(envelope.tag),
      ciphertext: String(envelope.ciphertext),
    })
  ) as { readonly entries: Record<string, string> };
  expect(plaintext.entries).toEqual({
    "cloud%3Aaws%3Adev-account%3Ahack-cli%3Aapp::API_TOKEN": SENTINEL,
  });
});

// ---------------------------------------------------------------------------
// legacy `v1:` secure env values
// ---------------------------------------------------------------------------

async function createLegacyProject(): Promise<{
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly configPath: string;
}> {
  const projectRoot = resolve(requireRoot(), "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "v1-binding", dev_host: "v1-binding.hack" })}\n`
  );
  await writeFile(
    resolve(projectRoot, PROJECT_ENV_KEY_FILENAME),
    `${ENV_KEY}\n`
  );
  return {
    projectRoot,
    projectDir,
    configPath: resolve(projectDir, "hack.env.default.yaml"),
  };
}

type LegacyConfig = {
  readonly version: number;
  readonly environment: string;
  readonly secretsprovider: string;
  readonly values: Record<string, Record<string, { readonly secure: string }>>;
};

async function readLegacyConfig(path: string): Promise<LegacyConfig> {
  return YAML.parse(await readFile(path, "utf8")) as LegacyConfig;
}

function secureOf(config: LegacyConfig, scope: string, key: string): string {
  const secure = config.values[scope]?.[key]?.secure;
  if (typeof secure !== "string") {
    throw new Error("missing secure value");
  }
  return secure;
}

async function resolveLegacy(project: {
  readonly projectRoot: string;
  readonly projectDir: string;
}) {
  const resolved = await resolveProjectEnvConfig({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: null,
    serviceNames: ["api"],
  });
  if (!resolved) {
    throw new Error("missing resolved config");
  }
  return resolved;
}

test("legacy v1: a secure value swapped across variable and scope still decrypts", async () => {
  const project = await createLegacyProject();
  for (const [scope, key, value] of [
    ["global", "TOKEN", SENTINEL],
    ["api", "OTHER", OTHER_SENTINEL],
  ] as const) {
    await setProjectEnvValue({
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      envName: null,
      scope,
      key,
      value,
      secret: true,
    });
  }
  const config = await readLegacyConfig(project.configPath);
  const token = secureOf(config, "global", "TOKEN");
  const other = secureOf(config, "api", "OTHER");
  expect(token.split(":")[0]).toBe("v1");
  expect(Buffer.from(token.split(":")[1] ?? "", "base64").length).toBe(12);

  await writeFile(
    project.configPath,
    JSON.stringify({
      ...config,
      values: {
        global: { TOKEN: { secure: other } },
        api: { OTHER: { secure: token } },
      },
    })
  );
  const resolved = await resolveLegacy(project);
  expect(resolved.globalEnv.TOKEN).toBe(OTHER_SENTINEL);
  expect(resolved.serviceEnv.api?.OTHER).toBe(SENTINEL);
});

function legacyValue(aad?: Buffer): string {
  const sealed = seal({ keyText: ENV_KEY, plaintext: SENTINEL, aad });
  return [
    "v1",
    sealed.iv.toString("base64"),
    sealed.tag.toString("base64"),
    sealed.ciphertext.toString("base64"),
  ].join(":");
}

async function writeLegacyValue(opts: {
  readonly configPath: string;
  readonly secure: string;
}): Promise<void> {
  await writeFile(
    opts.configPath,
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: { secure: opts.secure } } },
    })
  );
}

test("legacy v1: a test-vector value sealed without AAD decrypts", async () => {
  const project = await createLegacyProject();
  await writeLegacyValue({
    configPath: project.configPath,
    secure: legacyValue(),
  });
  expect((await resolveLegacy(project)).globalEnv.TOKEN).toBe(SENTINEL);
});

for (const [label, aad] of [
  ["the variable name", Buffer.from("TOKEN", "utf8")],
  ["the scope", Buffer.from("global", "utf8")],
  ["the version prefix", Buffer.from("v1", "utf8")],
] as const) {
  test(`legacy v1: a value sealed with ${label} as AAD is refused (no AAD is authenticated)`, async () => {
    const project = await createLegacyProject();
    await writeLegacyValue({
      configPath: project.configPath,
      secure: legacyValue(aad),
    });
    const error = await resolveLegacy(project).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toBe(
      "Invalid secure env value."
    );
    for (const privateText of [SENTINEL, ENV_KEY]) {
      expect(String(error)).not.toContain(privateText);
    }
  });
}
