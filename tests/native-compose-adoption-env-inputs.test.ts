import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { LegacyAdoptionManagedEnvAdmission } from "../src/lib/native-compose-adoption-env-inputs.ts";
import { NativeConfigCompilerError } from "../src/lib/native-config-compiler.ts";
import { acquireNativeConfigImportInputs } from "../src/lib/native-config-import-inputs.ts";
import {
  acquireProjectEnvForLegacyAdoption,
  acquireProjectEnvForNativeExecution,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-adoption-env-value-never-public";
const KEY = "synthetic-adoption-key-not-real-credentials";
const KEYS = ["CI", "HACK_EXECUTION_MODE", "HACK_ENV_SECRET_KEY"] as const;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "adoption-env-")));
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack/hack.config.json"),
    JSON.stringify({ name: "fixture", env: { default_overlay: "qa" } })
  );
  await writeFile(
    join(root, ".hack/docker-compose.yml"),
    JSON.stringify({
      name: "fixture",
      services: {
        web: { image: "alpine:3.22", volumes: ["data:/data"] },
        inactive: { image: "alpine:3.22", profiles: ["inactive"] },
      },
      volumes: { data: {} },
    })
  );
});
afterEach(async () => {
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { recursive: true, force: true });
});
async function layer(
  filename: string,
  values: unknown,
  environment = "default",
  projectRoot = root
) {
  await writeFile(
    join(projectRoot, ".hack", filename),
    JSON.stringify({
      version: 1,
      environment,
      secretsprovider: "project_key",
      values,
    })
  );
}
async function admission(projectRoot = root) {
  return await LegacyAdoptionManagedEnvAdmission.acquire({
    source: await acquireNativeConfigImportInputs({
      projectRoot,
      allowLinkedWorktree: true,
    }),
  });
}
async function refuses(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error("Expected private input refusal");
  }
  expect(error.message).toContain("values omitted");
  expect(error.message).not.toContain(CANARY);
  expect(error.message).not.toContain(root);
  expect(error.cause).toBeUndefined();
}

test("strict legacy admission resolves declared managed scopes without installing native markers", async () => {
  await layer("hack.env.default.yaml", {
    global: { WIN: "base", EMPTY: "", REMOVE: "base" },
    web: { WEB: "base-web" },
    inactive: { INACTIVE: "unchanged" },
  });
  await layer(
    "hack.env.qa.yaml",
    { global: { WIN: CANARY, REMOVE: null } },
    "qa"
  );
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  expect(source.selection.overlay).toBe("qa");
  expect(source.selection.declaredWorkloadNames).toEqual(["inactive", "web"]);
  expect(JSON.stringify(source)).toBe("{}");
  expect(Object.isFrozen(source)).toBe(true);
  expect(JSON.stringify(owned)).not.toContain(CANARY);
  expect(JSON.stringify(owned)).not.toContain("assertFresh");
  const resolved = await owned.resolveValues();
  expect(resolved.globalEnv).toEqual({ WIN: CANARY, EMPTY: "" });
  expect(resolved.workloadEnv.web).toEqual({
    WIN: CANARY,
    EMPTY: "",
    WEB: "base-web",
  });
  expect(resolved.workloadEnv.inactive).toEqual({
    WIN: CANARY,
    EMPTY: "",
    INACTIVE: "unchanged",
  });
  expect(await Bun.file(join(root, ".hack/hack.project.json")).exists()).toBe(
    false
  );
});

