import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { secrets } from "bun";
import { runCli } from "../src/cli/run.ts";
import { resolveHackEnv } from "../src/lib/hack-env.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

const savedEnv = new Map<string, string | undefined>();
let root: string;
let projectRoot: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-env-get-"));
  projectRoot = join(root, "project");
  projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  for (const name of [
    "HACK_GLOBAL_CONFIG_PATH",
    "HACK_ENV_SECRET_KEY",
    "HACK_SECRETS_FILE_KEY",
    "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
    "CI",
    "HACK_EXECUTION_MODE",
    "HACK_ENV_GET_AMBIENT",
  ]) {
    savedEnv.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "global.json");
  await writeFile(process.env.HACK_GLOBAL_CONFIG_PATH, "{}");
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "env-get-fixture", env: { defaultOverlay: "qa" } })
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    restoreEnv(name, value);
  }
  savedEnv.clear();
  await rm(root, { recursive: true, force: true });
});

async function layer(
  file: string,
  values: Record<string, unknown>,
  dir = projectDir
) {
  await writeFile(
    join(dir, file),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values,
    })
  );
}

async function get(
  key: string,
  extra: readonly string[] = [],
  path = projectRoot
) {
  return await capture(["env", "get", key, "--path", path, ...extra]);
}

async function capture(args: readonly string[]) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(Buffer.from(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(Buffer.from(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCli(args);
    return {
      code,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function expectValue(result: Awaited<ReturnType<typeof get>>, value: string) {
  expect(result.code).toBe(0);
  expect(result.stdout).toEqual(Buffer.from(value));
  expect(result.stderr).toEqual(Buffer.alloc(0));
}

function expectFailure(result: Awaited<ReturnType<typeof get>>) {
  expect(result.code).toBe(1);
  expect(result.stdout).toEqual(Buffer.alloc(0));
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(result.stderr.toString()).not.toContain("synthetic-private-canary");
}

test("get honors configured overlay, explicit default, service and local layer precedence", async () => {
  await layer("hack.env.default.yaml", {
    global: { VALUE: "base" },
    api: { VALUE: "base-service" },
  });
  await layer("hack.env.qa.yaml", {
    global: { VALUE: "qa-global" },
    api: { SERVICE_ONLY: "qa-service" },
  });
  expectValue(await get("VALUE"), "qa-global");
  expectValue(await get("VALUE", ["--env", "default"]), "base");
  expectValue(
    await get("VALUE", ["--env=base", "--service", "api"]),
    "base-service"
  );
  expectValue(await get("VALUE", ["--service", "api"]), "qa-global");
  expectFailure(await get("SERVICE_ONLY"));
  expectValue(await get("SERVICE_ONLY", ["--service", "api"]), "qa-service");
  await layer("hack.env.local.yaml", { global: { VALUE: "local" } });
  await layer("hack.env.qa.local.yaml", { api: { VALUE: "local-qa-service" } });
  expectValue(await get("VALUE"), "local");
  expectValue(await get("VALUE", ["--service", "api"]), "local-qa-service");
  expectFailure(await get("VALUE", ["--service", "unknown"]));
  // Optional overlays follow existing resolution: absent layers leave base/local intact.
  expectValue(await get("VALUE", ["--env", "missing-overlay"]), "local");
});

test("get preserves exact UTF-8, empty, multiline and trailing-newline bytes for plain and encrypted values", async () => {
  for (const [key, value] of Object.entries({
    EMPTY: "",
    TEXT: "  café ☃\t",
    MULTILINE: "one\ntwo",
    TRAILING: "one\n\n",
  })) {
    await setProjectEnvValue({
      projectRoot,
      projectDir,
      envName: null,
      scope: "global",
      key,
      value,
      secret: false,
    });
    await setProjectEnvValue({
      projectRoot,
      projectDir,
      envName: null,
      scope: "global",
      key: `SECRET_${key}`,
      value,
      secret: true,
    });
    expectValue(await get(key), value);
    expectValue(await get(`SECRET_${key}`), value);
  }
  expectFailure(await get("ABSENT"));
});

test("get decrypts only the winning key and never materializes or creates keys", async () => {
  await layer("hack.env.default.yaml", {
    global: {
      VALUE: { secure: "synthetic-private-canary" },
      OTHER: { secure: "synthetic-private-canary" },
    },
  });
  await layer("hack.env.qa.yaml", {
    global: { VALUE: "winner", DELETED: null },
  });
  const before = await readdir(projectDir);
  expectValue(await get("VALUE"), "winner");
  expectFailure(await get("OTHER"));
  expectFailure(await get("DELETED"));
  expect(await readdir(projectDir)).toEqual(before);
  expect(await Bun.file(join(projectRoot, ".hack.secret.key")).exists()).toBe(
    false
  );
  expect(await Bun.file(join(projectDir, ".env")).exists()).toBe(false);
});

test("requested encrypted values ignore unrelated corrupt entries; empty ciphertext remains authenticated", async () => {
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "SECRET",
    value: "",
    secret: true,
  });
  await layer("hack.env.qa.yaml", {
    global: { OTHER: { secure: "synthetic-private-canary" } },
  });
  expectValue(await get("SECRET"), "");
  const path = join(projectDir, "hack.env.default.yaml");
  const original = await readFile(path, "utf8");
  // Appending an extra segment or tampering with the tag cannot authenticate.
  const encrypted = original.match(/secure: (\S+)/)?.[1];
  expect(encrypted).toBeDefined();
  if (!encrypted) {
    throw new Error("Missing synthetic ciphertext");
  }
  await writeFile(path, original.replace(encrypted, `${encrypted}:extra`));
  expectFailure(await get("SECRET"));
  const pieces = encrypted.split(":");
  pieces[2] = Buffer.alloc(16, 7).toString("base64");
  await writeFile(path, original.replace(encrypted, pieces.join(":")));
  expectFailure(await get("SECRET"));
});

test("deletion and missing modern keys cannot fall through to legacy or ambient plaintext", async () => {
  process.env.HACK_ENV_GET_AMBIENT = "synthetic-private-canary";
  await layer("hack.env.default.yaml", { global: { DELETED: "base" } });
  await layer("hack.env.qa.yaml", { global: { DELETED: null } });
  await writeFile(
    join(projectDir, ".env"),
    "DELETED=synthetic-private-canary\n"
  );
  expectFailure(await get("DELETED"));
  expectFailure(await get("HACK_ENV_GET_AMBIENT"));
});

test("corrupt YAML, corrupt ciphertext and wrong/missing keys fail without plaintext or raw errors", async () => {
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "SECRET",
    value: "synthetic-private-canary",
    secret: true,
  });
  await writeFile(
    join(projectRoot, ".hack.secret.key"),
    Buffer.alloc(32, 7).toString("base64")
  );
  expectFailure(await get("SECRET"));
  await rm(join(projectRoot, ".hack.secret.key"));
  expectFailure(await get("SECRET"));
  await layer("hack.env.default.yaml", {
    global: { SECRET: { secure: "synthetic-private-canary" } },
  });
  process.env.HACK_ENV_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  expectFailure(await get("SECRET"));
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    "values: [synthetic-private-canary\n"
  );
  expectFailure(await get("SECRET"));
});

