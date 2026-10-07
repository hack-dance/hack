import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  acquireProjectEnvForNativeExecution,
  type NativeProjectEnvSelectionOptions,
  type ProjectEnvStoredValue,
  type ProjectEnvValuesByScope,
  resolveProjectEnvConfigForNativeSelection,
  resolveProjectEnvMetadataForNativeSelection,
  selectProjectEnvValuesForNativeExecutionTarget,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const SENTINEL = "private-synthetic-value-must-not-escape";
const KEY = "synthetic-key-never-real-credentials";
const ENV_KEYS = [
  "PATH",
  "CI",
  "HACK_EXECUTION_MODE",
  "HACK_ENV_SECRET_KEY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (key !== "PATH") {
      Reflect.deleteProperty(process.env, key);
    }
  }
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "native-env-values-"))
  );
});

afterEach(async () => {
  mock.restore();
  for (const key of ENV_KEYS) {
    restoreEnv(key, saved[key]);
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function project(name = "primary") {
  const projectRoot = join(root, name);
  await fs.mkdir(join(projectRoot, ".hack"), { recursive: true });
  // The compiler supplies the validated selection; this owner must not parse policy.
  await fs.writeFile(
    join(projectRoot, ".hack/hack.project.json"),
    `invalid ${SENTINEL}`
  );
  return projectRoot;
}

async function layer(
  projectRoot: string,
  filename: string,
  values: ProjectEnvValuesByScope,
  environment = "default"
) {
  await fs.writeFile(
    join(projectRoot, ".hack", filename),
    JSON.stringify({
      version: 1,
      environment,
      secretsprovider: "project_key",
      values,
    })
  );
}

function selection(
  projectRoot: string,
  opts: Partial<NativeProjectEnvSelectionOptions> = {}
): NativeProjectEnvSelectionOptions {
  return {
    projectRoot,
    overlay: null,
    inheritLocal: true,
    declaredWorkloadNames: ["web", "job", "inactive"],
    ...opts,
  };
}

function values(
  projectRoot: string,
  opts: Partial<NativeProjectEnvSelectionOptions> = {}
) {
  return resolveProjectEnvConfigForNativeSelection(
    selection(projectRoot, opts)
  );
}

async function git(projectRoot: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", projectRoot, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
}

async function linked() {
  const primary = await project();
  await git(primary, ["init", "--quiet", "-b", "main"]);
  await git(primary, ["add", ".hack/hack.project.json"]);
  await git(primary, [
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
  await git(primary, ["worktree", "add", "--quiet", "-b", "fixture", checkout]);
  return { primary, checkout };
}

/** Generate synthetic ciphertext using the existing mutation owner, outside the native fixture. */
async function encrypted(plaintext = SENTINEL): Promise<ProjectEnvStoredValue> {
  const fixture = join(root, "cipher-fixture");
  await fs.mkdir(join(fixture, ".hack"), { recursive: true });
  await fs.writeFile(join(fixture, PROJECT_ENV_KEY_FILENAME), KEY);
  await setProjectEnvValue({
    projectRoot: fixture,
    projectDir: join(fixture, ".hack"),
    envName: null,
    scope: "global",
    key: "FIXTURE",
    value: plaintext,
    secret: true,
  });
  const config: unknown = YAML.parse(
    await fs.readFile(join(fixture, ".hack/hack.env.default.yaml"), "utf8")
  );
  if (
    !(
      isRecord(config) &&
      isRecord(config.values) &&
      isRecord(config.values.global)
    )
  ) {
    throw new Error("Invalid synthetic ciphertext fixture");
  }
  const entry = config.values.global.FIXTURE;
  if (!isRecord(entry) || typeof entry.secure !== "string") {
    throw new Error("Synthetic ciphertext absent");
  }
  return { secure: entry.secure };
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
    throw new Error("Expected native value refusal");
  }
  expect(error.message).toContain("values omitted");
  for (const privateText of [SENTINEL, KEY, root]) {
    expect(error.message).not.toContain(privateText);
  }
  expect(error.cause).toBeUndefined();
}

test("explicit base and missing overlay values ignore dotenv, native policy and keys when no secrets win", async () => {
  const p = await project();
  await fs.writeFile(join(p, ".hack/.env"), `POISON=${SENTINEL}`);
  await fs.writeFile(join(p, ".env"), `POISON=${SENTINEL}`);
  await fs.writeFile(join(p, ".hack/hack.local.json"), `invalid ${SENTINEL}`);
  await fs.mkdir(join(p, PROJECT_ENV_KEY_FILENAME));
  const before = await fs.readdir(p);
  const result = await values(p, {
    overlay: "qa",
    hostTargets: { includeDefault: true, workloadNames: ["web"] },
  });
  expect(result).toEqual({
    overlay: "qa",
    overlayExists: false,
    effectiveMetadata: {},
    unknownScopes: [],
    hostMetadata: { default: {}, workloads: { web: {} } },
    globalEnv: {},
    workloadEnv: { web: {}, job: {}, inactive: {} },
    hostValues: { default: {}, workloads: { web: {} } },
  });
  expect(await fs.readdir(p)).toEqual(before);
  await layer(p, "hack.env.default.yaml", { global: { BASE: "base" } });
  await layer(p, "hack.env.qa.yaml", { global: { BASE: "overlay" } }, "qa");
  expect((await values(p)).globalEnv).toEqual({ BASE: "base" });
  expect((await values(p, { overlay: "qa" })).globalEnv).toEqual({
    BASE: "overlay",
  });
});

test("guest and requested host values match metadata layer specificity, tombstones and presence", async () => {
  const p = await project();
  const secret = await encrypted();
  await fs.writeFile(join(p, PROJECT_ENV_KEY_FILENAME), KEY);
  await layer(p, "hack.env.default.yaml", {
    global: {
      WIN: "base-global",
      DELETE: secret,
      EMPTY: "",
      NUMBER: 7,
      FLAG: false,
    },
    web: { WIN: "base-web", WEB: secret },
    job: { JOB: "job" },
    inactive: { INACTIVE: "inactive" },
    host: { WIN: "base-host", HOST: secret },
    "shell-process": { PRIVATE: { secure: "invalid" } },
  });
  await layer(p, "hack.env.qa.yaml", {
    global: { WIN: secret },
    host: { DELETE: null, EMPTY: null },
    web: { NUMBER: null },
  });
  await layer(p, "hack.env.qa.local.yaml", {
    global: { EMPTY: "" },
    web: { DELETE: "reintroduced" },
  });
  const opts = selection(p, {
    overlay: "qa",
    hostTargets: {
      includeDefault: true,
      workloadNames: ["web", "job", "inactive"],
    },
  });
  const metadata = await resolveProjectEnvMetadataForNativeSelection(opts);
  const result = await resolveProjectEnvConfigForNativeSelection(opts);
  const { globalEnv, workloadEnv, hostValues, ...actualMetadata } = result;
  expect(actualMetadata).toEqual(metadata);
  expect(globalEnv.WIN).toBe(SENTINEL);
  expect(workloadEnv.web?.WIN).toBe(SENTINEL);
  expect(workloadEnv.web?.WEB).toBe(SENTINEL);
  expect(workloadEnv.web).not.toHaveProperty("NUMBER");
  expect(hostValues?.default).not.toHaveProperty("DELETE");
  expect(hostValues?.default?.EMPTY).toBe("");
  expect(hostValues?.default?.FLAG).toBe("false");
  expect(hostValues?.default?.NUMBER).toBe("7");
  expect(hostValues?.workloads.web?.DELETE).toBe("reintroduced");
  expect(hostValues?.workloads.job?.JOB).toBe("job");
  expect(hostValues?.workloads.inactive?.INACTIVE).toBe("inactive");
  expect(Object.keys(workloadEnv)).toEqual(["web", "job", "inactive"]);
  expect(result.unknownScopes).toEqual(["shell-process"]);
  expect(hostValues?.workloads.web).not.toHaveProperty("PRIVATE");
  expect(JSON.stringify(actualMetadata)).not.toContain(SENTINEL);
});

test("all six worktree layers share precedence and live inherited inputs", async () => {
  const { primary, checkout } = await linked();
  await layer(checkout, "hack.env.default.yaml", {
    host: { BASE: "base", WIN: "base" },
  });
  await layer(checkout, "hack.env.qa.yaml", {
    global: { OVERLAY: "overlay", WIN: "overlay" },
  });
  await layer(primary, "hack.env.local.yaml", {
    host: { PRIMARY: "primary", WIN: "primary" },
  });
  await layer(primary, "hack.env.qa.local.yaml", {
    global: { PRIMARY_OVERLAY: "primary-overlay", WIN: "primary-overlay" },
  });
  await layer(checkout, "hack.env.local.yaml", {
    host: { CURRENT: "current", WIN: "current" },
  });
  await layer(checkout, "hack.env.qa.local.yaml", {
    global: { CURRENT_OVERLAY: "current-overlay", WIN: "current-overlay" },
  });
  const hostTargets = { includeDefault: true, workloadNames: ["web"] };
  const result = await values(checkout, { overlay: "qa", hostTargets });
  expect(result.hostValues?.default).toEqual({
    BASE: "base",
    OVERLAY: "overlay",
    PRIMARY: "primary",
    PRIMARY_OVERLAY: "primary-overlay",
    CURRENT: "current",
    CURRENT_OVERLAY: "current-overlay",
    WIN: "current-overlay",
  });
  expect(result.hostValues?.workloads.web).toEqual(result.hostValues?.default);
  const base = await values(checkout, { hostTargets });
  expect(base.hostValues?.default).toEqual({
    BASE: "base",
    PRIMARY: "primary",
    CURRENT: "current",
    WIN: "current",
  });
  await layer(primary, "hack.env.local.yaml", { global: { LIVE: "updated" } });
  expect((await values(checkout)).workloadEnv.web?.LIVE).toBe("updated");
});

for (const exclusion of ["optout", "ci", "slim", "codex"] as const) {
  test(`${exclusion} excludes primary local env values while preserving checkout-local inputs`, async () => {
    const { primary, checkout } = await linked();
    await layer(primary, "hack.env.local.yaml", {
      global: { PRIMARY: "primary" },
    });
    await layer(primary, "hack.env.qa.local.yaml", {
      global: { PRIMARY_OVERLAY: "primary-overlay" },
    });
    await layer(checkout, "hack.env.local.yaml", {
      global: { CURRENT: "current" },
    });
    if (exclusion === "ci") {
      process.env.CI = "true";
    }
    if (exclusion === "slim" || exclusion === "codex") {
      process.env.HACK_EXECUTION_MODE = exclusion;
    }
    expect(
      (
        await values(checkout, {
          overlay: "qa",
          inheritLocal: exclusion !== "optout",
        })
      ).globalEnv
    ).toEqual({ CURRENT: "current" });
  });
}

test("tracked local overlay compatibility selects default-local without parsing tracked local bytes", async () => {
  const { primary } = await linked();
  await fs.writeFile(
    join(primary, ".hack/hack.env.local.yaml"),
    `invalid ${SENTINEL}`
  );
  await git(primary, ["add", "--force", ".hack/hack.env.local.yaml"]);
  await layer(primary, "hack.env.default.local.yaml", {
    global: { LOCAL: "base-local" },
  });
  expect((await values(primary)).globalEnv).toEqual({ LOCAL: "base-local" });
});

test("host-named declared workload disables generic host injection and selectors reject unrequested targets", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: { WIN: "global" },
    web: { WIN: "web" },
    host: { WIN: "host", HOST: "host" },
    unknown: { PRIVATE: "private" },
  });
  const result = await values(p, {
    declaredWorkloadNames: ["web", "host"],
    hostTargets: { includeDefault: true, workloadNames: ["web"] },
  });
  expect(result.hostValues?.default).toEqual({ WIN: "global" });
  expect(result.hostValues?.workloads.web).toEqual({ WIN: "web" });
  expect(result.workloadEnv.host).toEqual({ WIN: "host", HOST: "host" });
  expect(
    selectProjectEnvValuesForNativeExecutionTarget({
      resolved: result,
      target: "guest",
      workloadName: "host",
    })
  ).toEqual(result.workloadEnv.host ?? {});
  expect(
    selectProjectEnvValuesForNativeExecutionTarget({
      resolved: result,
      target: "host",
    })
  ).toEqual({ WIN: "global" });
  for (const workloadName of ["unknown", "__proto__", "toString"]) {
    expect(() =>
      selectProjectEnvValuesForNativeExecutionTarget({
        resolved: result,
        target: "guest",
        workloadName,
      })
    ).toThrow("values omitted");
  }
  expect(() =>
    selectProjectEnvValuesForNativeExecutionTarget({
      resolved: result,
      target: "host",
      workloadName: "host",
    })
  ).toThrow("values omitted");
  const selected = selectProjectEnvValuesForNativeExecutionTarget({
    resolved: result,
    target: "guest",
    workloadName: "web",
  });
  selected.WIN = "copy";
  expect(result.workloadEnv.web?.WIN).toBe("web");
});

test("unused host and unknown scopes and shadowed secrets do not acquire keys or decrypt", async () => {
  const p = await project();
  const invalid = { secure: `malformed-${SENTINEL}` };
  await fs.mkdir(join(p, PROJECT_ENV_KEY_FILENAME));
  await layer(p, "hack.env.default.yaml", {
    global: { SHADOW: invalid },
    host: { HOST: invalid },
    unknown: { UNKNOWN: invalid },
  });
  await layer(p, "hack.env.local.yaml", { global: { SHADOW: "plain" } });
  const result = await values(p);
  expect(result.globalEnv).toEqual({ SHADOW: "plain" });
  expect(result).not.toHaveProperty("hostValues");
  await refuses(() =>
    values(p, { hostTargets: { includeDefault: true, workloadNames: [] } })
  );
  // Metadata remains value-free even when delivery refuses the unusable key/ciphertext.
  expect(
    (
      await resolveProjectEnvMetadataForNativeSelection(
        selection(p, {
          hostTargets: { includeDefault: true, workloadNames: [] },
        })
      )
    ).hostMetadata?.default?.HOST?.secret
  ).toBe(true);
});

test("missing key refuses without creation, warnings or disclosed ciphertext", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  const before = await fs.readdir(p);
  const warning = spyOn(process.stderr, "write");
  await refuses(() => values(p));
  expect(await fs.readdir(p)).toEqual(before);
  expect(await Bun.file(join(p, PROJECT_ENV_KEY_FILENAME)).exists()).toBe(
    false
  );
  expect(warning).not.toHaveBeenCalled();
});

