import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireNativeManagedEnvFile } from "../src/lib/native-project-inputs.ts";
import {
  type ProjectEnvValuesByScope,
  resolveProjectEnvMetadataForNativeSelection,
} from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const SENTINEL = "private-synthetic-value-must-not-escape";
const secure = { secure: `invalid-ciphertext-${SENTINEL}` };
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
  root = await realpath(await mkdtemp(join(tmpdir(), "native-env-metadata-")));
});
afterEach(async () => {
  for (const key of ENV_KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { recursive: true, force: true });
});
async function project(name = "primary") {
  const projectRoot = join(root, name);
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  // Selection is supplied by the compiler; this owner never parses project policy.
  await writeFile(
    join(projectRoot, ".hack/hack.project.json"),
    `${SENTINEL} invalid json`
  );
  return projectRoot;
}
async function layer(
  projectRoot: string,
  filename: string,
  values: ProjectEnvValuesByScope,
  environment = "default"
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
function metadata(
  projectRoot: string,
  overlay: string | null = null,
  inheritLocal = true,
  declaredWorkloadNames: readonly string[] = ["web", "job", "inactive"]
) {
  return resolveProjectEnvMetadataForNativeSelection({
    projectRoot,
    overlay,
    inheritLocal,
    declaredWorkloadNames,
  });
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
async function refuses(run: () => Promise<unknown>) {
  try {
    await run();
    throw new Error("Expected refusal");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toContain("values omitted");
    expect(error.message).not.toContain(SENTINEL);
    expect(error.message).not.toContain(root);
    expect(error.cause).toBeUndefined();
  }
}

test("explicit selection preserves no-docs and missing overlay without dotenv or key lookup", async () => {
  const p = await project();
  await writeFile(join(p, ".hack/.env"), `LEGACY=${SENTINEL}`);
  await mkdir(join(p, ".hack/.hack.secret.key"));
  const before = await readdir(join(p, ".hack"));
  for (const overlay of [null, "qa"]) {
    expect(await metadata(p, overlay)).toEqual({
      overlay,
      overlayExists: false,
      effectiveMetadata: {},
      unknownScopes: [],
    });
  }
  expect(await readdir(join(p, ".hack"))).toEqual(before);
});

test("same owner projection preserves scopes, tombstones, empty presence, jobs and inactive declarations", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: { EMPTY: "", DELETE: secure, WIN: secure },
    web: { WIN: SENTINEL },
    host: { HOST: secure },
    job: { JOB: secure },
    inactive: { INACTIVE: secure },
    unknown: { UNKNOWN: secure },
  });
  await layer(p, "hack.env.qa.yaml", {
    global: { WIN: secure, DELETE: null },
    web: { EMPTY: null },
  });
  await layer(p, "hack.env.local.yaml", {
    global: { EMPTY: "", WIN: SENTINEL },
  });
  await layer(p, "hack.env.qa.local.yaml", {
    web: { DELETE: "", WIN: secure },
  });
  const result = await metadata(p, "qa");
  expect(result.overlayExists).toBe(true);
  expect(result.unknownScopes).toEqual(["unknown"]);
  expect(result.effectiveMetadata.web).toEqual({
    EMPTY: { scope: "global", secret: false },
    DELETE: { scope: "web", secret: false },
    WIN: { scope: "web", secret: true },
  });
  expect(result.effectiveMetadata.job?.JOB).toEqual({
    scope: "job",
    secret: true,
  });
  expect(result.effectiveMetadata.inactive?.INACTIVE).toEqual({
    scope: "inactive",
    secret: true,
  });
  expect(result.effectiveMetadata.web?.HOST).toBeUndefined();
  expect(
    (await metadata(p, "qa", true, ["web", "host"])).effectiveMetadata.host
      ?.HOST
  ).toEqual({ scope: "host", secret: true });
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
  expect(Object.keys(result).sort()).toEqual([
    "effectiveMetadata",
    "overlay",
    "overlayExists",
    "unknownScopes",
  ]);
  expect((await metadata(p, null)).effectiveMetadata.web?.DELETE).toEqual({
    scope: "global",
    secret: true,
  });
});

