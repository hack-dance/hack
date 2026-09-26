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
import {
  resolveProjectEnvConfig,
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";

const roots: string[] = [];
const originalCI = process.env.CI;
const originalMode = process.env.HACK_EXECUTION_MODE;

afterEach(async () => {
  process.env.CI = originalCI;
  process.env.HACK_EXECUTION_MODE = originalMode;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(error);
  }
}

async function config(
  dir: string,
  file: string,
  values: Record<string, unknown>
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

async function fixture() {
  process.env.CI = undefined;
  process.env.HACK_EXECUTION_MODE = undefined;
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-local-env-")));
  roots.push(root);
  const primaryRoot = join(root, "primary");
  const primary = join(primaryRoot, ".hack");
  await mkdir(primary, { recursive: true });
  await writeFile(join(primary, "hack.config.json"), '{"name":"env-fixture"}');
  await config(primary, "hack.env.default.yaml", {
    global: { ORDER: "tracked", TRACKED: "checkout" },
  });
  await config(primary, "hack.env.qa.yaml", {
    global: { ORDER: "tracked-overlay" },
  });
  await git(primaryRoot, ["init", "-b", "main"]);
  await git(primaryRoot, ["add", "."]);
  await git(primaryRoot, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const linkedRoot = join(root, "linked");
  await git(primaryRoot, ["worktree", "add", "-b", "test", linkedRoot]);
  const linked = join(linkedRoot, ".hack");
  const resolve = () =>
    resolveProjectEnvConfig({
      projectRoot: linkedRoot,
      projectDir: linked,
      envName: "qa",
      serviceNames: ["api"],
    });
  return { primary, primaryRoot, linkedRoot, linked, resolve };
}

test("linked env layers observe primary updates without copying or inheriting primary tracked state", async () => {
  const f = await fixture();
  await config(f.primary, "hack.env.default.yaml", {
    global: { TRACKED: "must-not-inherit" },
  });
  await config(f.primary, "hack.env.local.yaml", {
    global: { ORDER: "primary-default", PRIMARY: "first" },
  });
  await config(f.primary, "hack.env.qa.local.yaml", {
    global: { ORDER: "primary-overlay" },
  });
  const before = await readdir(f.primary);
  const content = await readFile(
    join(f.primary, "hack.env.local.yaml"),
    "utf8"
  );
  const resolved = await f.resolve();
  expect(resolved?.globalEnv).toEqual({
    ORDER: "primary-overlay",
    TRACKED: "checkout",
    PRIMARY: "first",
  });
  expect(resolved?.files).toEqual([
    join(f.linked, "hack.env.default.yaml"),
    join(f.linked, "hack.env.qa.yaml"),
    join(f.primary, "hack.env.local.yaml"),
    join(f.primary, "hack.env.qa.local.yaml"),
  ]);
  expect(await readdir(f.primary)).toEqual(before);
  expect(await readFile(join(f.primary, "hack.env.local.yaml"), "utf8")).toBe(
    content
  );
  expect(await Bun.file(join(f.linked, "hack.env.local.yaml")).exists()).toBe(
    false
  );
  await config(f.primary, "hack.env.local.yaml", {
    global: { PRIMARY: "later" },
  });
  expect((await f.resolve())?.globalEnv.PRIMARY).toBe("later");
  await rm(join(f.primary, "hack.env.local.yaml"));
  expect((await f.resolve())?.globalEnv.PRIMARY).toBeUndefined();
});

test("checkout default and overlay win; removing overrides reveals inherited values", async () => {
  const f = await fixture();
  await config(f.primary, "hack.env.qa.local.yaml", {
    global: { ORDER: "primary", REMOVE: "inherited" },
    api: { API_REMOVE: "inherited" },
  });
  await config(f.linked, "hack.env.local.yaml", {
    global: { ORDER: "checkout-default", REMOVE: "checkout" },
    api: { API_REMOVE: "checkout" },
  });
  expect((await f.resolve())?.globalEnv.ORDER).toBe("checkout-default");
  await config(f.linked, "hack.env.qa.local.yaml", {
    global: { ORDER: "checkout-overlay" },
  });
  const resolved = await f.resolve();
  expect(resolved?.globalEnv.ORDER).toBe("checkout-overlay");
  expect(resolved?.globalEnv.REMOVE).toBe("checkout");
  expect(resolved?.serviceEnv.api?.API_REMOVE).toBe("checkout");
  await rm(join(f.linked, "hack.env.local.yaml"));
  expect((await f.resolve())?.serviceEnv.api?.API_REMOVE).toBe("inherited");
});

test("missing primary locals are benign; malformed inherited inputs fail closed unless opted out", async () => {
  const f = await fixture();
  expect((await f.resolve())?.globalEnv.ORDER).toBe("tracked-overlay");
  await writeFile(join(f.primary, "hack.env.local.yaml"), "values: [");
  await expect(f.resolve()).rejects.toThrow("Failed to parse");
  await writeFile(
    join(f.linked, "hack.config.json"),
    '{"name":"env-fixture","worktree":{"inherit_local":false}}'
  );
  expect((await f.resolve())?.globalEnv.ORDER).toBe("tracked-overlay");
});

test("local null tombstones remove inherited globals and scoped values before decryption", async () => {
  const f = await fixture();
  await config(f.primary, "hack.env.local.yaml", {
    global: { REMOVE: "primary", RESTORE: "primary" },
    api: { TOKEN: { secure: "invalid-unused-ciphertext" } },
  });
  await config(f.linked, "hack.env.local.yaml", {
    global: { REMOVE: null, RESTORE: null },
    api: { TOKEN: null },
  });
  await config(f.linked, "hack.env.qa.local.yaml", {
    global: { RESTORE: "last" },
  });
  const resolved = await f.resolve();
  expect(resolved?.globalEnv.REMOVE).toBeUndefined();
  expect(resolved?.serviceEnv.api?.TOKEN).toBeUndefined();
  expect(resolved?.merged.values.api?.TOKEN).toBeUndefined();
  expect(resolved?.globalEnv.RESTORE).toBe("last");
});

test("inherited local symlinks are refused", async () => {
  const f = await fixture();
  await symlink(
    join(f.primary, "hack.env.default.yaml"),
    join(f.primary, "hack.env.local.yaml")
  );
  await expect(f.resolve()).rejects.toThrow();
});

test("local unset masks inherited-only values idempotently and a later set restores", async () => {
  const f = await fixture();
  await config(f.primary, "hack.env.local.yaml", {
    global: { REMOVE: "inherited" },
  });
  const before = await readFile(join(f.primary, "hack.env.local.yaml"), "utf8");
  const options = {
    projectRoot: f.linkedRoot,
    projectDir: f.linked,
    envName: null,
    scope: "global",
    key: "REMOVE",
    local: true,
  };
  expect((await unsetProjectEnvValue(options)).changed).toBe(true);
  expect((await unsetProjectEnvValue(options)).changed).toBe(false);
  expect((await f.resolve())?.globalEnv.REMOVE).toBeUndefined();
  expect(await readFile(join(f.primary, "hack.env.local.yaml"), "utf8")).toBe(
    before
  );
  await setProjectEnvValue({ ...options, value: "restored", secret: false });
  expect((await f.resolve())?.globalEnv.REMOVE).toBe("restored");
});

test("CI and slim execution do not inherit primary local environment", async () => {
  const f = await fixture();
  await config(f.primary, "hack.env.local.yaml", {
    global: { PRIMARY: "not-in-runner" },
  });
  process.env.CI = "true";
  expect((await f.resolve())?.globalEnv.PRIMARY).toBeUndefined();
  process.env.CI = undefined;
  process.env.HACK_EXECUTION_MODE = "slim";
  expect((await f.resolve())?.globalEnv.PRIMARY).toBeUndefined();
});

test("actual CLI masks inherited global secret overriding tracked service plaintext", async () => {
  const f = await fixture();
  await writeFile(
    join(f.linked, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await config(f.linked, "hack.env.default.yaml", {
    api: { TOKEN: "placeholder" },
  });
  const synthetic = "synthetic-inheritance-secret-regression";
  await setProjectEnvValue({
    projectRoot: f.primaryRoot,
    projectDir: f.primary,
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: synthetic,
    secret: true,
    local: true,
  });
  const resolved = await f.resolve();
  expect(resolved?.serviceEnv.api?.TOKEN).toBe(synthetic);
  expect(resolved?.effectiveMetadata.api?.TOKEN).toEqual({
    scope: "global",
    secret: true,
  });
  for (const format of [[], ["--json"], ["--json", "--show-secrets"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "index.ts",
        "env",
        "list",
        "--path",
        f.linkedRoot,
        "--service",
        "api",
        ...format,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HACK_LOGGER: "console" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).not.toContain(synthetic);
    expect(stdout.includes(synthetic)).toBe(format.includes("--show-secrets"));
    if (!format.includes("--show-secrets")) {
      expect(stdout).toContain("***");
    }
  }
});