async function git(projectRoot: string, args: readonly string[]) {
  const child = Bun.spawn(["git", "-C", projectRoot, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  expect(await child.exited).toBe(0);
}
async function linked() {
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, [
    "add",
    ".hack/hack.config.json",
    ".hack/docker-compose.yml",
  ]);
  await git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const checkout = join(root, "linked");
  await git(root, ["worktree", "add", "--quiet", "-b", "fixture", checkout]);
  return checkout;
}
async function secret() {
  await writeFile(join(root, PROJECT_ENV_KEY_FILENAME), KEY);
  await setProjectEnvValue({
    projectRoot: root,
    projectDir: join(root, ".hack"),
    envName: null,
    scope: "global",
    key: "PRIVATE",
    value: CANARY,
    secret: true,
  });
}

test("legacy linked admission shares all six managed layers and rejects inherited byte drift", async () => {
  const checkout = await linked();
  await layer(
    "hack.env.default.yaml",
    { global: { BASE: "base", WIN: "base", REMOVE: "base" } },
    "default",
    checkout
  );
  await layer(
    "hack.env.qa.yaml",
    { global: { OVERLAY: "overlay", WIN: "overlay" } },
    "qa",
    checkout
  );
  await layer("hack.env.local.yaml", {
    global: { PRIMARY: "primary", WIN: "primary", REMOVE: null },
  });
  await layer(
    "hack.env.qa.local.yaml",
    { global: { PRIMARY_OVERLAY: "primary-overlay", WIN: "primary-overlay" } },
    "qa"
  );
  await layer(
    "hack.env.local.yaml",
    { global: { CURRENT: "current", WIN: "current" } },
    "default",
    checkout
  );
  await layer(
    "hack.env.qa.local.yaml",
    { global: { WIN: CANARY, EMPTY: "" } },
    "qa",
    checkout
  );
  const source = await admission(checkout);
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  expect((await owned.resolveValues()).globalEnv).toEqual({
    BASE: "base",
    OVERLAY: "overlay",
    PRIMARY: "primary",
    PRIMARY_OVERLAY: "primary-overlay",
    CURRENT: "current",
    WIN: CANARY,
    EMPTY: "",
  });
  const path = join(root, ".hack/hack.env.qa.local.yaml");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await refuses(() => owned.assertFresh(source.selection));
}, 15_000);

test.each([
  "optout",
  "ci",
  "codex",
])("legacy managed acquisition honors the existing %s primary exclusion", async (kind) => {
  const checkout = await linked();
  await layer("hack.env.local.yaml", {
    global: { PRIMARY: { secure: "invalid-unused" } },
  });
  await layer(
    "hack.env.local.yaml",
    { global: { CURRENT: "current" } },
    "default",
    checkout
  );
  if (kind === "optout") {
    await writeFile(
      join(checkout, ".hack/hack.config.json"),
      JSON.stringify({ name: "fixture", worktree: { inherit_local: false } })
    );
  } else if (kind === "ci") {
    process.env.CI = "true";
  } else {
    process.env.HACK_EXECUTION_MODE = "codex";
  }
  const source = await admission(checkout);
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  expect((await owned.resolveValues()).globalEnv).toEqual({
    CURRENT: "current",
  });
});

test("legacy metadata is key-free and missing or wrong keys never create or disclose a key", async () => {
  await secret();
  const keyPath = join(root, PROJECT_ENV_KEY_FILENAME);
  await rm(keyPath);
  await mkdir(keyPath);
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  expect(JSON.stringify(owned.metadata)).toContain("PRIVATE");
  expect(JSON.stringify(owned.metadata)).not.toContain(CANARY);
  await refuses(() => owned.resolveValues());
  expect((await fs.lstat(keyPath)).isDirectory()).toBe(true);
  await rm(keyPath, { recursive: true });
  await refuses(() => owned.resolveValues());
  expect(await Bun.file(keyPath).exists()).toBe(false);
  await writeFile(keyPath, "wrong-synthetic-key");
  await refuses(() => owned.resolveValues());
  expect(await readFile(keyPath, "utf8")).toBe("wrong-synthetic-key");
  await writeFile(keyPath, KEY);
  expect((await owned.resolveValues()).globalEnv.PRIVATE).toBe(CANARY);
});

test("legacy value delivery rechecks raw layers after key acquisition latency", async () => {
  await secret();
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  const originalOpen = fs.open;
  const layerPath = join(root, ".hack/hack.env.default.yaml");
  let changed = false;
  const opened = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === join(root, PROJECT_ENV_KEY_FILENAME) && !changed) {
        changed = true;
        await writeFile(layerPath, `${await readFile(layerPath, "utf8")}\n`);
      }
      return handle;
    }
  );
  try {
    await refuses(() => owned.resolveValues());
    expect(changed).toBe(true);
  } finally {
    opened.mockRestore();
  }
});