test("all six layers use live verified primary inputs with checkout-local precedence", async () => {
  const { primary, checkout } = await linked();
  await layer(checkout, "hack.env.default.yaml", {
    web: { WIN: SENTINEL, BASE: "" },
  });
  await layer(checkout, "hack.env.qa.yaml", {
    global: { WIN: secure, OVERLAY: "" },
  });
  await layer(primary, "hack.env.local.yaml", {
    web: { WIN: SENTINEL, PRIMARY: "" },
  });
  await layer(primary, "hack.env.qa.local.yaml", {
    global: { WIN: secure, PRIMARY_OVERLAY: "" },
  });
  await layer(checkout, "hack.env.local.yaml", {
    web: { WIN: SENTINEL, CURRENT: "" },
  });
  await layer(checkout, "hack.env.qa.local.yaml", {
    global: { WIN: secure, CURRENT_OVERLAY: "" },
  });
  expect((await metadata(checkout, "qa")).effectiveMetadata.web?.WIN).toEqual({
    scope: "global",
    secret: true,
  });
  expect(
    Object.keys(
      (await metadata(checkout, "qa")).effectiveMetadata.web ?? {}
    ).sort()
  ).toEqual([
    "BASE",
    "CURRENT",
    "CURRENT_OVERLAY",
    "OVERLAY",
    "PRIMARY",
    "PRIMARY_OVERLAY",
    "WIN",
  ]);
  await layer(primary, "hack.env.local.yaml", { global: { NEW: secure } });
  expect((await metadata(checkout)).effectiveMetadata.web?.NEW).toEqual({
    scope: "global",
    secret: true,
  });
  expect((await metadata(primary)).effectiveMetadata.web?.NEW).toEqual({
    scope: "global",
    secret: true,
  });
});

for (const exclusion of ["optout", "ci", "slim", "codex"] as const) {
  test(`${exclusion} skips incompatible primary but retains checkout-local layer`, async () => {
    const { primary, checkout } = await linked();
    await rm(join(primary, ".hack/hack.project.json"));
    await writeFile(join(primary, ".hack/hack.config.json"), SENTINEL);
    await layer(checkout, "hack.env.local.yaml", {
      global: { CURRENT: secure },
    });
    if (exclusion === "ci") {
      process.env.CI = "true";
    }
    if (exclusion === "slim" || exclusion === "codex") {
      process.env.HACK_EXECUTION_MODE = exclusion;
    }
    expect(
      (await metadata(checkout, null, exclusion !== "optout")).effectiveMetadata
        .web?.CURRENT?.secret
    ).toBe(true);
  });
}

test("nested native root never inherits its ancestor checkout's locals", async () => {
  const { primary, checkout } = await linked();
  await layer(primary, "hack.env.local.yaml", { global: { FOREIGN: secure } });
  const nested = join(checkout, "nested");
  await mkdir(join(nested, ".hack"), { recursive: true });
  await writeFile(join(nested, ".hack/hack.project.json"), "{}");
  expect((await metadata(nested)).effectiveMetadata).toEqual({});
});

test("invalid exact-root Git linkage refuses instead of inheriting or falling back", async () => {
  const p = await project();
  await writeFile(join(p, ".git"), `gitdir: ${SENTINEL}`);
  await refuses(() => metadata(p));
});

test("tracked local filename compatibility and non-Git environment hint remain supported", async () => {
  const { primary } = await linked();
  await layer(
    primary,
    "hack.env.local.yaml",
    { global: { OLD: secure } },
    "local"
  );
  await git(primary, ["add", ".hack/hack.env.local.yaml"]);
  await layer(primary, "hack.env.default.local.yaml", {
    global: { NEW: secure },
  });
  expect((await metadata(primary)).effectiveMetadata.web).toEqual({
    NEW: { scope: "global", secret: true },
  });
  expect(
    (await metadata(primary, "local")).effectiveMetadata.web?.OLD?.secret
  ).toBe(true);
  const standalone = await project("standalone");
  await layer(
    standalone,
    "hack.env.local.yaml",
    { global: { OLD: secure } },
    "local"
  );
  await layer(standalone, "hack.env.default.local.yaml", {
    global: { NEW: secure },
  });
  expect((await metadata(standalone)).effectiveMetadata.web).toEqual({
    NEW: { scope: "global", secret: true },
  });
});