test("native key priority remains local then shared then primary then environment with no writes", async () => {
  const { primary, checkout } = await linked();
  const secret = await encrypted();
  await layer(checkout, "hack.env.default.yaml", {
    global: { SECRET: secret },
  });
  const local = join(checkout, PROJECT_ENV_KEY_FILENAME);
  const shared = join(primary, ".git", PROJECT_ENV_KEY_FILENAME);
  const inherited = join(primary, PROJECT_ENV_KEY_FILENAME);
  process.env.HACK_ENV_SECRET_KEY = "wrong-environment-key";
  await fs.writeFile(local, KEY);
  await fs.writeFile(shared, "wrong-shared-key");
  await fs.writeFile(inherited, "wrong-primary-key");
  expect((await values(checkout)).globalEnv.SECRET).toBe(SENTINEL);
  await fs.rm(local);
  await fs.writeFile(shared, KEY);
  expect(
    (await values(checkout, { inheritLocal: false })).globalEnv.SECRET
  ).toBe(SENTINEL);
  expect(
    (await values(primary, { declaredWorkloadNames: [] })).globalEnv
  ).toEqual({});
  await fs.rm(shared);
  await fs.writeFile(inherited, KEY);
  process.env.CI = "true";
  expect((await values(checkout)).globalEnv.SECRET).toBe(SENTINEL);
  await fs.rm(inherited);
  process.env.HACK_ENV_SECRET_KEY = KEY;
  expect((await values(checkout)).globalEnv.SECRET).toBe(SENTINEL);
  expect(await Bun.file(local).exists()).toBe(false);
  expect(await Bun.file(shared).exists()).toBe(false);
  expect(await Bun.file(inherited).exists()).toBe(false);
});

