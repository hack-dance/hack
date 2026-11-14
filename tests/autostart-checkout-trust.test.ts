import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertAutostartCheckoutTrusted } from "../src/lib/autostart-checkout-trust.ts";
import {
  assertAutostartProjectCurrent,
  withAutostartProjectLock,
} from "../src/lib/autostart-project-lock.ts";
import { quoteShellWord } from "../src/lib/logs.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
let repoRoot = "";
let projectDir = "";
let registryPath = "";
const scope = {
  projectId: "example-id",
  composeProject: "example",
  branch: null,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-checkout-trust-"));
  repoRoot = join(root, "projects", "example");
  projectDir = join(repoRoot, ".hack");
  registryPath = join(root, "home", ".hack", "projects.json");
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "home", ".hack"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "example" })
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: example.invalid/app\n"
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: scope.projectId,
          name: "example",
          repoRoot,
          projectDir,
          projectDirName: ".hack",
          createdAt: "2026-01-01T00:00:00.000Z",
          autostart: {
            branch: null,
            paused: false,
            lastResult: null,
            lastAttemptBootId: null,
          },
        },
      ],
    }),
    { mode: 0o600 }
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("private owned checkout paths remain trusted across owner Git updates", async () => {
  expect(() =>
    assertAutostartCheckoutTrusted({ repoRoot, projectDir })
  ).not.toThrow();
  await mkdir(join(repoRoot, ".git"), { mode: 0o700 });
  await writeFile(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "example",
      lifecycle: { up: { before: ["printf updated"] } },
    })
  );
  await writeFile(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/updated\n");
  expect(() =>
    assertAutostartCheckoutTrusted({ repoRoot, projectDir })
  ).not.toThrow();
});

test("writable startup inputs and symlink targets are refused despite protected directories", async () => {
  for (const name of [
    "hack.config.json",
    "docker-compose.yml",
    "hack.env.default.yaml",
    ".env",
  ]) {
    const input = join(projectDir, name);
    await writeFile(input, "untrusted input", { mode: 0o600 });
    await chmod(input, 0o666);
    expect(() =>
      assertAutostartCheckoutTrusted({ repoRoot, projectDir })
    ).toThrow();
    await chmod(input, 0o600);
  }
  const config = join(projectDir, "hack.config.json");
  const target = join(root, "shared-config.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await chmod(target, 0o666);
  await rm(config);
  await symlink(target, config);
  expect(() =>
    assertAutostartCheckoutTrusted({ repoRoot, projectDir })
  ).toThrow();
  await chmod(target, 0o600);
  expect(() =>
    assertAutostartCheckoutTrusted({ repoRoot, projectDir })
  ).not.toThrow();
});

test("generated internal Compose and branch configuration must also be trusted", async () => {
  for (const directory of [".internal", ".branch"]) {
    const generated = join(projectDir, directory, "example");
    await mkdir(generated, { recursive: true, mode: 0o700 });
    const file = join(generated, "docker-compose.override.yml");
    await writeFile(file, "services: {}", { mode: 0o600 });
    await chmod(file, 0o666);
    expect(() =>
      assertAutostartCheckoutTrusted({ repoRoot, projectDir })
    ).toThrow();
    await chmod(file, 0o600);
    expect(() =>
      assertAutostartCheckoutTrusted({ repoRoot, projectDir })
    ).not.toThrow();
  }
});

test("a real checkout replacement beneath a writable parent is refused without changing permissions", async () => {
  const parent = join(root, "projects");
  await chmod(parent, 0o770);
  await rename(repoRoot, join(parent, "retained-original"));
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "replacement",
      lifecycle: { up: { before: ["printf replacement"] } },
    })
  );
  expect(() =>
    assertAutostartCheckoutTrusted({ repoRoot, projectDir })
  ).toThrow();
  expect((await stat(parent)).mode & 0o777).toBe(0o770);
});

test("writable checkout or project directories and symlink target chains are refused read-only", async () => {
  for (const path of [repoRoot, projectDir]) {
    await chmod(path, 0o770);
    expect(() =>
      assertAutostartCheckoutTrusted({ repoRoot, projectDir })
    ).toThrow();
    expect((await stat(path)).mode & 0o777).toBe(0o770);
    await chmod(path, 0o700);
  }
  const shared = join(root, "shared");
  const target = join(shared, "project-inputs");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(shared, 0o770);
  await rename(projectDir, join(repoRoot, "retained-inputs"));
  await symlink(target, projectDir);
  expect(() =>
    assertAutostartCheckoutTrusted({ repoRoot, projectDir })
  ).toThrow();
  expect((await stat(shared)).mode & 0o777).toBe(0o770);
});

test("checkout trust refusals expose only a fixed reason without paths or OS values", () => {
  try {
    assertAutostartCheckoutTrusted({
      repoRoot: join(root, "missing"),
      projectDir,
    });
    throw new Error("Expected checkout trust refusal");
  } catch (error: unknown) {
    expect(error).toMatchObject({
      code: "E_PERMISSION",
      detail: { reason: "checkout_untrusted" },
    });
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain("ENOENT");
  }
});

test("the locked login admission refuses a replaced checkout before its callback", async () => {
  const parent = join(root, "projects");
  await chmod(parent, 0o770);
  await rename(repoRoot, join(parent, "retained-original"));
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  let callbackRan = false;
  await expect(
    withAutostartProjectLock({
      scope,
      registryPath,
      run: async () => {
        await assertAutostartProjectCurrent({
          scope,
          registryPath,
          expectedRoot: repoRoot,
        });
        callbackRan = true;
      },
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "checkout_untrusted" },
  });
  expect(callbackRan).toBe(false);
});

test("a final pre-start recheck observes checkout trust changes after initial admission", async () => {
  let startRan = false;
  await expect(
    withAutostartProjectLock({
      scope,
      registryPath,
      run: async () => {
        await assertAutostartProjectCurrent({
          scope,
          registryPath,
          expectedRoot: repoRoot,
        });
        await chmod(join(root, "projects"), 0o770);
        await assertAutostartProjectCurrent({
          scope,
          registryPath,
          expectedRoot: repoRoot,
        });
        startRan = true;
      },
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "checkout_untrusted" },
  });
  expect(startRan).toBe(false);
});

test.each([
  "directory",
  "config",
])("source login CLI refuses a writable %s before hooks or engine commands", async (kind) => {
  const hook = join(root, "hook-ran");
  const engine = join(root, "engine-ran");
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "example",
      lifecycle: { up: { before: [`printf ran > ${quoteShellWord(hook)}`] } },
    })
  );
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(engine)}, "ran");\nprocess.exit(99);\n`,
    { mode: 0o700 }
  );
  const unsafe =
    kind === "directory"
      ? join(root, "projects")
      : join(projectDir, "hack.config.json");
  await chmod(unsafe, 0o770);
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("index.ts"),
      "--no-interactive",
      "up",
      "--path",
      repoRoot,
      "-d",
      "--json",
    ],
    {
      cwd: root,
      env: privateCliEnv({
        root,
        home: join(root, "home"),
        env: {
          PATH: bin,
          HACK_AUTOSTART_LOGIN: "1",
          HACK_AUTOSTART_PROJECT_ID: scope.projectId,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stdout + stderr).not.toBe(0);
  expect(stdout + stderr).toContain("checkout_untrusted");
  expect(await Bun.file(hook).exists()).toBe(false);
  expect(await Bun.file(engine).exists()).toBe(false);
  expect((await stat(unsafe)).mode & 0o777).toBe(0o770);
});