for (const kind of [
  "symlink",
  "dangling",
  "directory",
  "unreadable",
  "oversized",
  "malformed",
  "utf8",
] as const) {
  test(`selected ${kind} managed input refuses with redacted error`, async () => {
    const p = await project();
    const path = join(p, ".hack/hack.env.qa.yaml");
    const target = join(root, SENTINEL);
    await writeFile(target, SENTINEL);
    if (kind === "symlink" || kind === "dangling") {
      await symlink(kind === "symlink" ? target : `${target}-missing`, path);
    } else if (kind === "directory") {
      await mkdir(path);
    } else if (kind === "oversized") {
      await writeFile(path, "x".repeat(1024 * 1024 + 1));
    } else if (kind === "utf8") {
      await writeFile(path, new Uint8Array([0xff]));
    } else {
      await writeFile(path, `broken: [${SENTINEL}`);
      if (kind === "unreadable") {
        await chmod(path, 0);
      }
    }
    await refuses(() => metadata(p, "qa"));
  });
}

test("redirected .hack and mixed family refuse, arbitrary helper filenames cannot read keys", async () => {
  const p = await project();
  await refuses(() =>
    acquireNativeManagedEnvFile({
      projectRoot: p,
      filename: ".hack.secret.key",
    })
  );
  await refuses(() =>
    acquireNativeManagedEnvFile({ projectRoot: p, filename: "../outside" })
  );
  await writeFile(join(p, ".hack/hack.config.json"), SENTINEL);
  await refuses(() => metadata(p));
  await rm(join(p, ".hack/hack.config.json"));
  const moved = join(root, "moved");
  await mkdir(moved);
  await writeFile(join(moved, "hack.project.json"), "{}");
  await rm(join(p, ".hack"), { recursive: true });
  await symlink(moved, join(p, ".hack"));
  await refuses(() => metadata(p));
});

test("already cancelled acquisition propagates fixed cancellation without caller reason", async () => {
  const p = await project();
  const controller = new AbortController();
  controller.abort(SENTINEL);
  await expect(
    resolveProjectEnvMetadataForNativeSelection({
      projectRoot: p,
      overlay: null,
      inheritLocal: true,
      declaredWorkloadNames: [],
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
});

test("aggregate metadata expansion is bounded independently of file size", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`KEY_${i}`, ""])
    ),
  });
  await refuses(() =>
    metadata(
      p,
      null,
      true,
      Array.from({ length: 40 }, (_, i) => `workload-${i}`)
    )
  );
});

test("empty managed document retains presence; unrelated local policy is never parsed", async () => {
  const p = await project();
  await writeFile(join(p, ".hack/hack.local.json"), `broken ${SENTINEL}`);
  await layer(p, "hack.env.qa.yaml", {});
  expect(await metadata(p, "qa", false, [])).toEqual({
    overlay: "qa",
    overlayExists: true,
    effectiveMetadata: { global: {} },
    unknownScopes: [],
  });
  for (const overlay of ["../secret", "qa.local", "QA", ""]) {
    await refuses(() => metadata(p, overlay));
  }
});

test("primary redirected managed layers refuse and optout preserves current-only selection", async () => {
  const { primary, checkout } = await linked();
  await symlink(
    join(root, SENTINEL),
    join(primary, ".hack/hack.env.local.yaml")
  );
  await refuses(() => metadata(checkout));
  expect((await metadata(checkout, null, false)).effectiveMetadata).toEqual({});
});