for (const kind of [
  "wrong-key",
  "cipher-malformed",
  "cipher-iv",
  "cipher-tag",
] as const) {
  test(`${kind} refuses with fixed redacted diagnostics`, async () => {
    const p = await project();
    await fs.writeFile(
      join(p, PROJECT_ENV_KEY_FILENAME),
      kind === "wrong-key" ? "wrong-key" : KEY
    );
    const secret =
      kind === "wrong-key"
        ? await encrypted()
        : {
            secure:
              kind === "cipher-malformed"
                ? SENTINEL
                : `v1:${kind === "cipher-iv" ? "AA==" : "AAAAAAAAAAAAAAAA"}:${kind === "cipher-tag" ? "AA==" : "AAAAAAAAAAAAAAAAAAAAAA=="}:${SENTINEL}`,
          };
    await layer(p, "hack.env.default.yaml", { global: { SECRET: secret } });
    await refuses(() => values(p));
  });
}

test("an encrypted empty value preserves presence", async () => {
  const p = await project();
  await fs.writeFile(join(p, PROJECT_ENV_KEY_FILENAME), KEY);
  await layer(p, "hack.env.default.yaml", {
    global: { EMPTY: await encrypted("") },
  });
  expect((await values(p)).globalEnv).toEqual({ EMPTY: "" });
});