test.each([
  "added",
  "removed",
  "whitespace",
  "ciphertext",
])("legacy freshness refuses %s raw-layer drift without reading values", async (kind) => {
  if (kind !== "added") {
    await layer(
      "hack.env.qa.local.yaml",
      { global: { PRIVATE: { secure: "synthetic-cipher-A" } } },
      "qa"
    );
  }
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  const path = join(root, ".hack/hack.env.qa.local.yaml");
  if (kind === "removed") {
    await rm(path);
  } else if (kind === "whitespace") {
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
  } else {
    await layer(
      "hack.env.qa.local.yaml",
      { global: { PRIVATE: { secure: "synthetic-cipher-B" } } },
      "qa"
    );
  }
  await refuses(() => owned.assertFresh(source.selection));
  expect(JSON.stringify(owned)).not.toContain("synthetic-cipher");
});

test("legacy admission refuses a replaced worktree pointer and propagates cancellation", async () => {
  const checkout = await linked();
  const source = await admission(checkout);
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  await writeFile(join(checkout, ".git"), `gitdir: /unrelated/${CANARY}\n`);
  await refuses(() => owned.assertFresh(source.selection));
  const signal = AbortSignal.abort();
  await expect(
    acquireNativeConfigImportInputs({ projectRoot: root, signal })
  ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
});

test("native acquisition keeps refusing the same legacy root", async () => {
  const source = await admission();
  await refuses(() => acquireProjectEnvForNativeExecution(source.selection));
});

test("copied raw-source claims do not authorize managed reads", async () => {
  const source = await acquireNativeConfigImportInputs({ projectRoot: root });
  await refuses(() =>
    LegacyAdoptionManagedEnvAdmission.acquire({ source: { ...source } })
  );
});

test("authored byte drift and runner-mode drift invalidate the captured admission", async () => {
  const source = await admission();
  const path = join(root, ".hack/hack.config.json");
  const original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
  await refuses(() => source.assertRoot(source.selection));
  await writeFile(path, original);
  const current = await admission();
  process.env.CI = "true";
  await refuses(() => current.assertRoot(current.selection));
});

test.each([
  ".hack/hack.config.toml",
  ".dev/hack.config.json",
  ".dev/docker-compose.yml",
  ".hack/.internal/extra-hosts.json",
  ".hack/hack.env.qa.yml",
  ".hack/hack.env.yaml",
])("managed admission refuses alternate input %s without reading its values", async (relative) => {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, CANARY);
  await refuses(() => admission());
  expect(await readFile(path, "utf8")).toBe(CANARY);
});

test("a newly added unsupported alias invalidates existing managed admission", async () => {
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  await mkdir(join(root, ".hack/.internal"));
  await writeFile(join(root, ".hack/.internal/extra-hosts.json"), CANARY);
  await refuses(() => owned.assertFresh(source.selection));
});

test.each([
  [
    "root duplicate",
    "version: 1\nversion: 1\nsecretsprovider: project_key\nvalues: {}\n",
  ],
  [
    "value duplicate",
    "version: 1\nsecretsprovider: project_key\nvalues: {global: {KEY: first, KEY: second}}\n",
  ],
  [
    "tag directive",
    "%TAG !! tag:yaml.org,2002:\n---\nversion: 1\nsecretsprovider: project_key\nvalues: {}\n",
  ],
  [
    "unknown root field",
    '{"version":1,"secretsprovider":"project_key","values":{},"ignored":"canary"}',
  ],
  [
    "unknown secure field",
    '{"version":1,"secretsprovider":"project_key","values":{"global":{"KEY":{"secure":"ciphertext","ignored":"canary"}}}}',
  ],
  [
    "unknown scope",
    '{"version":1,"secretsprovider":"project_key","values":{"unmapped":{"KEY":"canary"}}}',
  ],
])("selected managed %s refuses strict unsupported syntax or fields", async (_kind, text) => {
  await writeFile(
    join(root, ".hack/hack.env.default.yaml"),
    text.replaceAll("canary", CANARY)
  );
  const source = await admission();
  await refuses(() =>
    acquireProjectEnvForLegacyAdoption({ admission: source })
  );
});

