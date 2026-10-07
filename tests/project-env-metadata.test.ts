import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import {
  type ProjectEnvResolvedConfig,
  type ProjectEnvValuesByScope,
  resolveProjectEnvConfig,
  resolveProjectEnvMetadata,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const roots: string[] = [];
const originalEnv = {
  CI: process.env.CI,
  HACK_EXECUTION_MODE: process.env.HACK_EXECUTION_MODE,
  HACK_ENV_SECRET_KEY: process.env.HACK_ENV_SECRET_KEY,
};
const plainSentinel = "synthetic-plaintext-must-not-leave-metadata";
const cipherSentinel = "v1:synthetic-ciphertext-not-valid-for-decryption";
const secure = { secure: cipherSentinel };

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    restoreEnv(key, value);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-env-metadata-"))
  );
  roots.push(root);
  const projectRoot = join(root, "primary");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "metadata-fixture", env: { defaultOverlay: "qa" } })
  );
  return { root, projectRoot, projectDir, serviceNames: ["api", "web"] };
}

async function writeLayer(
  projectDir: string,
  file: string,
  values: ProjectEnvValuesByScope
) {
  await writeFile(
    join(projectDir, file),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values,
    })
  );
}

function metadataFromRuntime(resolved: ProjectEnvResolvedConfig | null) {
  if (!resolved) {
    throw new Error("Expected modern runtime env config");
  }
  const {
    selection,
    files,
    effectiveMetadata,
    hostEffectiveMetadata,
    declaredScopes,
    unknownScopes,
  } = resolved;
  return {
    selection,
    files,
    effectiveMetadata,
    hostEffectiveMetadata,
    declaredScopes,
    unknownScopes,
  };
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) {
    throw new Error(error);
  }
}

test("metadata keeps absent modern config distinct from legacy env fallback", async () => {
  const f = await fixture();
  await writeFile(
    join(f.projectDir, ".env"),
    `LEGACY_VALUE=${plainSentinel}\n`
  );
  expect(await resolveProjectEnvMetadata(f)).toBeNull();
  expect(await resolveProjectEnvConfig(f)).toBeNull();
  expect((await readdir(f.projectDir)).sort()).toEqual([
    ".env",
    "hack.config.json",
  ]);
});

test("metadata selection matches default, explicit and null overlays without exposing stored values", async () => {
  const f = await fixture();
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { BASE: plainSentinel, WINNER: secure },
  });
  await writeLayer(f.projectDir, "hack.env.qa.yaml", {
    global: { WINNER: plainSentinel, QA: secure },
  });
  await writeLayer(f.projectDir, "hack.env.preview.yaml", {
    api: { PREVIEW: secure },
  });
  for (const [envName, effectiveEnv, expected] of [
    [
      undefined,
      "qa",
      {
        BASE: { scope: "global", secret: false },
        WINNER: { scope: "global", secret: false },
        QA: { scope: "global", secret: true },
      },
    ],
    [
      "preview",
      "preview",
      {
        BASE: { scope: "global", secret: false },
        WINNER: { scope: "global", secret: true },
      },
    ],
    [
      null,
      null,
      {
        BASE: { scope: "global", secret: false },
        WINNER: { scope: "global", secret: true },
      },
    ],
    [
      "missing",
      "missing",
      {
        BASE: { scope: "global", secret: false },
        WINNER: { scope: "global", secret: true },
      },
    ],
  ] as const) {
    const result = await resolveProjectEnvMetadata({ ...f, envName });
    expect(result?.selection.effectiveEnv).toBe(effectiveEnv);
    expect(result?.selection.defaultEnv).toBe("qa");
    expect(result?.effectiveMetadata.global).toEqual(expected);
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "declaredScopes",
      "effectiveMetadata",
      "files",
      "hostEffectiveMetadata",
      "selection",
      "unknownScopes",
    ]);
    expect(JSON.stringify(result)).not.toContain(plainSentinel);
    expect(JSON.stringify(result)).not.toContain(cipherSentinel);
  }
  expect(
    await Bun.file(join(f.projectRoot, PROJECT_ENV_KEY_FILENAME)).exists()
  ).toBe(false);
  // Positive control: the ordinary resolver still requires a key for these entries.
  await expect(resolveProjectEnvConfig(f)).rejects.toThrow(
    "Missing project env key"
  );
});

test("metadata does not read project keys, decrypt invalid ciphertext or materialize env files", async () => {
  const f = await fixture();
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { ENCRYPTED: secure },
    api: { PLAIN: plainSentinel },
  });
  // A key lookup would try to read this directory as a file and fail.
  await mkdir(join(f.projectRoot, PROJECT_ENV_KEY_FILENAME));
  process.env.HACK_ENV_SECRET_KEY =
    "synthetic-invalid-key-must-not-be-consumed";
  const before = await readdir(f.projectDir);
  const result = await resolveProjectEnvMetadata({ ...f, envName: null });
  expect(result?.effectiveMetadata.api).toEqual({
    ENCRYPTED: { scope: "global", secret: true },
    PLAIN: { scope: "api", secret: false },
  });
  expect(JSON.stringify(result)).not.toContain(plainSentinel);
  expect(JSON.stringify(result)).not.toContain(cipherSentinel);
  expect(JSON.stringify(result)).not.toContain(process.env.HACK_ENV_SECRET_KEY);
  expect(await readdir(f.projectDir)).toEqual(before);
  expect(await readdir(join(f.projectRoot, PROJECT_ENV_KEY_FILENAME))).toEqual(
    []
  );
  await expect(
    resolveProjectEnvConfig({ ...f, envName: null })
  ).rejects.toThrow();
});