test("ordinary Git checkout reads an existing shared key and ignores caller Git redirection", async () => {
  const { primary } = await linked();
  await layer(primary, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  await fs.writeFile(join(primary, ".git", PROJECT_ENV_KEY_FILENAME), KEY);
  process.env.GIT_DIR = join(root, "foreign");
  process.env.GIT_WORK_TREE = join(root, "foreign");
  process.env.GIT_COMMON_DIR = join(root, "foreign");
  expect((await values(primary)).globalEnv.SECRET).toBe(SENTINEL);
  expect(await Bun.file(join(primary, PROJECT_ENV_KEY_FILENAME)).exists()).toBe(
    false
  );
});

test("separate Git directory preserves existing shared key priority over environment fallback", async () => {
  const p = await project();
  const commonDir = join(root, "separate-git-admin");
  await git(p, [
    "init",
    "--quiet",
    "-b",
    "main",
    "--separate-git-dir",
    commonDir,
  ]);
  await layer(p, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  await fs.writeFile(join(commonDir, PROJECT_ENV_KEY_FILENAME), KEY);
  process.env.HACK_ENV_SECRET_KEY = "wrong-fallback-key";
  expect((await values(p)).globalEnv.SECRET).toBe(SENTINEL);
  expect(await Bun.file(join(p, PROJECT_ENV_KEY_FILENAME)).exists()).toBe(
    false
  );
});

test("nested native project preserves repository common and primary key priority", async () => {
  const { primary } = await linked();
  const nested = await project("primary/nested");
  await layer(nested, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  const shared = join(primary, ".git", PROJECT_ENV_KEY_FILENAME);
  const inherited = join(primary, PROJECT_ENV_KEY_FILENAME);
  await fs.writeFile(shared, KEY);
  await fs.writeFile(inherited, "wrong-primary-key");
  process.env.HACK_ENV_SECRET_KEY = "wrong-fallback-key";
  expect((await values(nested)).globalEnv.SECRET).toBe(SENTINEL);
  await fs.rm(shared);
  await fs.writeFile(inherited, KEY);
  expect((await values(nested)).globalEnv.SECRET).toBe(SENTINEL);
  expect(await Bun.file(join(nested, PROJECT_ENV_KEY_FILENAME)).exists()).toBe(
    false
  );
});

for (const target of ["shared", "primary"] as const) {
  test(`redirected ${target} key refuses without environment fallback`, async () => {
    const { primary, checkout } = await linked();
    await layer(checkout, "hack.env.default.yaml", {
      global: { SECRET: await encrypted() },
    });
    const privateFile = join(root, SENTINEL);
    await fs.writeFile(privateFile, KEY);
    const key =
      target === "shared"
        ? join(primary, ".git", PROJECT_ENV_KEY_FILENAME)
        : join(primary, PROJECT_ENV_KEY_FILENAME);
    await fs.symlink(privateFile, key);
    process.env.HACK_ENV_SECRET_KEY = KEY;
    await refuses(() => values(checkout, { inheritLocal: false }));
  });
}

test("unverified key sharing refuses without environment fallback when local inheritance is disabled", async () => {
  const { checkout } = await linked();
  await layer(checkout, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  await fs.writeFile(
    join(checkout, ".git"),
    `gitdir: ${join(root, SENTINEL)}\n`
  );
  process.env.HACK_ENV_SECRET_KEY = KEY;
  await refuses(() => values(checkout, { inheritLocal: false }));
});

for (const kind of [
  "symlink",
  "directory",
  "unreadable",
  "oversized",
  "utf8",
] as const) {
  test(`native key ${kind} refuses before delivery`, async () => {
    const p = await project();
    await layer(p, "hack.env.default.yaml", {
      global: { SECRET: await encrypted() },
    });
    const key = join(p, PROJECT_ENV_KEY_FILENAME);
    if (kind === "symlink") {
      const target = join(root, SENTINEL);
      await fs.writeFile(target, KEY);
      await fs.symlink(target, key);
    } else if (kind === "directory") {
      await fs.mkdir(key);
    } else {
      await fs.writeFile(
        key,
        kind === "utf8"
          ? new Uint8Array([0xff])
          : kind === "oversized"
            ? "x".repeat(1024 * 1024 + 1)
            : KEY
      );
      if (kind === "unreadable") {
        await fs.chmod(key, 0);
      }
    }
    await refuses(() => values(p));
  });
}

for (const kind of [
  "malformed",
  "symlink",
  "directory",
  "oversized",
  "utf8",
] as const) {
  test(`selected managed env ${kind} retains bounded native acquisition refusal`, async () => {
    const p = await project();
    const path = join(p, ".hack/hack.env.qa.yaml");
    if (kind === "symlink") {
      await fs.symlink(join(root, SENTINEL), path);
    } else if (kind === "directory") {
      await fs.mkdir(path);
    } else {
      await fs.writeFile(
        path,
        kind === "utf8"
          ? new Uint8Array([0xff])
          : kind === "oversized"
            ? "x".repeat(1024 * 1024 + 1)
            : `invalid: [${SENTINEL}`
      );
    }
    await refuses(() => values(p, { overlay: "qa" }));
  });
}

test("native/legacy mixed family and redirected project directory refuse without legacy fallback", async () => {
  const p = await project();
  await fs.writeFile(join(p, ".hack/hack.config.json"), `invalid ${SENTINEL}`);
  await refuses(() => values(p));
  await fs.rm(join(p, ".hack/hack.config.json"));
  const moved = join(root, "moved");
  await fs.rename(join(p, ".hack"), moved);
  await fs.symlink(moved, join(p, ".hack"));
  await refuses(() => values(p));
});

/** Change or abort after descriptor opening, before the owner's descriptor checks and read. */
function interceptDescriptor(path: string, effect: () => Promise<void>) {
  const originalOpen = fs.open;
  let closed = 0;
  spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args);
    if (args[0] === path) {
      const originalClose = file.close.bind(file);
      spyOn(file, "close").mockImplementation(async () => {
        await originalClose();
        closed++;
      });
      await effect();
    }
    return file;
  });
  return () => closed;
}

test("caller array mutation cannot expand declared or host targets after selection validation", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    web: { ALLOWED: "web" },
    unknown: { PRIVATE: { secure: SENTINEL } },
  });
  const declaredWorkloadNames = ["web"];
  const workloadNames = ["web"];
  interceptDescriptor(join(p, ".hack/hack.project.json"), async () => {
    declaredWorkloadNames.splice(0, 1, "unknown");
    workloadNames.splice(0, 1, "unknown");
  });
  const result = await values(p, {
    declaredWorkloadNames,
    hostTargets: { includeDefault: false, workloadNames },
  });
  expect(result.workloadEnv).toEqual({ web: { ALLOWED: "web" } });
  expect(result.hostValues).toEqual({ workloads: { web: { ALLOWED: "web" } } });
});

