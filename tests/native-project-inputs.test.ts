import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HackCliError, type HackErrorCode } from "../src/lib/cli-result.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "../src/lib/native-config-compiler.ts";
import {
  acquireNativeLocalInputs,
  acquireNativeProjectInput,
} from "../src/lib/native-project-inputs.ts";
import { resolveVerifiedPrimaryWorktreeRoot } from "../src/lib/worktree-local-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const ENV_KEYS = [
  "CI",
  "HACK_EXECUTION_MODE",
  "HACK_HOME",
  "PATH",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "HACK_TEST_PRIVATE_ENV",
] as const;
let root: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of [
    "CI",
    "HACK_EXECUTION_MODE",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-project-inputs-"))
  );
  process.env.HACK_HOME = join(root, "hack-home");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    restoreEnv(key, savedEnv[key]);
  }
  await rm(root, { recursive: true, force: true });
});

async function nativeProject(
  name = "project",
  input: string | Uint8Array = "{}\n"
) {
  const projectRoot = join(root, name);
  await Bun.write(join(projectRoot, ".hack", "hack.project.json"), input);
  return projectRoot;
}

async function git(opts: {
  readonly projectRoot: string;
  readonly args: readonly string[];
}) {
  const child = Bun.spawn(["git", "-C", opts.projectRoot, ...opts.args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`Fixture Git failed: ${error}`);
  }
}

async function linkedFixture() {
  const primaryRoot = await nativeProject("primary");
  await git({
    projectRoot: primaryRoot,
    args: ["init", "--quiet", "-b", "main"],
  });
  await git({
    projectRoot: primaryRoot,
    args: ["add", "--force", ".hack/hack.project.json"],
  });
  await git({
    projectRoot: primaryRoot,
    args: [
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
    ],
  });
  const checkoutRoot = join(root, "linked");
  await git({
    projectRoot: primaryRoot,
    args: ["worktree", "add", "--quiet", "-b", "linked", checkoutRoot],
  });
  return { primaryRoot, checkoutRoot };
}