test("get parser failures keep stdout empty even for --json and unknown flags", async () => {
  await layer("hack.env.default.yaml", {
    global: { VALUE: "synthetic-private-canary" },
  });
  for (const args of [
    ["env", "get"],
    ["env", "get", "VALUE", "synthetic-private-canary"],
    ["env", "get", "VALUE", "--json"],
    ["env", "get", "VALUE", "--show-secrets"],
    ["env", "get", "VALUE", "--synthetic-private-canary"],
    ["env", "get", "VALUE", "--env"],
    ["env", "get", "bad-key"],
    ["--path", projectRoot, "env", "get", "VALUE", "--json"],
  ]) {
    expectFailure(await capture(args));
  }
  const help = await capture(["env", "get", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout.toString()).toContain("without an added newline");
  expect(help.stdout.toString()).not.toContain("synthetic-private-canary");
});

async function contract(
  vars: readonly {
    key: string;
    source: "plain_env" | "keychain";
    services?: readonly string[];
  }[]
) {
  await writeFile(
    join(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: vars.map((v) => ({ required: false, ...v })),
    })
  );
}

test("legacy get reads only the requested backend key and preserves empty overlays without base fallback", async () => {
  await contract([
    { key: "SECRET", source: "keychain" },
    { key: "OTHER", source: "keychain" },
  ]);
  const calls: string[] = [];
  const spy = spyOn(secrets, "get").mockImplementation(async (opts) => {
    expect(opts.service).toBe("hack-env-get-fixture");
    calls.push(opts.name);
    if (opts.name === "env.qa.SECRET") {
      return "";
    }
    throw new Error("synthetic-private-canary");
  });
  try {
    expectValue(await get("SECRET"), "");
    expect(calls).toEqual(["env.qa.SECRET"]);
    calls.length = 0;
    expectFailure(await get("OTHER"));
    expect(calls).toEqual(["env.qa.OTHER"]);
    calls.length = 0;
    expectFailure(await get("UNDECLARED"));
    expect(calls).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("legacy plaintext get respects empty overrides and declared scope without opening keychain", async () => {
  await contract([
    { key: "VALUE", source: "plain_env" },
    { key: "SERVICE", source: "plain_env", services: ["api"] },
    { key: "OTHER", source: "keychain" },
    { key: "HACK_ENV_GET_AMBIENT", source: "plain_env" },
  ]);
  await writeFile(join(projectDir, ".env"), "VALUE=base\nSERVICE=service\n");
  await writeFile(join(projectDir, ".env.qa"), 'VALUE=""\n');
  process.env.HACK_ENV_GET_AMBIENT = "";
  const spy = spyOn(secrets, "get").mockImplementation(async () => {
    throw new Error("synthetic-private-canary");
  });
  try {
    expectValue(await get("VALUE"), "");
    expectValue(await get("VALUE", ["--env", "default"]), "base");
    expectFailure(await get("SERVICE"));
    expectValue(await get("SERVICE", ["--service", "api"]), "service");
    expectValue(await get("HACK_ENV_GET_AMBIENT"), "");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
  // The single-key empty-value contract does not change legacy runtime injection.
  await contract([{ key: "VALUE", source: "plain_env" }]);
  const resolved = await resolveHackEnv({
    projectDir,
    projectName: "env-get-fixture",
  });
  expect(resolved.envForCompose.VALUE).toBe("base");
});

test("legacy encrypted-file backend preserves requested-key overlay precedence and read-only storage", async () => {
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-env-get-backend-key";
  const storePath = join(root, "synthetic-store.enc.json");
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "env-get-fixture",
      env: { defaultOverlay: "qa" },
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          storePlaintextInBackend: true,
          encryptedFile: { path: storePath, keyPath: join(root, "unused.key") },
        },
      },
    })
  );
  await contract([
    { key: "VALUE", source: "plain_env" },
    { key: "SECRET", source: "keychain" },
  ]);
  await writeFile(
    join(projectDir, ".env"),
    "VALUE=base-file\nSECRET=must-not-use-plaintext\n"
  );
  await writeFile(
    join(projectDir, ".env.qa"),
    "VALUE=overlay-file\nSECRET=must-not-use-plaintext\n"
  );
  const store = await resolveSecretStore({
    projectDir,
    projectName: "env-get-fixture",
  });
  await store.set({ key: "VALUE", value: "base-store" });
  await store.set({ key: "env.qa.VALUE", value: "" });
  await store.set({ key: "SECRET", value: "base-secret\n" });
  const before = await readFile(storePath);
  expectValue(await get("VALUE"), "");
  expectValue(await get("VALUE", ["--env", "default"]), "base-store");
  expectValue(await get("SECRET"), "base-secret\n");
  expect(await readFile(storePath)).toEqual(before);
  await store.delete({ key: "env.qa.VALUE" });
  expectValue(await get("VALUE"), "overlay-file");
  await rm(join(projectDir, ".env.qa"));
  expectValue(await get("VALUE"), "base-store");
  await writeFile(storePath, '{"ciphertext":"synthetic-private-canary"}');
  expectFailure(await get("SECRET"));
  await writeFile(
    join(projectDir, "hack.env.json"),
    '{"synthetic-private-canary"'
  );
  expectFailure(await get("SECRET"));
});