for (const target of ["env", "key"] as const) {
  test(`changed ${target} descriptor input refuses with redacted diagnostics`, async () => {
    const p = await project();
    await layer(p, "hack.env.default.yaml", {
      global: { SECRET: await encrypted() },
    });
    await fs.writeFile(join(p, PROJECT_ENV_KEY_FILENAME), KEY);
    const path = join(
      p,
      target === "env"
        ? ".hack/hack.env.default.yaml"
        : PROJECT_ENV_KEY_FILENAME
    );
    const closed = interceptDescriptor(path, () =>
      fs.writeFile(path, `${SENTINEL} changed-input`)
    );
    await refuses(() => values(p));
    expect(closed()).toBe(1);
  });
  test(`cancelled ${target} descriptor read preserves fixed cancellation`, async () => {
    const p = await project();
    await layer(p, "hack.env.default.yaml", {
      global: { SECRET: await encrypted() },
    });
    await fs.writeFile(join(p, PROJECT_ENV_KEY_FILENAME), KEY);
    const controller = new AbortController();
    const path = join(
      p,
      target === "env"
        ? ".hack/hack.env.default.yaml"
        : PROJECT_ENV_KEY_FILENAME
    );
    const closed = interceptDescriptor(path, async () => {
      controller.abort(SENTINEL);
    });
    await expect(
      values(p, { signal: controller.signal })
    ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
    expect(closed()).toBe(1);
  });
}

test("cancellation interrupts an owned Git lookup before key fallback", async () => {
  const p = await project();
  await git(p, ["init", "--quiet", "-b", "main"]);
  await layer(p, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  const bin = join(root, "bin");
  const marker = join(root, "git-started");
  await fs.mkdir(bin);
  await fs.writeFile(
    join(bin, "git"),
    `#!/bin/sh\nprintf ready > '${marker}'\nexec /bin/sleep 30\n`
  );
  await fs.chmod(join(bin, "git"), 0o700);
  process.env.PATH = bin;
  process.env.HACK_ENV_SECRET_KEY = KEY;
  const controller = new AbortController();
  // No local inheritance inspection; the first Git child belongs to key lookup.
  const pending = values(p, {
    inheritLocal: false,
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error
  );
  try {
    for (
      let attempt = 0;
      attempt < 100 && !(await Bun.file(marker).exists());
      attempt++
    ) {
      await Bun.sleep(5);
    }
    expect(await Bun.file(marker).exists()).toBe(true);
  } finally {
    controller.abort(SENTINEL);
  }
  const error = await pending;
  expect(error).toMatchObject({ code: "E_COMPILER_CANCELLED" });
  expect(String(error)).not.toContain(SENTINEL);
});

test("combined returned values are bounded before repeated large baselines allocate", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: { LARGE: "x".repeat(600_000) },
  });
  await refuses(() => values(p));
  const result = await values(p, { declaredWorkloadNames: [] });
  expect(result.globalEnv.LARGE?.length).toBe(600_000);
  await refuses(() =>
    values(p, {
      declaredWorkloadNames: [],
      hostTargets: { includeDefault: true, workloadNames: [] },
    })
  );
});