test("one shared target projection preserves host collision and unknown-scope semantics", async () => {
  const f = await fixture();
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { SHARED: "base", BASE: false },
    api: { SHARED: "api", API_ONLY: 3 },
    host: { SHARED: "host", HOST_ONLY: "local" },
    extra: { UNKNOWN: "kept" },
  });
  await writeLayer(f.projectDir, "hack.env.qa.yaml", {
    global: { SHARED: "overlay", OVERLAY: "later" },
    host: { BASE: null },
  });
  for (const serviceNames of [
    ["api", "web"],
    ["api", "host"],
    ["api", "global", "api"],
  ]) {
    const opts = { ...f, serviceNames };
    const metadata = await resolveProjectEnvMetadata(opts);
    const runtime = await resolveProjectEnvConfig(opts);
    expect(metadata).toEqual(metadataFromRuntime(runtime));
    expect(metadata?.unknownScopes).toEqual(["extra"]);
    expect(metadata?.declaredScopes).toEqual([
      "api",
      "extra",
      "global",
      "host",
    ]);
    expect(metadata?.effectiveMetadata.api?.SHARED).toEqual({
      scope: "global",
      secret: false,
    });
    expect(runtime?.serviceEnv.api?.SHARED).toBe("overlay");
    const collision = serviceNames.includes("host");
    expect(metadata?.hostEffectiveMetadata.api?.HOST_ONLY).toEqual(
      collision ? undefined : { scope: "host", secret: false }
    );
    expect(metadata?.hostEffectiveMetadata.api?.BASE).toEqual(
      collision ? { scope: "global", secret: false } : undefined
    );
    expect(runtime?.hostEnv).toEqual(
      collision ? {} : { SHARED: "host", HOST_ONLY: "local" }
    );
    expect(runtime?.hostTargetEnv.api?.SHARED).toBe("overlay");
  }
});

test("metadata follows layer-first unset and reintroduction across global/service/host scopes", async () => {
  const f = await fixture();
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { REINTRODUCE: secure, DELETE: secure },
    api: { LAYER_WINS: secure, DELETE: plainSentinel },
    host: { LAYER_WINS: secure },
  });
  await writeLayer(f.projectDir, "hack.env.qa.yaml", {
    global: { LAYER_WINS: plainSentinel, REINTRODUCE: null, DELETE: null },
  });
  await writeLayer(f.projectDir, "hack.env.local.yaml", {
    api: { REINTRODUCE: plainSentinel },
    host: { LAYER_WINS: null },
  });
  await writeLayer(f.projectDir, "hack.env.qa.local.yaml", {
    global: { LAYER_WINS: secure },
    host: { REINTRODUCE: secure },
  });
  const result = await resolveProjectEnvMetadata(f);
  expect(result?.effectiveMetadata.api).toEqual({
    REINTRODUCE: { scope: "api", secret: false },
    LAYER_WINS: { scope: "global", secret: true },
  });
  expect(result?.hostEffectiveMetadata.api).toEqual({
    REINTRODUCE: { scope: "host", secret: true },
    LAYER_WINS: { scope: "global", secret: true },
  });
  expect(result?.effectiveMetadata.global).toEqual({
    LAYER_WINS: { scope: "global", secret: true },
  });
  expect(JSON.stringify(result)).not.toContain(plainSentinel);
  expect(JSON.stringify(result)).not.toContain(cipherSentinel);
});