test("tracked-path inspection disables repository fsmonitor and ignores caller Git redirection", async () => {
  const { primary } = await linked();
  const marker = join(root, "fsmonitor-ran");
  const hook = join(root, "fsmonitor.sh");
  await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
  await chmod(hook, 0o700);
  await git(primary, ["config", "core.fsmonitor", hook]);
  await layer(
    primary,
    "hack.env.local.yaml",
    { global: { LOCAL: secure } },
    "local"
  );
  process.env.GIT_DIR = join(root, "foreign");
  process.env.GIT_WORK_TREE = join(root, "foreign");
  process.env.GIT_COMMON_DIR = join(root, "foreign");
  // Untracked local remains base even with a historical environment hint in Git.
  expect((await metadata(primary)).effectiveMetadata.web?.LOCAL?.secret).toBe(
    true
  );
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("cancellation interrupts and reaps an in-flight owned Git inspection", async () => {
  const { primary } = await linked();
  const bin = join(root, "bin");
  const marker = join(root, "inspection-started");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nprintf ready > '${marker}'\nexec /bin/sleep 30\n`
  );
  await chmod(join(bin, "git"), 0o700);
  process.env.PATH = bin;
  const controller = new AbortController();
  const pending = resolveProjectEnvMetadataForNativeSelection({
    projectRoot: primary,
    overlay: null,
    inheritLocal: true,
    declaredWorkloadNames: [],
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

test("host-only many-key input stays within the guest output budget across many workloads", async () => {
  const p = await project();
  const hostKeys = Object.fromEntries(
    Array.from({ length: 4000 }, (_, index) => [`HOST_${index}`, secure])
  );
  const workloads = Array.from({ length: 300 }, (_, index) => `guest-${index}`);
  await layer(p, "hack.env.default.yaml", { host: hostKeys });
  const result = await metadata(p, null, false, workloads);
  expect(result.unknownScopes).toEqual([]);
  expect(Object.keys(result.effectiveMetadata.host ?? {})).toHaveLength(4000);
  for (const name of workloads) {
    expect(result.effectiveMetadata[name]).toEqual({});
  }
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
  // A declared workload named host still receives its own scope as guest data.
  const withHost = await metadata(p, null, false, [...workloads, "host"]);
  expect(withHost.effectiveMetadata.host).toEqual(
    result.effectiveMetadata.host
  );
});

function hostMetadata(
  projectRoot: string,
  opts: {
    readonly overlay?: string | null;
    readonly inheritLocal?: boolean;
    readonly declaredWorkloadNames?: readonly string[];
    readonly includeDefault?: boolean;
    readonly workloadNames?: readonly string[];
  } = {}
) {
  return resolveProjectEnvMetadataForNativeSelection({
    projectRoot,
    overlay: opts.overlay ?? null,
    inheritLocal: opts.inheritLocal ?? true,
    declaredWorkloadNames: opts.declaredWorkloadNames ?? [
      "web",
      "job",
      "inactive",
    ],
    hostTargets: {
      includeDefault: opts.includeDefault ?? true,
      workloadNames: opts.workloadNames ?? ["web"],
    },
  });
}

test("host selection is optional and preserves exact empty/default/requested workload presence", async () => {
  const p = await project();
  expect(await metadata(p)).not.toHaveProperty("hostMetadata");
  expect((await hostMetadata(p)).hostMetadata).toEqual({
    default: {},
    workloads: { web: {} },
  });
  expect(
    (await hostMetadata(p, { includeDefault: false, workloadNames: [] }))
      .hostMetadata
  ).toEqual({ workloads: {} });
  expect(
    (
      await hostMetadata(p, {
        includeDefault: false,
        workloadNames: ["job", "inactive"],
      })
    ).hostMetadata
  ).toEqual({ workloads: { job: {}, inactive: {} } });
});

test("host default and workload baselines follow layered specificity, tombstones and reintroduction", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: { WIN: "", DELETE: secure, EMPTY: "" },
    web: { WIN: secure, WEB: secure },
    job: { JOB: secure },
    inactive: { INACTIVE: secure },
    host: { WIN: "", HOST: secure },
    "shell-process": { PRIVATE_SCOPE: secure },
  });
  await layer(p, "hack.env.qa.yaml", {
    global: { WIN: secure },
    host: { DELETE: null, EMPTY: null },
  });
  await layer(p, "hack.env.qa.local.yaml", {
    global: { EMPTY: "" },
    web: { DELETE: "" },
  });
  const base = await hostMetadata(p);
  expect(base.hostMetadata?.default?.WIN).toEqual({
    scope: "host",
    secret: false,
  });
  expect(base.hostMetadata?.workloads.web?.WIN).toEqual({
    scope: "host",
    secret: false,
  });
  const result = await hostMetadata(p, {
    overlay: "qa",
    workloadNames: ["web", "job", "inactive"],
  });
  expect(result.hostMetadata?.default?.WIN).toEqual({
    scope: "global",
    secret: true,
  });
  expect(result.hostMetadata?.default?.DELETE).toBeUndefined();
  expect(result.hostMetadata?.workloads.web?.DELETE).toEqual({
    scope: "web",
    secret: false,
  });
  expect(result.hostMetadata?.workloads.web?.EMPTY).toEqual({
    scope: "global",
    secret: false,
  });
  expect(result.hostMetadata?.workloads.job?.JOB).toEqual({
    scope: "job",
    secret: true,
  });
  expect(result.hostMetadata?.workloads.inactive?.INACTIVE).toEqual({
    scope: "inactive",
    secret: true,
  });
  expect(result.hostMetadata?.default?.WEB).toBeUndefined();
  expect(result.hostMetadata?.workloads.web?.PRIVATE_SCOPE).toBeUndefined();
  expect(result.unknownScopes).toEqual(["shell-process"]);
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
});

test("a host-named declared workload disables generic host injection even when not requested", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    global: { WIN: "" },
    web: { WIN: secure },
    host: { WIN: "", HOST: secure },
  });
  const names = ["web", "host", "inactive-job"];
  const result = await hostMetadata(p, {
    declaredWorkloadNames: names,
    workloadNames: ["web", "inactive-job"],
  });
  expect(result.hostMetadata?.default).toEqual({
    WIN: { scope: "global", secret: false },
  });
  expect(result.hostMetadata?.workloads.web).toEqual({
    WIN: { scope: "web", secret: true },
  });
  expect(result.hostMetadata?.workloads["inactive-job"]).toEqual({
    WIN: { scope: "global", secret: false },
  });
  const selected = await hostMetadata(p, {
    declaredWorkloadNames: names,
    workloadNames: ["host"],
  });
  expect(selected.hostMetadata?.workloads.host?.HOST).toEqual({
    scope: "host",
    secret: true,
  });
});

test("host metadata observes all six real worktree layers and explicit base selection", async () => {
  const { primary, checkout } = await linked();
  await layer(checkout, "hack.env.default.yaml", {
    host: { BASE: "", WIN: secure },
  });
  await layer(checkout, "hack.env.qa.yaml", {
    global: { OVERLAY: "", WIN: "" },
  });
  await layer(primary, "hack.env.local.yaml", {
    host: { PRIMARY: "", WIN: secure },
  });
  await layer(primary, "hack.env.qa.local.yaml", {
    global: { PRIMARY_OVERLAY: "", WIN: "" },
  });
  await layer(checkout, "hack.env.local.yaml", {
    host: { CURRENT: "", WIN: secure },
  });
  await layer(checkout, "hack.env.qa.local.yaml", {
    global: { CURRENT_OVERLAY: "", WIN: "" },
  });
  const result = await hostMetadata(checkout, { overlay: "qa" });
  expect(result.hostMetadata?.default?.WIN).toEqual({
    scope: "global",
    secret: false,
  });
  expect(result.hostMetadata?.workloads.web).toEqual(
    result.hostMetadata?.default
  );
  expect(Object.keys(result.hostMetadata?.default ?? {}).sort()).toEqual([
    "BASE",
    "CURRENT",
    "CURRENT_OVERLAY",
    "OVERLAY",
    "PRIMARY",
    "PRIMARY_OVERLAY",
    "WIN",
  ]);
  const base = await hostMetadata(checkout);
  expect(base.hostMetadata?.default?.WIN).toEqual({
    scope: "host",
    secret: true,
  });
  expect(base.hostMetadata?.default?.PRIMARY_OVERLAY).toBeUndefined();
  expect(base.hostMetadata?.default?.CURRENT_OVERLAY).toBeUndefined();
  for (const exclusion of ["optout", "ci", "slim"]) {
    if (exclusion === "ci") {
      process.env.CI = "true";
    }
    if (exclusion === "slim") {
      Reflect.deleteProperty(process.env, "CI");
      process.env.HACK_EXECUTION_MODE = "slim";
    }
    const excluded = await hostMetadata(checkout, {
      overlay: "qa",
      inheritLocal: exclusion !== "optout",
    });
    expect(excluded.hostMetadata?.default?.PRIMARY).toBeUndefined();
    expect(excluded.hostMetadata?.default?.PRIMARY_OVERLAY).toBeUndefined();
    expect(excluded.hostMetadata?.default?.CURRENT).toEqual({
      scope: "host",
      secret: false,
    });
  }
});

test("unknown, duplicate, noncanonical and malformed host requests refuse without disclosure", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", {
    "shell-process": { PRIVATE_SCOPE: secure },
  });
  for (const hostTargets of [
    { includeDefault: true, workloadNames: ["shell-process"] },
    { includeDefault: true, workloadNames: ["web", "web"] },
    { includeDefault: true, workloadNames: ["../secret"] },
    { includeDefault: true, workloadNames: ["Web"] },
    { includeDefault: true, workloadNames: ["a".repeat(64)] },
    { includeDefault: SENTINEL, workloadNames: [] },
    { includeDefault: false, workloadNames: SENTINEL },
    { includeDefault: false, workloadNames: [null] },
    null,
  ]) {
    await refuses(() =>
      Reflect.apply(resolveProjectEnvMetadataForNativeSelection, undefined, [
        {
          projectRoot: p,
          overlay: null,
          inheritLocal: false,
          declaredWorkloadNames: ["web"],
          hostTargets,
        },
      ])
    );
  }
});

test("host requests retain input redaction and cancellation without decrypting", async () => {
  const p = await project();
  await layer(p, "hack.env.default.yaml", { host: { SECRET: secure } });
  expect((await hostMetadata(p)).hostMetadata?.default?.SECRET?.secret).toBe(
    true
  );
  await writeFile(join(p, ".hack/hack.env.qa.yaml"), `invalid: [${SENTINEL}`);
  await refuses(() => hostMetadata(p, { overlay: "qa" }));
  const signal = AbortSignal.abort(SENTINEL);
  await expect(
    resolveProjectEnvMetadataForNativeSelection({
      projectRoot: p,
      overlay: null,
      inheritLocal: false,
      declaredWorkloadNames: ["web"],
      hostTargets: { includeDefault: true, workloadNames: ["web"] },
      signal,
    })
  ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
});

test("only requested host baselines expand and combined guest plus host output is bounded", async () => {
  const p = await project();
  const names = Array.from({ length: 300 }, (_, index) => `workload-${index}`);
  await layer(p, "hack.env.default.yaml", {
    host: Object.fromEntries(
      Array.from({ length: 4000 }, (_, index) => [`HOST_${index}`, secure])
    ),
  });
  const selected = await hostMetadata(p, {
    declaredWorkloadNames: names,
    workloadNames: [names[0] ?? "workload-0"],
    includeDefault: false,
  });
  expect(Object.keys(selected.hostMetadata?.workloads ?? {})).toEqual([
    "workload-0",
  ]);
  expect(
    Object.keys(selected.hostMetadata?.workloads["workload-0"] ?? {})
  ).toHaveLength(4000);
  expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(1024 * 1024);
  await refuses(() =>
    hostMetadata(p, { declaredWorkloadNames: names, workloadNames: names })
  );
  // Guest metadata alone fits; adding the selected host baselines must share its budget.
  await layer(p, "hack.env.default.yaml", {
    global: Object.fromEntries(
      Array.from({ length: 2500 }, (_, index) => [`KEY_${index}`, ""])
    ),
  });
  const fewNames = ["one", "two", "three", "four"];
  expect(
    Buffer.byteLength(JSON.stringify(await metadata(p, null, false, fewNames)))
  ).toBeLessThan(1024 * 1024);
  await refuses(() =>
    hostMetadata(p, {
      declaredWorkloadNames: fewNames,
      workloadNames: fewNames,
    })
  );
});