test("noncanonical and unknown host targets refuse before value delivery", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    unknown: { SECRET: { secure: SENTINEL } },
  });
  for (const workloadNames of [["unknown"], ["web", "web"], ["../private"]]) {
    await refuses(() =>
      values(p, { hostTargets: { includeDefault: false, workloadNames } })
    );
  }
  const controller = new AbortController();
  controller.abort(SENTINEL);
  await expect(values(p, { signal: controller.signal })).rejects.toMatchObject({
    code: "E_COMPILER_CANCELLED",
  });
});

test("private env capability shares one initial acquisition and exposes only frozen safe metadata", async () => {
  const p = await project();
  const envPath = join(p, ".hack/hack.env.default.yaml");
  await layer(p, "hack.env.default.yaml", { global: { VALUE: "captured" } });
  const originalOpen = fs.open;
  let initialReads = 0;
  spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === envPath) {
      initialReads++;
    }
    return await originalOpen(...args);
  });
  const opts = selection(p);
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  expect(initialReads).toBe(1);
  expect(Object.keys(acquired)).toEqual(["metadata"]);
  expect(JSON.parse(JSON.stringify(acquired))).toEqual({
    metadata: acquired.metadata,
  });
  expect(JSON.stringify(acquired)).not.toContain("captured");
  expect(
    Reflect.set(acquired.metadata.effectiveMetadata.global ?? {}, "FORGED", {
      scope: "global",
      secret: false,
    })
  ).toBe(false);
  await acquired.assertFresh(opts);
  const result = await acquired.resolveValues();
  // One explicit freshness check plus value delivery's before/after checks;
  // delivery itself reuses the captured baseline rather than acquiring another.
  expect(initialReads).toBe(4);
  expect(result.globalEnv).toEqual({ VALUE: "captured" });
  expect(Reflect.set(result.globalEnv, "VALUE", "forged")).toBe(false);
  expect((await acquired.resolveValues()).globalEnv).toEqual({
    VALUE: "captured",
  });
});