async function expectRedactedFailure(
  operation: Promise<unknown>,
  code: HackErrorCode = "E_CONFIG_INVALID"
) {
  try {
    await operation;
    throw new Error("Unexpected acquisition success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HackCliError);
    if (!(error instanceof HackCliError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain("authored-canary");
    expect(error.cause).toBeUndefined();
  }
}

test("native discovery returns the exact raw input without JSON decoding or ancestor fallback", async () => {
  await Bun.write(
    join(root, ".hack", "docker-compose.yml"),
    "authored-canary: [\n"
  );
  const input = Uint8Array.from([0xff, 0x00, 0x7b, 0x7d, 0x0a]);
  const projectRoot = await nativeProject("nested/native", input);
  const startDir = join(projectRoot, "src", "nested");
  await mkdir(startDir, { recursive: true });
  const names = await readdir(join(projectRoot, ".hack"));

  const acquired = await acquireNativeProjectInput({ startDir });

  expect(acquired.projectRoot).toBe(projectRoot);
  expect(acquired.input).toEqual(input);
  expect(await readdir(join(projectRoot, ".hack"))).toEqual(names);
  expect(
    await Bun.file(join(process.env.HACK_HOME ?? "", "projects.json")).exists()
  ).toBe(false);
});

for (const family of ["none", "legacy", "nested-legacy"] as const) {
  test(`${family} discovery refuses with a fixed unsupported error`, async () => {
    let startDir = join(root, "selected");
    await mkdir(startDir);
    if (family === "legacy") {
      await Bun.write(
        join(startDir, ".hack", "docker-compose.yml"),
        "authored-canary: ["
      );
    } else if (family === "nested-legacy") {
      const parent = await nativeProject("selected");
      startDir = join(parent, "child");
      await Bun.write(
        join(startDir, ".dev", "docker-compose.yml"),
        "authored-canary: ["
      );
    }
    await expectRedactedFailure(
      acquireNativeProjectInput({ startDir }),
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  });
}

for (const legacyDir of [".hack", ".dev"] as const) {
  test(`native plus ${legacyDir} inputs retain the stable conflict error`, async () => {
    const projectRoot = await nativeProject();
    await Bun.write(
      join(projectRoot, legacyDir, "hack.config.json"),
      "authored-canary: ["
    );
    await expectRedactedFailure(
      acquireNativeProjectInput({ startDir: projectRoot }),
      "E_NATIVE_PROJECT_CONFLICT"
    );
    await expectRedactedFailure(
      acquireNativeLocalInputs({ projectRoot, inheritLocal: false }),
      "E_NATIVE_PROJECT_CONFLICT"
    );
  });
}

for (const kind of [
  "symlink",
  "dangling",
  "directory",
  "fifo",
  "unreadable",
  "oversized",
] as const) {
  test(`native project acquisition rejects ${kind} markers without reading values`, async () => {
    const projectRoot = await nativeProject();
    const file = join(projectRoot, ".hack", "hack.project.json");
    await replaceUnsafeInput({ file, kind });
    await expectRedactedFailure(
      acquireNativeProjectInput({ startDir: projectRoot })
    );
  });
}

test("redirected project roots and Hack directories are refused", async () => {
  const projectRoot = await nativeProject();
  const alias = join(root, "alias");
  await symlink(projectRoot, alias);
  await expectRedactedFailure(acquireNativeProjectInput({ startDir: alias }));
  const redirectedRoot = join(root, "redirected");
  await mkdir(redirectedRoot);
  await symlink(join(projectRoot, ".hack"), join(redirectedRoot, ".hack"));
  await expectRedactedFailure(
    acquireNativeProjectInput({ startDir: redirectedRoot })
  );
  await expectRedactedFailure(
    acquireNativeLocalInputs({
      projectRoot: redirectedRoot,
      inheritLocal: false,
    })
  );
});

test("the exact 1 MiB budget is accepted without allocating an unbounded read", async () => {
  const input = new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT).fill(0x20);
  const projectRoot = await nativeProject("bounded", input);
  expect(
    (await acquireNativeProjectInput({ startDir: projectRoot })).input
  ).toEqual(input);
  await Bun.write(join(projectRoot, ".hack", "hack.local.json"), input);
  expect(
    (await acquireNativeLocalInputs({ projectRoot, inheritLocal: false }))
      .checkoutLocal
  ).toEqual(input);
});

test("missing locals remain absent and checkout null/invalid bytes remain raw", async () => {
  const projectRoot = await nativeProject();
  expect(
    await acquireNativeLocalInputs({ projectRoot, inheritLocal: true })
  ).toEqual({});
  for (const input of [
    new TextEncoder().encode(' {"overlay":null}\n'),
    Uint8Array.from([0xff, 0x00]),
  ]) {
    await Bun.write(join(projectRoot, ".hack", "hack.local.json"), input);
    expect(
      await acquireNativeLocalInputs({ projectRoot, inheritLocal: true })
    ).toEqual({ checkoutLocal: input });
  }
});

test("real linked worktrees acquire both locals, observe edits, and never copy inputs", async () => {
  const { primaryRoot, checkoutRoot } = await linkedFixture();
  const primaryLocal = new TextEncoder().encode(
    ' {"overlay":"primary", "auto_branch":false}\n'
  );
  const checkoutLocal = new TextEncoder().encode(' {"overlay":null}\n');
  await Bun.write(join(primaryRoot, ".hack", "hack.local.json"), primaryLocal);
  expect(
    await resolveVerifiedPrimaryWorktreeRoot({ projectRoot: checkoutRoot })
  ).toBe(primaryRoot);
  expect(
    await resolveVerifiedPrimaryWorktreeRoot({ projectRoot: primaryRoot })
  ).toBeNull();
  const before = await readdir(join(checkoutRoot, ".hack"));
  expect(
    await acquireNativeLocalInputs({
      projectRoot: checkoutRoot,
      inheritLocal: true,
    })
  ).toEqual({ primaryLocal });
  expect(await readdir(join(checkoutRoot, ".hack"))).toEqual(before);
  await Bun.write(
    join(checkoutRoot, ".hack", "hack.local.json"),
    checkoutLocal
  );
  expect(
    await acquireNativeLocalInputs({
      projectRoot: checkoutRoot,
      inheritLocal: true,
    })
  ).toEqual({ primaryLocal, checkoutLocal });
  const updated = new TextEncoder().encode("null\n");
  await Bun.write(join(primaryRoot, ".hack", "hack.local.json"), updated);
  expect(
    await acquireNativeLocalInputs({
      projectRoot: checkoutRoot,
      inheritLocal: true,
    })
  ).toEqual({ primaryLocal: updated, checkoutLocal });
  await rm(join(primaryRoot, ".hack", "hack.local.json"));
  expect(
    await acquireNativeLocalInputs({
      projectRoot: checkoutRoot,
      inheritLocal: true,
    })
  ).toEqual({ checkoutLocal });
});

for (const exclusion of [
  "optout",
  "ci-true",
  "ci-1",
  "slim",
  "codex",
] as const) {
  test(`${exclusion} excludes primary inputs even when the primary family is incompatible`, async () => {
    const { primaryRoot, checkoutRoot } = await linkedFixture();
    await rm(join(primaryRoot, ".hack", "hack.project.json"));
    await Bun.write(
      join(primaryRoot, ".hack", "docker-compose.yml"),
      "authored-canary: ["
    );
    await symlink(
      join(root, "absent"),
      join(primaryRoot, ".hack", "hack.local.json")
    );
    const checkoutLocal = new TextEncoder().encode("null\n");
    await Bun.write(
      join(checkoutRoot, ".hack", "hack.local.json"),
      checkoutLocal
    );
    if (exclusion === "ci-true" || exclusion === "ci-1") {
      process.env.CI = exclusion === "ci-true" ? "true" : "1";
    } else if (exclusion === "slim" || exclusion === "codex") {
      process.env.HACK_EXECUTION_MODE = exclusion;
    }
    expect(
      await acquireNativeLocalInputs({
        projectRoot: checkoutRoot,
        inheritLocal: exclusion !== "optout",
      })
    ).toEqual({ checkoutLocal });
  });
}

for (const family of ["legacy", "conflict", "none"] as const) {
  test(`a ${family} primary family refuses inheritance even when the primary local document is absent`, async () => {
    const { primaryRoot, checkoutRoot } = await linkedFixture();
    if (family !== "conflict") {
      await rm(join(primaryRoot, ".hack", "hack.project.json"));
    }
    if (family !== "none") {
      await Bun.write(
        join(primaryRoot, ".dev", "docker-compose.yml"),
        "authored-canary: ["
      );
    }
    await expectRedactedFailure(
      acquireNativeLocalInputs({
        projectRoot: checkoutRoot,
        inheritLocal: true,
      }),
      family === "conflict"
        ? "E_NATIVE_PROJECT_CONFLICT"
        : "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  });
}

for (const origin of ["primary", "checkout"] as const) {
  for (const kind of [
    "symlink",
    "dangling",
    "directory",
    "fifo",
    "unreadable",
    "oversized",
  ] as const) {
    test(`${origin} local acquisition rejects ${kind} input`, async () => {
      const { primaryRoot, checkoutRoot } = await linkedFixture();
      const file = join(
        origin === "primary" ? primaryRoot : checkoutRoot,
        ".hack",
        "hack.local.json"
      );
      await replaceUnsafeInput({ file, kind });
      await expectRedactedFailure(
        acquireNativeLocalInputs({
          projectRoot: checkoutRoot,
          inheritLocal: true,
        })
      );
    });
  }
}

test("a redirected primary Hack directory fails rather than dropping inherited configuration", async () => {
  const { primaryRoot, checkoutRoot } = await linkedFixture();
  await rm(join(primaryRoot, ".hack"), { recursive: true });
  await symlink(join(checkoutRoot, ".hack"), join(primaryRoot, ".hack"));
  await expectRedactedFailure(
    acquireNativeLocalInputs({ projectRoot: checkoutRoot, inheritLocal: true })
  );
});

test("a native subdirectory acquires only its own local input instead of ancestor worktree inheritance", async () => {
  const { primaryRoot, checkoutRoot } = await linkedFixture();
  const projectRoot = join(checkoutRoot, "subproject");
  await Bun.write(join(projectRoot, ".hack", "hack.project.json"), "{}\n");
  await Bun.write(
    join(primaryRoot, ".hack", "hack.local.json"),
    "authored-canary\n"
  );
  const checkoutLocal = new TextEncoder().encode("null\n");
  await Bun.write(join(projectRoot, ".hack", "hack.local.json"), checkoutLocal);
  expect(
    await acquireNativeLocalInputs({ projectRoot, inheritLocal: true })
  ).toEqual({ checkoutLocal });
  expect(
    await acquireNativeLocalInputs({ projectRoot, inheritLocal: false })
  ).toEqual({ checkoutLocal });
});

test("a copied worktree Git pointer cannot enroll an unrelated native project", async () => {
  const { checkoutRoot } = await linkedFixture();
  const projectRoot = await nativeProject("forged");
  await copyFile(join(checkoutRoot, ".git"), join(projectRoot, ".git"));
  await expectRedactedFailure(
    acquireNativeLocalInputs({ projectRoot, inheritLocal: true })
  );
});

test("the primary actual Git root must match its administrative-directory parent", async () => {
  const { primaryRoot, checkoutRoot } = await linkedFixture();
  const alienRoot = await nativeProject("alien");
  await git({
    projectRoot: primaryRoot,
    args: ["config", "extensions.worktreeConfig", "true"],
  });
  await git({
    projectRoot: primaryRoot,
    args: ["config", "--worktree", "core.worktree", alienRoot],
  });
  await expectRedactedFailure(
    acquireNativeLocalInputs({ projectRoot: checkoutRoot, inheritLocal: true })
  );
});

test("caller Git redirection cannot choose a foreign primary", async () => {
  const { primaryRoot, checkoutRoot } = await linkedFixture();
  const foreignRoot = await nativeProject("foreign");
  await git({ projectRoot: foreignRoot, args: ["init", "--quiet"] });
  const primaryLocal = new TextEncoder().encode("null\n");
  await Bun.write(join(primaryRoot, ".hack", "hack.local.json"), primaryLocal);
  process.env.GIT_DIR = join(foreignRoot, ".git");
  process.env.GIT_COMMON_DIR = join(foreignRoot, ".git");
  process.env.GIT_WORK_TREE = checkoutRoot;
  expect(
    await acquireNativeLocalInputs({
      projectRoot: checkoutRoot,
      inheritLocal: true,
    })
  ).toEqual({ primaryLocal });
});

test("unavailable Git fails for declared linkage and remains optional for standalone projects", async () => {
  const { checkoutRoot } = await linkedFixture();
  const standalone = await nativeProject("standalone");
  process.env.PATH = join(root, "empty-path");
  await expectRedactedFailure(
    acquireNativeLocalInputs({ projectRoot: checkoutRoot, inheritLocal: true })
  );
  expect(
    await acquireNativeLocalInputs({
      projectRoot: standalone,
      inheritLocal: true,
    })
  ).toEqual({});
});

test("native Git inspection does not inherit unrelated private runtime variables", async () => {
  const { primaryRoot, checkoutRoot } = await linkedFixture();
  const realGit = Bun.which("git");
  if (!realGit) {
    throw new Error("Fixture Git is unavailable");
  }
  await fakeGit(`
if (Object.hasOwn(process.env, "HACK_TEST_PRIVATE_ENV")) process.exit(73);
const child = Bun.spawn([${JSON.stringify(realGit)}, ...process.argv.slice(2)], {
  env: process.env, stdin: "ignore", stdout: "inherit", stderr: "ignore"
});
process.exit(await child.exited);
`);
  process.env.HACK_TEST_PRIVATE_ENV = "synthetic-private-runtime-canary";
  const primaryLocal = new TextEncoder().encode("null\n");
  await Bun.write(join(primaryRoot, ".hack", "hack.local.json"), primaryLocal);
  expect(
    await acquireNativeLocalInputs({
      projectRoot: checkoutRoot,
      inheritLocal: true,
    })
  ).toEqual({ primaryLocal });
});

test("oversized Git output fails promptly and reaps the inspection process", async () => {
  const projectRoot = await nativeProject();
  await mkdir(join(projectRoot, ".git"));
  const pidFile = join(root, "inspection.pid");
  await fakeGit(`
await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write("x".repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
`);
  await expectRedactedFailure(
    acquireNativeLocalInputs({ projectRoot, inheritLocal: true })
  );
  await expectInspectionReaped(pidFile);
});

test("cancelled acquisition preserves its fixed compiler cancellation code", async () => {
  const controller = new AbortController();
  controller.abort();
  const projectRoot = await nativeProject();
  for (const operation of [
    acquireNativeProjectInput({
      startDir: projectRoot,
      signal: controller.signal,
    }),
    acquireNativeLocalInputs({
      projectRoot,
      inheritLocal: true,
      signal: controller.signal,
    }),
  ]) {
    await expect(operation).rejects.toBeInstanceOf(NativeConfigCompilerError);
    await expect(operation).rejects.toHaveProperty(
      "code",
      "E_COMPILER_CANCELLED"
    );
  }
});

test("Git acquisition cancellation kills and reaps its owned inspection", async () => {
  const projectRoot = await nativeProject();
  await mkdir(join(projectRoot, ".git"));
  const pidFile = join(root, "inspection.pid");
  await fakeGit(`
await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const result = acquireNativeLocalInputs({
    projectRoot,
    inheritLocal: true,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  for (
    let attempt = 0;
    attempt < 200 && !(await Bun.file(pidFile).exists());
    attempt += 1
  ) {
    await Bun.sleep(5);
  }
  expect(await Bun.file(pidFile).exists()).toBe(true);
  controller.abort();
  const error = await result;
  expect(error).toBeInstanceOf(NativeConfigCompilerError);
  expect(error).toHaveProperty("code", "E_COMPILER_CANCELLED");
  expect(String(error)).not.toContain(root);
  await expectInspectionReaped(pidFile);
});

test("acquisition ignores environment and generated state paths and never creates registration", async () => {
  const projectRoot = await nativeProject();
  await mkdir(join(projectRoot, ".hack", ".env"));
  await symlink(
    join(root, "absent-state"),
    join(projectRoot, ".hack", ".internal")
  );
  await mkdir(join(projectRoot, ".hack", "hack.env.local.yaml"));
  const before = await readdir(join(projectRoot, ".hack"));
  expect(
    await acquireNativeLocalInputs({ projectRoot, inheritLocal: true })
  ).toEqual({});
  expect(
    (await acquireNativeProjectInput({ startDir: projectRoot })).input
  ).toEqual(new TextEncoder().encode("{}\n"));
  expect(await readdir(join(projectRoot, ".hack"))).toEqual(before);
  expect(
    await Bun.file(join(process.env.HACK_HOME ?? "", "projects.json")).exists()
  ).toBe(false);
});

async function replaceUnsafeInput(opts: {
  readonly file: string;
  readonly kind:
    | "symlink"
    | "dangling"
    | "directory"
    | "fifo"
    | "unreadable"
    | "oversized";
}) {
  await rm(opts.file, { force: true });
  if (opts.kind === "symlink") {
    const target = join(root, "redirected-document");
    await Bun.write(target, "authored-canary\n");
    await symlink(target, opts.file);
  } else if (opts.kind === "dangling") {
    await symlink(join(root, "absent-document"), opts.file);
  } else if (opts.kind === "directory") {
    await mkdir(opts.file);
  } else if (opts.kind === "fifo") {
    const child = Bun.spawn(["mkfifo", opts.file], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
  } else if (opts.kind === "unreadable") {
    await Bun.write(opts.file, "authored-canary\n");
    await chmod(opts.file, 0);
  } else {
    await Bun.write(opts.file, new Uint8Array(NATIVE_CONFIG_INPUT_LIMIT + 1));
  }
}

async function fakeGit(script: string): Promise<void> {
  const binary = join(root, "bin", "git");
  await Bun.write(binary, `#!${process.execPath}\n${script}`);
  await chmod(binary, 0o700);
  process.env.PATH = join(root, "bin");
}

async function expectInspectionReaped(pidFile: string): Promise<void> {
  const pid = Number(await Bun.file(pidFile).text());
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
}