test("worktree metadata observes primary/local precedence and changes without copying keys or state", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  const f = await fixture();
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { TRACKED: plainSentinel, ORDER: plainSentinel },
  });
  await writeLayer(f.projectDir, "hack.env.qa.yaml", {
    api: { ORDER: secure },
  });
  await writeFile(
    join(f.projectDir, ".gitignore"),
    "hack.env.local.yaml\nhack.env.*.local.yaml\n"
  );
  await git(f.projectRoot, ["init", "-b", "main"]);
  await git(f.projectRoot, ["add", "."]);
  await git(f.projectRoot, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const projectRoot = join(f.root, "linked");
  await git(f.projectRoot, ["worktree", "add", "-b", "metadata", projectRoot]);
  const projectDir = join(projectRoot, ".hack");
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { DO_NOT_INHERIT: secure },
  });
  await writeLayer(f.projectDir, "hack.env.local.yaml", {
    global: { ORDER: secure, PRIMARY: secure },
  });
  await writeLayer(f.projectDir, "hack.env.qa.local.yaml", {
    api: { ORDER: plainSentinel },
    global: { PRIMARY: null },
  });
  const opts = { projectRoot, projectDir, serviceNames: f.serviceNames };
  expect(
    (await resolveProjectEnvMetadata(opts))?.effectiveMetadata.api
  ).toEqual({
    TRACKED: { scope: "global", secret: false },
    ORDER: { scope: "api", secret: false },
  });
  expect(await Bun.file(join(projectDir, "hack.env.local.yaml")).exists()).toBe(
    false
  );
  await writeLayer(projectDir, "hack.env.local.yaml", {
    global: { ORDER: plainSentinel, LOCAL: secure },
  });
  await writeLayer(projectDir, "hack.env.qa.local.yaml", {
    api: { ORDER: secure },
    host: { LOCAL: null },
  });
  const primaryBytes = await readFile(
    join(f.projectDir, "hack.env.qa.local.yaml")
  );
  const result = await resolveProjectEnvMetadata(opts);
  expect(result?.files).toEqual(
    ["hack.env.default.yaml", "hack.env.qa.yaml"]
      .map((file) => join(projectDir, file))
      .concat(
        ["hack.env.local.yaml", "hack.env.qa.local.yaml"].map((file) =>
          join(f.projectDir, file)
        ),
        ["hack.env.local.yaml", "hack.env.qa.local.yaml"].map((file) =>
          join(projectDir, file)
        )
      )
  );
  expect(result?.effectiveMetadata.api?.ORDER).toEqual({
    scope: "api",
    secret: true,
  });
  expect(result?.effectiveMetadata.api?.LOCAL).toEqual({
    scope: "global",
    secret: true,
  });
  expect(result?.hostEffectiveMetadata.api?.LOCAL).toBeUndefined();
  expect(await readFile(join(f.projectDir, "hack.env.qa.local.yaml"))).toEqual(
    primaryBytes
  );
  expect(
    await Bun.file(join(projectRoot, PROJECT_ENV_KEY_FILENAME)).exists()
  ).toBe(false);
  await writeLayer(f.projectDir, "hack.env.local.yaml", {
    global: { UPDATED: secure },
  });
  expect(
    (await resolveProjectEnvMetadata(opts))?.effectiveMetadata.api?.UPDATED
  ).toEqual({ scope: "global", secret: true });
});

test("metadata errors omit stored values and parser excerpts without changing legacy error behavior", async () => {
  const f = await fixture();
  await writeFile(
    join(f.projectDir, "hack.env.default.yaml"),
    `values: [${plainSentinel}\n`
  );
  let failure: unknown;
  try {
    await resolveProjectEnvMetadata(f);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toBe(
    "Error: Cannot resolve project env metadata: selected configuration is invalid or unreadable."
  );
  expect(String(failure)).not.toContain(plainSentinel);
  expect(failure).not.toHaveProperty("cause");
  await expect(resolveProjectEnvConfig(f)).rejects.toThrow("Failed to parse");
});

test("metadata refuses unreadable selected layers instead of silently omitting them", async () => {
  const f = await fixture();
  const message =
    "Cannot resolve project env metadata: selected configuration is invalid or unreadable.";
  for (const file of [
    "hack.env.default.yaml",
    "hack.env.qa.yaml",
    "hack.env.local.yaml",
    "hack.env.qa.local.yaml",
  ]) {
    const path = join(f.projectDir, file);
    await mkdir(path);
    await expect(resolveProjectEnvMetadata(f)).rejects.toThrow(message);
    // Existing runtime lookup behavior remains unchanged by strict planning reads.
    expect(await resolveProjectEnvConfig(f)).toBeNull();
    await rm(path, { recursive: true });
  }
  await writeLayer(f.projectDir, "hack.env.default.yaml", {
    global: { BASE: plainSentinel },
  });
  await mkdir(join(f.projectDir, "hack.env.qa.yaml"));
  await expect(resolveProjectEnvMetadata(f)).rejects.toThrow(message);
  expect((await resolveProjectEnvConfig(f))?.globalEnv).toEqual({
    BASE: plainSentinel,
  });
  expect(
    (await resolveProjectEnvMetadata({ ...f, envName: null }))
      ?.effectiveMetadata.global
  ).toEqual({ BASE: { scope: "global", secret: false } });
});

test("metadata rejects a dangling selected layer and retains readable symlink behavior", async () => {
  const f = await fixture();
  const overlay = join(f.projectDir, "hack.env.qa.yaml");
  await symlink(join(f.projectDir, "missing.yaml"), overlay);
  await expect(resolveProjectEnvMetadata(f)).rejects.toThrow(
    "Cannot resolve project env metadata: selected configuration is invalid or unreadable."
  );
  expect(await resolveProjectEnvConfig(f)).toBeNull();
  await writeLayer(f.projectDir, "missing.yaml", {
    global: { PRESENT: plainSentinel },
  });
  const metadata = await resolveProjectEnvMetadata(f);
  expect(metadata?.effectiveMetadata.global).toEqual({
    PRESENT: { scope: "global", secret: false },
  });
  expect(metadata).toEqual(
    metadataFromRuntime(await resolveProjectEnvConfig(f))
  );
  expect(JSON.stringify(metadata)).not.toContain(plainSentinel);
});