for (const change of ["plain", "whitespace", "ciphertext"] as const) {
  test(`private env revision detects ${change} changes without public metadata changes`, async () => {
    const p = await project();
    const secret = await encrypted();
    await fs.writeFile(join(p, PROJECT_ENV_KEY_FILENAME), KEY);
    await layer(p, "hack.env.default.yaml", {
      global: { VALUE: change === "ciphertext" ? secret : "first" },
    });
    const opts = selection(p);
    const acquired = await acquireProjectEnvForNativeExecution(opts);
    if (change === "whitespace") {
      await fs.appendFile(join(p, ".hack/hack.env.default.yaml"), "\n  \n");
    } else {
      await layer(p, "hack.env.default.yaml", {
        global: {
          VALUE: change === "ciphertext" ? await encrypted() : "second",
        },
      });
    }
    expect(await resolveProjectEnvMetadataForNativeSelection(opts)).toEqual(
      acquired.metadata
    );
    await refuses(async () => acquired.assertFresh(opts));
    await refuses(async () => acquired.resolveValues());
  });
}

for (const kind of ["added", "removed"] as const) {
  test(`private env revision detects ${kind} optional layers`, async () => {
    const p = await project();
    await layer(p, "hack.env.default.yaml", {});
    const filename = "hack.env.qa.local.yaml";
    if (kind === "removed") {
      await layer(p, filename, {});
    }
    const opts = selection(p, { overlay: "qa" });
    const acquired = await acquireProjectEnvForNativeExecution(opts);
    if (kind === "added") {
      await layer(p, filename, {});
    } else {
      await fs.rm(join(p, ".hack", filename));
    }
    expect(await resolveProjectEnvMetadataForNativeSelection(opts)).toEqual(
      acquired.metadata
    );
    await refuses(async () => acquired.assertFresh(opts));
  });
}

for (const index of [0, 1, 2, 3, 4, 5]) {
  test(`private env revision binds raw bytes for selected worktree layer ${index}`, async () => {
    const { primary, checkout } = await linked();
    const layers = [
      [checkout, "hack.env.default.yaml"],
      [checkout, "hack.env.qa.yaml"],
      [primary, "hack.env.local.yaml"],
      [primary, "hack.env.qa.local.yaml"],
      [checkout, "hack.env.local.yaml"],
      [checkout, "hack.env.qa.local.yaml"],
    ] as const;
    for (const [p, filename] of layers) {
      await layer(p, filename, { global: { VALUE: "same" } });
    }
    const opts = selection(checkout, { overlay: "qa" });
    const acquired = await acquireProjectEnvForNativeExecution(opts);
    const target = layers[index];
    if (!target) {
      throw new Error("Missing fixture layer");
    }
    await fs.appendFile(join(target[0], ".hack", target[1]), "\n");
    expect(await resolveProjectEnvMetadataForNativeSelection(opts)).toEqual(
      acquired.metadata
    );
    await refuses(async () => acquired.assertFresh(opts));
  });
}

test("private env revision binds tracked-local compatibility inputs and their absence", async () => {
  const { primary } = await linked();
  await layer(primary, "hack.env.local.yaml", {}, "local");
  await git(primary, ["add", "--force", ".hack/hack.env.local.yaml"]);
  const opts = selection(primary);
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  await layer(primary, "hack.env.default.local.yaml", {});
  await refuses(async () => acquired.assertFresh(opts));
});

