import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  inspectProjectEnvMaterialization,
  materializeProjectEnv,
  projectEnvConfigExists,
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { resolvePrimaryLocalProjectDir } from "../src/lib/worktree-local-config.ts";

const tempDirs = new Set<string>();
const envKeys = [
  "CI",
  "HACK_EXECUTION_MODE",
  "HACK_WORKTREE_INHERIT_LOCAL",
  "HACK_ENV_SECRET_KEY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "PATH",
];
let savedEnv: Array<string | undefined> = [];

beforeEach(() => {
  savedEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys.slice(0, 4)) {
    delete process.env[key];
  }
  // Isolate the code under test from host Git configuration as well.
  Object.assign(process.env, gitIsolationEnv);
});

afterEach(async () => {
  for (const [index, key] of envKeys.entries()) {
    const value = savedEnv[index];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

const gitIsolationEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, args: string[]): Promise<void> {
  const isolation = [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "init.templateDir=",
  ];
  const result = Bun.spawnSync(["git", "-C", cwd, ...isolation, ...args], {
    env: { ...process.env, ...gitIsolationEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

async function writeLayer(
  root: string,
  name: string,
  values: Record<string, unknown>
): Promise<void> {
  await writeFile(
    resolve(root, ".hack", `hack.env.${name}.yaml`),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: values },
    })
  );
}

async function fixture(opts: { readonly nested?: string } = {}) {
  const sandbox = await realpath(
    await mkdtemp(resolve(tmpdir(), "hack-env-local-test-"))
  );
  tempDirs.add(sandbox);
  const primary = resolve(sandbox, opts.nested ?? "", "primary");
  const linked = resolve(sandbox, opts.nested ?? "", "linked");
  await mkdir(resolve(primary, ".hack"), { recursive: true });
  await writeFile(resolve(primary, ".hack", "hack.config.json"), "{}");
  await writeFile(
    resolve(primary, ".hack", ".gitignore"),
    "hack.env.local.yaml\nhack.env.*.local.yaml\n"
  );
  await writeLayer(primary, "default", {
    ORDER: "fake-tracked-base",
    BASE: "fake-base",
  });
  await writeLayer(primary, "qa", { ORDER: "fake-tracked-overlay" });
  await git(primary, ["init", "-b", "main"]);
  await git(primary, ["add", "."]);
  await git(primary, [
    "-c",
    "user.name=Env Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await git(primary, ["worktree", "add", "-b", "test-local", linked]);
  await writeLayer(primary, "local", {
    ORDER: "fake-primary-base",
    PRIMARY_BASE: "fake-primary-base",
  });
  await writeLayer(primary, "qa.local", {
    ORDER: "fake-primary-overlay",
    PRIMARY_OVERLAY: "fake-primary-overlay",
  });
  const options = {
    projectRoot: linked,
    projectDir: resolve(linked, ".hack"),
    envName: "qa",
    serviceNames: ["api"],
  };
  return { sandbox, primary, linked, options };
}

/** Hash project files and paths, excluding Git bookkeeping, to detect any read-time writes. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const path = resolve(entry.parentPath, entry.name);
    if (path.startsWith(resolve(root, ".git"))) {
      continue;
    }
    files[path] = entry.isFile()
      ? createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      : "directory";
  }
  return files;
}

test("linked worktrees inherit live primary base and overlay without writing files", async () => {
  const { primary, linked, options } = await fixture();
  const before = await Promise.all([snapshot(primary), snapshot(linked)]);
  const resolved = await resolveProjectEnvConfig(options);
  expect(resolved?.globalEnv).toEqual({
    BASE: "fake-base",
    ORDER: "fake-primary-overlay",
    PRIMARY_BASE: "fake-primary-base",
    PRIMARY_OVERLAY: "fake-primary-overlay",
  });
  expect(resolved?.serviceEnv.api).toEqual(resolved?.globalEnv);
  expect(resolved?.files).toEqual([
    resolve(linked, ".hack/hack.env.default.yaml"),
    resolve(linked, ".hack/hack.env.qa.yaml"),
    resolve(primary, ".hack/hack.env.local.yaml"),
    resolve(primary, ".hack/hack.env.qa.local.yaml"),
  ]);
  expect(await Promise.all([snapshot(primary), snapshot(linked)])).toEqual(
    before
  );
  await writeLayer(primary, "qa.local", { ORDER: "fake-live-update" });
  expect((await resolveProjectEnvConfig(options))?.globalEnv.ORDER).toBe(
    "fake-live-update"
  );
});

test("each local layer overrides preceding layers and local writes stay in the checkout", async () => {
  const { primary, linked, options } = await fixture();
  const primaryBefore = await snapshot(primary);
  await writeLayer(linked, "local", { ORDER: "fake-checkout-base" });
  expect((await resolveProjectEnvConfig(options))?.globalEnv.ORDER).toBe(
    "fake-checkout-base"
  );
  await setProjectEnvValue({
    ...options,
    local: true,
    scope: "global",
    key: "ORDER",
    value: "fake-checkout-overlay",
    secret: false,
  });
  const resolved = await resolveProjectEnvConfig(options);
  expect(resolved?.globalEnv.ORDER).toBe("fake-checkout-overlay");
  expect(resolved?.files.slice(-2)).toEqual([
    resolve(linked, ".hack/hack.env.local.yaml"),
    resolve(linked, ".hack/hack.env.qa.local.yaml"),
  ]);
  expect(await snapshot(primary)).toEqual(primaryBefore);
});

test.each([
  ["CI", "1"],
  ["CI", "true"],
  ["HACK_EXECUTION_MODE", "codex"],
  ["HACK_EXECUTION_MODE", "slim"],
  ["HACK_WORKTREE_INHERIT_LOCAL", "0"],
  ["HACK_WORKTREE_INHERIT_LOCAL", "false"],
  ["HACK_WORKTREE_INHERIT_LOCAL", "off"],
  ["HACK_WORKTREE_INHERIT_LOCAL", "no"],
])("%s=%s disables primary inheritance", async (key, value) => {
  const { linked, options } = await fixture();
  process.env[key] = value;
  await writeLayer(linked, "local", { CHECKOUT_ONLY: "fake-checkout" });
  const resolved = await resolveProjectEnvConfig(options);
  expect(resolved?.globalEnv).toEqual({
    BASE: "fake-base",
    ORDER: "fake-tracked-overlay",
    CHECKOUT_ONLY: "fake-checkout",
  });
  expect(resolved?.files).toHaveLength(3);
});

test.each([
  "inherit_local",
  "inheritLocal",
])("worktree.%s=false disables primary inheritance", async (key) => {
  const { linked, options } = await fixture();
  await writeFile(
    resolve(linked, ".hack/hack.config.json"),
    JSON.stringify({ worktree: { [key]: false } })
  );
  expect((await resolveProjectEnvConfig(options))?.globalEnv).toEqual({
    BASE: "fake-base",
    ORDER: "fake-tracked-overlay",
  });
});

test("primary checkout keeps its own local behavior", async () => {
  const { primary, options } = await fixture();
  const resolved = await resolveProjectEnvConfig({
    ...options,
    projectRoot: primary,
    projectDir: resolve(primary, ".hack"),
  });
  expect(resolved?.globalEnv.ORDER).toBe("fake-primary-overlay");
  expect(resolved?.files).toHaveLength(4);
});

test.each([
  "local",
  "qa.local",
])("rejects symlinked primary %s files", async (name) => {
  const { sandbox, primary, options } = await fixture();
  const path = resolve(primary, ".hack", `hack.env.${name}.yaml`);
  const target = resolve(sandbox, "redirected.yaml");
  await rename(path, target);
  await symlink(target, path);
  await expect(resolveProjectEnvConfig(options)).rejects.toThrow(
    `Refusing redirected or non-regular primary local env file: ${path}`
  );
});

test("ignores a symlinked primary project directory", async () => {
  const { primary, options, sandbox } = await fixture();
  const target = resolve(sandbox, "redirected-project");
  await rename(resolve(primary, ".hack"), target);
  await symlink(target, resolve(primary, ".hack"));
  expect((await resolveProjectEnvConfig(options))?.globalEnv.ORDER).toBe(
    "fake-tracked-overlay"
  );
});

test("rejects non-regular primary local files before reading", async () => {
  const { primary, options } = await fixture();
  const path = resolve(primary, ".hack/hack.env.local.yaml");
  await rm(path);
  await mkdir(path);
  await expect(resolveProjectEnvConfig(options)).rejects.toThrow(
    `Refusing redirected or non-regular primary local env file: ${path}`
  );
});

test("does not inherit through a Git directory outside common-dir/worktrees", async () => {
  const { sandbox, primary, linked, options } = await fixture();
  const redirected = resolve(sandbox, "gitdir");
  await rename(resolve(primary, ".git/worktrees/linked"), redirected);
  await writeFile(resolve(redirected, "commondir"), resolve(primary, ".git"));
  await writeFile(resolve(linked, ".git"), `gitdir: ${redirected}\n`);
  expect((await resolveProjectEnvConfig(options))?.globalEnv.ORDER).toBe(
    "fake-tracked-overlay"
  );
});

test("legacy tracked local overlays inherit only the compatible local default", async () => {
  const { primary, linked, options } = await fixture();
  await git(primary, ["add", "-f", ".hack/hack.env.local.yaml"]);
  await git(primary, [
    "-c",
    "user.name=Env Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "legacy fixture",
  ]);
  await git(linked, ["merge", "--ff-only", "main"]);
  await writeLayer(primary, "default.local", {
    ORDER: "fake-compatible-local",
  });
  const resolved = await resolveProjectEnvConfig({ ...options, envName: null });
  expect(resolved?.globalEnv.ORDER).toBe("fake-compatible-local");
  expect(resolved?.globalEnv.PRIMARY_BASE).toBeUndefined();
  expect(resolved?.files).toContain(
    resolve(primary, ".hack/hack.env.default.local.yaml")
  );
  expect(resolved?.files).not.toContain(
    resolve(primary, ".hack/hack.env.local.yaml")
  );
});

test("inherited-only config is sufficient and absent primary files create nothing", async () => {
  const { primary, linked, options } = await fixture();
  for (const root of [primary, linked]) {
    await rm(resolve(root, ".hack/hack.env.default.yaml"));
    await rm(resolve(root, ".hack/hack.env.qa.yaml"));
  }
  expect((await resolveProjectEnvConfig(options))?.globalEnv.ORDER).toBe(
    "fake-primary-overlay"
  );
  await rm(resolve(primary, ".hack/hack.env.local.yaml"));
  await rm(resolve(primary, ".hack/hack.env.qa.local.yaml"));
  const before = await Promise.all([snapshot(primary), snapshot(linked)]);
  expect(await resolveProjectEnvConfig(options)).toBeNull();
  expect(await Promise.all([snapshot(primary), snapshot(linked)])).toEqual(
    before
  );
});

test("materialization consumes inherited inputs and notices primary changes", async () => {
  const { primary, options } = await fixture();
  await materializeProjectEnv(options);
  expect(await readFile(resolve(options.projectDir, ".env"), "utf8")).toContain(
    "ORDER=fake-primary-overlay"
  );
  expect((await inspectProjectEnvMaterialization(options)).status).toBe("ok");
  await writeLayer(primary, "local", { PRIMARY_BASE: "fake-updated-base" });
  const inspected = await inspectProjectEnvMaterialization(options);
  expect(inspected.status).toBe("warn");
  expect(inspected.message).toContain("changed since materialization");
});

test("inherited secure values use existing primary key fallback", async () => {
  const { primary, options } = await fixture();
  await setProjectEnvValue({
    projectRoot: primary,
    projectDir: resolve(primary, ".hack"),
    envName: null,
    local: true,
    scope: "global",
    key: "FAKE_SECURE",
    value: "fake-test-only-value",
    secret: true,
  });
  const before = await snapshot(primary);
  expect((await resolveProjectEnvConfig(options))?.globalEnv.FAKE_SECURE).toBe(
    "fake-test-only-value"
  );
  expect(await snapshot(primary)).toEqual(before);
});

test("unreadable primary local files fail closed without exposing contents", async () => {
  if (process.getuid?.() === 0) {
    return;
  }
  const { primary, options } = await fixture();
  const path = resolve(primary, ".hack/hack.env.qa.local.yaml");
  await chmod(path, 0o000);
  try {
    const error = await resolveProjectEnvConfig(options).then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Cannot read primary local env file: ${path}`
    );
  } finally {
    await chmod(path, 0o600);
  }
});

async function runHack(cwd: string, args: string[], sandbox: string) {
  const proc = Bun.spawn(
    ["bun", resolve(import.meta.dir, "../index.ts"), ...args],
    {
      cwd,
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: resolve(sandbox, "global.config.json"),
        HACK_NO_INTERACTIVE: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

test("env set/unset --local in an inherited-only worktree edit only checkout YAML", async () => {
  const { sandbox, primary, linked } = await fixture();
  for (const root of [primary, linked]) {
    await rm(resolve(root, ".hack/hack.env.default.yaml"));
    await rm(resolve(root, ".hack/hack.env.qa.yaml"));
  }
  await writeFile(
    resolve(linked, ".hack/docker-compose.yml"),
    "services:\n  api:\n    image: busybox\n"
  );
  const primaryBefore = await snapshot(primary);
  const localPath = resolve(linked, ".hack/hack.env.local.yaml");

  const set = await runHack(
    linked,
    ["env", "set", "--local", "FAKE_CLI", "fake-cli-value"],
    sandbox
  );
  expect(set.output).not.toContain("fake-cli-value");
  expect(set.exitCode).toBe(0);
  expect(await readFile(localPath, "utf8")).toContain("FAKE_CLI");
  expect(await readdir(resolve(linked, ".hack"))).not.toContain(".env");
  expect(await snapshot(primary)).toEqual(primaryBefore);

  const unset = await runHack(
    linked,
    ["env", "unset", "--local", "FAKE_CLI"],
    sandbox
  );
  expect(unset.exitCode).toBe(0);
  expect(await readFile(localPath, "utf8")).not.toContain("FAKE_CLI");
  expect(await readdir(resolve(linked, ".hack"))).not.toContain(".env");
  expect(await snapshot(primary)).toEqual(primaryBefore);
}, 30_000);

test.each([
  "removed",
  "opted-out",
])("materialization from inherited-only inputs is stale once %s", async (mode) => {
  const { primary, linked, options } = await fixture();
  for (const root of [primary, linked]) {
    await rm(resolve(root, ".hack/hack.env.default.yaml"));
    await rm(resolve(root, ".hack/hack.env.qa.yaml"));
  }
  await materializeProjectEnv(options);
  expect((await inspectProjectEnvMaterialization(options)).status).toBe("ok");
  if (mode === "removed") {
    await rm(resolve(primary, ".hack/hack.env.local.yaml"));
    await rm(resolve(primary, ".hack/hack.env.qa.local.yaml"));
  } else {
    process.env.HACK_WORKTREE_INHERIT_LOCAL = "0";
  }
  expect(await resolveProjectEnvConfig(options)).toBeNull();
  const inspected = await inspectProjectEnvMaterialization(options);
  expect(inspected.status).toBe("warn");
  expect(inspected.message).toContain("no env inputs remain; materialized");
});

/** Put a logging `git` shim first on PATH to count subprocesses. */
async function countGitCalls(sandbox: string): Promise<() => Promise<number>> {
  const realGit = Bun.which("git");
  if (!realGit) {
    throw new Error("git is required for this test");
  }
  const bin = resolve(sandbox, "bin");
  const log = resolve(sandbox, "git-calls.log");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "");
  await writeFile(
    resolve(bin, "git"),
    `#!/bin/sh\necho call >> "${log}"\nexec "${realGit}" "$@"\n`
  );
  await chmod(resolve(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return async () =>
    (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
}

test("opt-outs skip all Git work and verification uses three Git calls", async () => {
  const { sandbox, primary, linked, options } = await fixture();
  const calls = await countGitCalls(sandbox);
  process.env.HACK_WORKTREE_INHERIT_LOCAL = "0";
  expect(await resolvePrimaryLocalProjectDir(options)).toBeNull();
  Reflect.deleteProperty(process.env, "HACK_WORKTREE_INHERIT_LOCAL");
  const configPath = resolve(linked, ".hack/hack.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ worktree: { inherit_local: false } })
  );
  expect(await resolvePrimaryLocalProjectDir(options)).toBeNull();
  expect(await calls()).toBe(0);
  await writeFile(configPath, "{}");
  expect(await resolvePrimaryLocalProjectDir(options)).toBe(
    resolve(primary, ".hack")
  );
  expect(await calls()).toBe(3);
});

const runningAsRoot = process.getuid?.() === 0;

test.skipIf(runningAsRoot)(
  "inaccessible primary project directories fail closed with the path only",
  async () => {
    const { primary, options } = await fixture();
    const dir = resolve(primary, ".hack");
    await chmod(dir, 0o000);
    try {
      await expect(resolveProjectEnvConfig(options)).rejects.toThrow(
        `Cannot read primary local env file: ${resolve(dir, "hack.env.local.yaml")}`
      );
    } finally {
      await chmod(dir, 0o755);
    }
  }
);

test.skipIf(runningAsRoot).each(["hack.config.json", "hack.toml"])(
  "unreadable %s fails closed before any Git work",
  async (name) => {
    const { sandbox, linked, options } = await fixture();
    const path = resolve(linked, ".hack", name);
    if (name === "hack.toml") {
      await rm(resolve(linked, ".hack/hack.config.json"));
      await writeFile(path, "[worktree]\ninherit_local = false\n");
    } else {
      await writeFile(
        path,
        JSON.stringify({ worktree: { inherit_local: false } })
      );
    }
    await chmod(path, 0o000);
    const calls = await countGitCalls(sandbox);
    try {
      await expect(resolveProjectEnvConfig(options)).rejects.toThrow(
        `Cannot read project config: ${path}`
      );
      expect(await calls()).toBe(0);
    } finally {
      await chmod(path, 0o644);
    }
  }
);

test.each([
  "symlink",
  "directory",
])("a %s-only primary overlay routes env set --local to YAML commands", async (kind) => {
  const { sandbox, primary, linked } = await fixture();
  for (const root of [primary, linked]) {
    await rm(resolve(root, ".hack/hack.env.default.yaml"));
    await rm(resolve(root, ".hack/hack.env.qa.yaml"));
  }
  await rm(resolve(primary, ".hack/hack.env.qa.local.yaml"));
  const overlay = resolve(primary, ".hack/hack.env.local.yaml");
  if (kind === "symlink") {
    const target = resolve(sandbox, "redirected.yaml");
    await rename(overlay, target);
    await symlink(target, overlay);
  } else {
    await rm(overlay);
    await mkdir(overlay);
  }
  await writeFile(
    resolve(linked, ".hack/docker-compose.yml"),
    "services:\n  api:\n    image: busybox\n"
  );
  expect(
    await projectEnvConfigExists({ projectDir: resolve(linked, ".hack") })
  ).toBe(true);
  const primaryBefore = await snapshot(primary);
  for (const args of [
    ["env", "set", "--local", "FAKE_CLI", "fake-cli-value"],
    ["env", "unset", "--local", "FAKE_CLI"],
  ]) {
    const result = await runHack(linked, args, sandbox);
    expect(result.output).not.toContain("fake-cli-value");
    expect(await readdir(resolve(linked, ".hack"))).not.toContain(".env");
    if (result.exitCode !== 0) {
      expect(result.output).toContain(
        `Refusing redirected or non-regular primary local env file: ${overlay}`
      );
    }
  }
  expect(await snapshot(primary)).toEqual(primaryBefore);
}, 30_000);

test("newline-containing checkout paths cleanly disable inheritance", async () => {
  const { primary, linked, options } = await fixture({ nested: "line\nbreak" });
  const before = await Promise.all([snapshot(primary), snapshot(linked)]);
  const resolved = await resolveProjectEnvConfig(options);
  expect(resolved?.globalEnv).toEqual({
    BASE: "fake-base",
    ORDER: "fake-tracked-overlay",
  });
  expect(await Promise.all([snapshot(primary), snapshot(linked)])).toEqual(
    before
  );
});