test(
  "fresh legacy backend reads never bootstrap or copy native keys to files",
  async () => {
    await contract([{ key: "SECRET", source: "keychain" }]);
    const keyPath = join(root, "must-not-create.key");
    const storePath = join(root, "must-not-create.enc.json");
    const script = `
    import { secrets } from "bun";
    import { spyOn } from "bun:test";
    const { runCli } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/cli/run.ts"))});
    let reads = 0;
    let writes = 0;
    const getSpy = spyOn(secrets, "get").mockImplementation(async (opts) => {
      reads++;
      if (opts.service !== "hack-secrets-backend" || opts.name !== "encrypted-file-key") {
        throw new Error("synthetic-private-canary");
      }
      if (process.env.FIXTURE_KEY_MODE === "denied") throw new Error("synthetic-private-canary");
      return process.env.FIXTURE_KEY_MODE === "existing" ? "synthetic-private-canary" : null;
    });
    const setSpy = spyOn(secrets, "set").mockImplementation(async () => { writes++; throw new Error("synthetic-private-canary"); });
    try {
      process.exitCode = await runCli(["env", "get", "SECRET", "--path", process.env.FIXTURE_PROJECT]);
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
    process.stderr.write("native reads=" + reads + "; writes=" + writes + "\\n");
  `;
    for (const backend of ["encrypted_file", "cloud"]) {
      await writeFile(
        join(projectDir, "hack.config.json"),
        JSON.stringify({
          name: "env-get-fixture",
          controlPlane: {
            secrets: {
              backend,
              cloud: { provider: "aws" },
              encryptedFile: { path: storePath, keyPath },
            },
          },
        })
      );
      for (const mode of ["missing", "existing", "denied"]) {
        // Fresh process prevents another test's cached/env key from hiding provisioning.
        const child = Bun.spawn([process.execPath, "--eval", script], {
          cwd: resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH,
            HOME: root,
            HACK_GLOBAL_CONFIG_PATH: process.env.HACK_GLOBAL_CONFIG_PATH,
            FIXTURE_KEY_MODE: mode,
            FIXTURE_PROJECT: projectRoot,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).arrayBuffer(),
          new Response(child.stderr).text(),
        ]);
        expectFailure({
          code,
          stdout: Buffer.from(stdout),
          stderr: Buffer.from(stderr),
        });
        expect(stderr).toContain("native reads=1; writes=0");
        expect(await Bun.file(keyPath).exists()).toBe(false);
        expect(await Bun.file(storePath).exists()).toBe(false);
      }
    }
  },
  { timeout: 20_000 }
);