test("private env revision binds exact overlay, inheritance, roots and target selections", async () => {
  const p = await project();
  const other = await project("other");
  const opts = selection(p, {
    hostTargets: { includeDefault: true, workloadNames: ["web"] },
  });
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  for (const current of [
    { ...opts, projectRoot: other },
    { ...opts, overlay: "qa" },
    { ...opts, inheritLocal: false },
    { ...opts, declaredWorkloadNames: ["web", "job"] },
    { ...opts, hostTargets: { includeDefault: false, workloadNames: ["web"] } },
    { ...opts, hostTargets: { includeDefault: true, workloadNames: ["job"] } },
  ]) {
    await refuses(async () => acquired.assertFresh(current));
  }
});

test("private env revision detects inherited root exclusion even when effective metadata is identical", async () => {
  const { primary, checkout } = await linked();
  await layer(primary, "hack.env.local.yaml", { global: { VALUE: "same" } });
  await layer(checkout, "hack.env.local.yaml", { global: { VALUE: "same" } });
  const opts = selection(checkout);
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  process.env.CI = "true";
  expect(await resolveProjectEnvMetadataForNativeSelection(opts)).toEqual(
    acquired.metadata
  );
  await refuses(async () => acquired.assertFresh(opts));
});

test("private env capability snapshots caller arrays and never shares mutable binding state", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", { global: { VALUE: "same" } });
  const names = ["web"];
  const hosts = ["web"];
  const opts = selection(p, {
    declaredWorkloadNames: names,
    hostTargets: { includeDefault: false, workloadNames: hosts },
  });
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  names.splice(0, 1, "job");
  hosts.splice(0, 1, "job");
  expect(Object.keys((await acquired.resolveValues()).workloadEnv)).toEqual([
    "web",
  ]);
  await refuses(async () => acquired.assertFresh(opts));
});

test("private env acquisition and freshness remain key-free and decryption-free", async () => {
  const p = await project();
  await fs.mkdir(join(p, PROJECT_ENV_KEY_FILENAME));
  await layer(p, "hack.env.default.yaml", {
    global: { SECRET: { secure: SENTINEL } },
  });
  const opts = selection(p);
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  expect(acquired.metadata.effectiveMetadata.global?.SECRET?.secret).toBe(true);
  await acquired.assertFresh(opts);
  expect(JSON.stringify(acquired)).not.toContain(SENTINEL);
  await refuses(async () => acquired.resolveValues());
});

test("private env revision rechecks after key resolution before returning decrypted values", async () => {
  const p = await project();
  await fs.writeFile(join(p, PROJECT_ENV_KEY_FILENAME), KEY);
  await layer(p, "hack.env.default.yaml", {
    global: { SECRET: await encrypted() },
  });
  const opts = selection(p);
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  const closed = interceptDescriptor(join(p, PROJECT_ENV_KEY_FILENAME), () =>
    fs.appendFile(join(p, ".hack/hack.env.default.yaml"), "\n")
  );
  await refuses(async () => acquired.resolveValues());
  expect(closed()).toBe(1);
});

for (const kind of [
  "malformed",
  "symlink",
  "oversized",
  "cancelled",
] as const) {
  test(`private env recheck retains ${kind} redaction and cancellation`, async () => {
    const p = await project();
    await layer(p, "hack.env.default.yaml", {});
    const opts = selection(p);
    const acquired = await acquireProjectEnvForNativeExecution(opts);
    const path = join(p, ".hack/hack.env.default.yaml");
    if (kind === "cancelled") {
      const controller = new AbortController();
      const closed = interceptDescriptor(path, async () => {
        controller.abort(SENTINEL);
      });
      await expect(
        acquired.assertFresh({ ...opts, signal: controller.signal })
      ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
      expect(closed()).toBe(1);
      return;
    }
    if (kind === "symlink") {
      await fs.rm(path);
      await fs.symlink(join(root, SENTINEL), path);
    } else {
      await fs.writeFile(
        path,
        kind === "oversized"
          ? "x".repeat(1024 * 1024 + 1)
          : `invalid: [${SENTINEL}`
      );
    }
    await refuses(async () => acquired.assertFresh(opts));
  });
}

test("private env revision ignores layers outside explicit selection", async () => {
  const p = await project();
  const opts = selection(p);
  const acquired = await acquireProjectEnvForNativeExecution(opts);
  await layer(p, "hack.env.qa.yaml", { global: { VALUE: SENTINEL } });
  await acquired.assertFresh(opts);
  expect((await acquired.resolveValues()).globalEnv).toEqual({});
});