test("caller edits cannot change captured selection or metadata", async () => {
  await layer("hack.env.default.yaml", { global: { PUBLIC_NAME: CANARY } });
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  expect(Reflect.set(source.selection, "overlay", "unselected")).toBe(false);
  expect(Object.isFrozen(source.selection.declaredWorkloadNames)).toBe(true);
  expect(Object.isFrozen(owned.metadata)).toBe(true);
  await refuses(() =>
    owned.assertFresh({ ...source.selection, overlay: "unselected" })
  );
  await refuses(() =>
    owned.assertFresh({ ...source.selection, declaredWorkloadNames: ["web"] })
  );
  expect((await owned.resolveValues()).globalEnv.PUBLIC_NAME).toBe(CANARY);
});

test("malformed admission arguments refuse without exposing their values", async () => {
  await refuses(() => LegacyAdoptionManagedEnvAdmission.acquire(null as never));
  await refuses(() =>
    acquireProjectEnvForLegacyAdoption({
      admission: Object.create(LegacyAdoptionManagedEnvAdmission.prototype),
    })
  );
});

test("runtime construction cannot forge factory-issued managed admission", async () => {
  const opened = spyOn(fs, "open");
  try {
    const context = {
      source: { projectRoot: root, assertFresh: async () => {} },
      primary: null,
      selection: {
        projectRoot: root,
        overlay: null,
        inheritLocal: false,
        declaredWorkloadNames: ["web"],
      },
      ci: process.env.CI,
      mode: process.env.HACK_EXECUTION_MODE,
    };
    for (const token of [
      undefined,
      Symbol("legacy-adoption-managed-admission"),
    ]) {
      await refuses(async () =>
        Reflect.construct(LegacyAdoptionManagedEnvAdmission, [context, token])
      );
    }
    expect(opened.mock.calls).toHaveLength(0);
  } finally {
    opened.mockRestore();
  }
});

test("replacement invocation signals cannot reactivate an aborted managed generation", async () => {
  const controller = new AbortController();
  const source = await LegacyAdoptionManagedEnvAdmission.acquire({
    source: await acquireNativeConfigImportInputs({ projectRoot: root }),
    signal: controller.signal,
  });
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  controller.abort(CANARY);
  const signal = new AbortController().signal;
  await expect(owned.resolveValues({ signal })).rejects.toMatchObject({
    code: "E_COMPILER_CANCELLED",
  });
  await refuses(() => owned.resolveValues({ signal }));
  await refuses(() => owned.assertFresh({ ...source.selection, signal }));
});

test("throwing or malformed private invocation options retain fixed refusal diagnostics", async () => {
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  await refuses(() => owned.resolveValues(null as never));
  await refuses(() =>
    owned.resolveValues({
      get signal(): AbortSignal {
        throw new Error(CANARY);
      },
    })
  );
  await refuses(() =>
    owned.resolveValues({
      get signal(): AbortSignal {
        throw new NativeConfigCompilerError("E_COMPILER_CANCELLED", CANARY);
      },
    })
  );
});

test("supported unselected overlay is not parsed or decrypted", async () => {
  await writeFile(join(root, ".hack/hack.env.unselected.yaml"), CANARY);
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  expect((await owned.resolveValues()).globalEnv).toEqual({});
});

test("forged cancellation errors are reconstructed with fixed private diagnostics", async () => {
  const source = await admission();
  const owned = await acquireProjectEnvForLegacyAdoption({ admission: source });
  const guarded = spyOn(
    LegacyAdoptionManagedEnvAdmission.prototype,
    "assertRoot"
  ).mockRejectedValue(
    new NativeConfigCompilerError("E_COMPILER_CANCELLED", CANARY)
  );
  try {
    await refuses(() => owned.assertFresh(source.selection));
    await refuses(() => owned.resolveValues());
    await refuses(() =>
      acquireProjectEnvForLegacyAdoption({ admission: source })
    );
  } finally {
    guarded.mockRestore();
  }
});