async function git(cwd: string, args: readonly string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" }
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(stderr);
  }
}

test("linked worktrees inherit primary local values and keys, then prefer checkout-local overrides", async () => {
  await layer("hack.env.default.yaml", { global: { VALUE: "tracked" } });
  await git(projectRoot, ["init", "-b", "main"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const linkedRoot = join(root, "linked");
  await git(projectRoot, ["worktree", "add", "-b", "linked", linkedRoot]);
  await layer("hack.env.local.yaml", { global: { VALUE: "primary-local" } });
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "SECRET",
    value: "inherited-synthetic",
    secret: true,
    local: true,
  });
  const linkedDir = join(linkedRoot, ".hack");
  expectValue(await get("VALUE", [], linkedRoot), "primary-local");
  expectValue(await get("SECRET", [], linkedRoot), "inherited-synthetic");
  await layer(
    "hack.env.qa.local.yaml",
    { global: { VALUE: "linked-local", SECRET: null } },
    linkedDir
  );
  expectValue(await get("VALUE", [], linkedRoot), "linked-local");
  expectFailure(await get("SECRET", [], linkedRoot));
  await rm(join(linkedDir, "hack.env.qa.local.yaml"));
  await writeFile(
    join(linkedRoot, ".hack.secret.key"),
    Buffer.alloc(32, 5).toString("base64")
  );
  expectFailure(await get("SECRET", [], linkedRoot));
  expect(
    await readFile(join(projectDir, "hack.env.local.yaml"), "utf8")
  ).toContain("secure");
  expect(await Bun.file(join(linkedDir, ".env")).exists()).toBe(false);
});
