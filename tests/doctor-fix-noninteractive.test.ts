import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GLOBAL_DAEMON_DIR_NAME,
  GLOBAL_DAEMON_PID_FILENAME,
  GLOBAL_HACK_DIR_NAME,
} from "../src/constants.ts";
import {
  renderComposeEnvReferenceOverride,
  renderManagedComposeEnvOverride,
} from "../src/lib/compose-managed-env.ts";
import { resetNoInteractiveFlagForTests } from "../src/lib/interactivity.ts";
import { restoreEnv } from "./helpers/env.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

/**
 * Verifies `hack doctor --fix` under `HACK_NO_INTERACTIVE=1`:
 * - safe remediations (stale daemon pid/socket cleanup) apply automatically
 *   without prompting,
 * - destructive/system-level remediations (macOS System keychain repair)
 *   are skipped with a printed note instead of hanging on a prompt.
 *
 * Follows the module-mock pattern from tests/global-command.macos.test.ts.
 */

const runCalls: string[][] = [];
const execCalls: string[][] = [];
const noteCalls: string[] = [];
/**
 * Paths the mocked `git ls-files` reports as tracked generated files. Empty by
 * default, so the untrack step stays idle unless a test sets it.
 */
let trackedGeneratedPaths: string[] = [];

const dnsMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "node:dns/promises",
  overrides: {
    lookup: async () => {
      // Exercise missing-DNS remediation without depending on host resolvers.
      throw new Error("Fixture DNS is not configured");
    },
  },
});

const clackMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "@clack/prompts",
  overrides: {
    confirm: async () => {
      throw new Error(
        "confirm() must not be called under HACK_NO_INTERACTIVE=1"
      );
    },
    isCancel: () => false,
    note: (message: string) => {
      noteCalls.push(message);
    },
    spinner: () => ({
      start: () => {},
      stop: () => {},
    }),
  },
});

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      if (cmd[0] === "docker" && cmd[1] === "info") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "docker" && cmd[1] === "network" && cmd[2] === "inspect") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      // The fixture project root counts as a git work tree for the
      // `.hack/.gitignore` doctor step (probed from the root, so a symlinked
      // `.hack` is not followed); every other git probe stays absent.
      if (
        cmd[0] === "git" &&
        cmd.at(-1) === "--is-inside-work-tree" &&
        typeof cmd[2] === "string" &&
        cmd[2].endsWith("/project")
      ) {
        return { exitCode: 0, stdout: "true\n", stderr: "" };
      }
      if (cmd[0] === "git" && cmd[3] === "ls-files") {
        return {
          exitCode: 0,
          stdout: trackedGeneratedPaths.map((path) => `${path}\0`).join(""),
          stderr: "",
        };
      }
      if (cmd[0] === "git" && cmd[3] === "rm" && cmd[4] === "--cached") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    },
    execOrThrow: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    run: async (cmd: readonly string[]) => {
      runCalls.push([...cmd]);
      return 0;
    },
    findExecutableInPath: (name?: string) => {
      if (name === "hack" || name === "bun" || name === "docker") {
        return `/usr/local/bin/${name}`;
      }
      return null;
    },
    CommandError: class CommandError extends Error {},
  },
});

const osMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/os.ts",
  overrides: {
    isMac: () => true,
    isLinux: () => false,
    openUrl: async () => 0,
  },
});

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalNoInteractive: string | undefined;
let originalMutagenPath: string | undefined;
let originalLogger: string | undefined;

beforeAll(() => {
  dnsMock.activate();
  clackMock.activate();
  shellMock.activate();
  osMock.activate();
});

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalNoInteractive = process.env.HACK_NO_INTERACTIVE;
  originalMutagenPath = process.env.HACK_MUTAGEN_PATH;
  originalLogger = process.env.HACK_LOGGER;
  tempDir = await mkdtemp(join(tmpdir(), "hack-doctor-fix-"));
  process.env.HOME = tempDir;
  process.env.HACK_NO_INTERACTIVE = "1";
  // Short-circuit mutagen path resolution so the fix flow never attempts a
  // real network install.
  process.env.HACK_MUTAGEN_PATH = "/usr/local/bin/mutagen";
  process.env.HACK_LOGGER = "console";
  runCalls.length = 0;
  execCalls.length = 0;
  noteCalls.length = 0;
  trackedGeneratedPaths = [];
});

afterEach(async () => {
  resetNoInteractiveFlagForTests();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  restoreEnv("HOME", originalHome);
  if (originalNoInteractive === undefined) {
    Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  } else {
    process.env.HACK_NO_INTERACTIVE = originalNoInteractive;
  }
  if (originalMutagenPath === undefined) {
    Reflect.deleteProperty(process.env, "HACK_MUTAGEN_PATH");
  } else {
    process.env.HACK_MUTAGEN_PATH = originalMutagenPath;
  }
  restoreEnv("HACK_LOGGER", originalLogger);
});

afterAll(() => {
  dnsMock.deactivate();
  clackMock.deactivate();
  shellMock.deactivate();
  osMock.deactivate();
});

async function createProjectWithStaleDaemonPid(): Promise<string> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const projectRoot = resolve(tempDir, "project");
  await mkdir(resolve(projectRoot, ".hack"), { recursive: true });
  await writeFile(
    resolve(projectRoot, ".hack", "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n"
  );

  // Stale daemon pid: a pid that cannot be running (very large, unlikely to
  // exist) with no socket file, so buildDaemonStatusReport resolves "stale".
  const daemonDir = resolve(
    tempDir,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_DAEMON_DIR_NAME
  );
  await mkdir(daemonDir, { recursive: true });
  await writeFile(resolve(daemonDir, GLOBAL_DAEMON_PID_FILENAME), "999999\n");

  return projectRoot;
}

test("doctor --fix under HACK_NO_INTERACTIVE clears a stale daemon pid without prompting", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli([
    "doctor",
    "--fix",
    "--no-interactive",
    "--path",
    projectRoot,
  ]);

  expect(code).toBe(0);
  // Safe remediation applied automatically: `hack daemon clear` was invoked
  // to clean up the stale pid/socket state.
  expect(runCalls).toEqual(
    expect.arrayContaining([expect.arrayContaining(["daemon", "clear"])])
  );
});

test("doctor --fix under HACK_NO_INTERACTIVE skips macOS keychain repair and reports it", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli([
    "doctor",
    "--fix",
    "--no-interactive",
    "--path",
    projectRoot,
  ]);

  expect(code).toBe(0);
  // Host TLS repair is safe to run non-interactively: it delegates to
  // `hack global trust`, which preflights sudo and skips only the System
  // keychain step while still writing the host trust env. It must NOT be
  // in the skipped-steps summary.
  const skippedNote = noteCalls.find((message) =>
    message.includes("Skipped (non-interactive")
  );
  if (skippedNote !== undefined) {
    expect(skippedNote).not.toContain("Repair macOS host TLS trust");
  }
});

test("doctor --fix never calls the raw clack confirm prompt under HACK_NO_INTERACTIVE", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();

  const { runCli } = await import("../src/cli/run.ts");
  const code = await runCli([
    "doctor",
    "--fix",
    "--no-interactive",
    "--path",
    projectRoot,
  ]);

  // The clack `confirm` mock throws if invoked; reaching a normal exit code
  // proves every prompt site in the --fix path routed through confirmSafe's
  // non-interactive branch instead of the raw clack prompt.
  expect(code).toBe(0);
});

test("doctor --fix creates a missing .hack/.gitignore and keeps user lines on a repair (HACK-1278)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const gitignore = resolve(projectRoot, ".hack", ".gitignore");
  expect(await lstat(gitignore).catch(() => null)).toBeNull();

  const { runCli } = await import("../src/cli/run.ts");
  const fix = () =>
    runCli(["doctor", "--fix", "--no-interactive", "--path", projectRoot]);
  expect(await fix()).toBe(0);
  const created = await readFile(gitignore, "utf8");
  expect(created).toContain(".internal/\n");
  expect(created).toContain("# end managed by hack");
  expect(noteCalls.join("\n")).toContain("Created .hack/.gitignore.");

  await writeFile(gitignore, "my-own-entry\n");
  noteCalls.length = 0;
  expect(await fix()).toBe(0);
  const repaired = await readFile(gitignore, "utf8");
  expect(repaired.startsWith("my-own-entry\n")).toBe(true);
  expect(repaired).toContain(".internal/\n");
  expect(noteCalls.join("\n")).toContain("Updated .hack/.gitignore.");
}, 30_000);

test("doctor --fix leaves a read-only .hack/.gitignore without the managed block unchanged (HACK-1363)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const gitignore = resolve(projectRoot, ".hack", ".gitignore");
  await writeFile(gitignore, "my-own-entry\n");
  await chmod(gitignore, 0o444);
  try {
    const { runCli } = await import("../src/cli/run.ts");
    expect(
      await runCli([
        "doctor",
        "--fix",
        "--no-interactive",
        "--path",
        projectRoot,
      ])
    ).toBe(0);
    expect(await readFile(gitignore, "utf8")).toBe("my-own-entry\n");
    expect((await lstat(gitignore)).mode & 0o777).toBe(0o444);
    expect(noteCalls.join("\n")).not.toContain("Updated .hack/.gitignore.");
  } finally {
    await chmod(gitignore, 0o644);
  }
}, 30_000);

test("doctor --fix untracks generated files but leaves a read-only outdated .hack/.gitignore alone (HACK-1363)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const gitignore = resolve(projectRoot, ".hack", ".gitignore");
  await writeFile(gitignore, "my-own-entry\n");
  await chmod(gitignore, 0o444);
  trackedGeneratedPaths = [".hack/.env"];
  try {
    const { runCli } = await import("../src/cli/run.ts");
    const { HACK_DIR_GITIGNORE_READ_ONLY_WARNING } = await import(
      "../src/lib/project-env-config.ts"
    );
    expect(
      await runCli([
        "doctor",
        "--fix",
        "--no-interactive",
        "--path",
        projectRoot,
      ])
    ).toBe(0);
    expect(
      execCalls.some((cmd) => cmd[3] === "rm" && cmd.at(-1) === ".hack/.env")
    ).toBe(true);
    expect(await readFile(gitignore, "utf8")).toBe("my-own-entry\n");
    expect((await lstat(gitignore)).mode & 0o777).toBe(0o444);
    const notes = noteCalls.join("\n");
    expect(notes).toContain(
      "Removed 1 path(s) from the git index; .hack/.gitignore was left alone."
    );
    expect(notes).toContain(HACK_DIR_GITIGNORE_READ_ONLY_WARNING);
    expect(notes).not.toContain("and ensured .hack/.gitignore");
  } finally {
    await chmod(gitignore, 0o644);
  }
}, 30_000);

const OUTSIDE_IGNORE_TEXT = "outside-file-must-not-change\n";

test("doctor --fix never writes through a symlinked .hack/.gitignore", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const outside = resolve(tempDir, "outside-ignore");
  await writeFile(outside, OUTSIDE_IGNORE_TEXT);
  const gitignore = resolve(projectRoot, ".hack", ".gitignore");
  await symlink(outside, gitignore);

  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli(["doctor", "--fix", "--no-interactive", "--path", projectRoot])
  ).toBe(0);

  expect(await readFile(outside, "utf8")).toBe(OUTSIDE_IGNORE_TEXT);
  expect((await lstat(gitignore)).isSymbolicLink()).toBe(true);
  expect(await readlink(gitignore)).toBe(outside);
}, 30_000);

test("doctor --fix refuses an outside .hack without writing .gitignore (HACK-1685)", async () => {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const projectRoot = resolve(tempDir, "project");
  const outsideDir = resolve(tempDir, "outside-hack");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(outsideDir);
  await writeFile(
    resolve(outsideDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n"
  );
  const hackDir = resolve(projectRoot, ".hack");
  await symlink(outsideDir, hackDir);

  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli(["doctor", "--fix", "--no-interactive", "--path", projectRoot])
  ).toBe(1);

  expect(await readdir(outsideDir)).toEqual(["docker-compose.yml"]);
  expect(
    await readFile(resolve(outsideDir, "docker-compose.yml"), "utf8")
  ).toBe("services:\n  api:\n    image: alpine:3.19\n");
  expect((await lstat(hackDir)).isSymbolicLink()).toBe(true);
  expect(await readlink(hackDir)).toBe(outsideDir);
}, 30_000);

test("doctor --fix removes a literal Compose env override and keeps a reference-only one (HACK-1273)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const canary = "doctor-fix-synthetic-canary";
  const projection = {
    targetServices: ["api"],
    globalEnv: {},
    serviceEnv: { api: { TOKEN: canary } },
  };
  const internal = resolve(projectRoot, ".hack", ".internal");
  const path = resolve(internal, "compose.env.override.yml");
  await mkdir(internal, { recursive: true });
  await writeFile(path, renderManagedComposeEnvOverride(projection) ?? "", {
    mode: 0o600,
  });

  const { runCli } = await import("../src/cli/run.ts");
  const fix = () =>
    runCli(["doctor", "--fix", "--no-interactive", "--path", projectRoot]);
  expect(await fix()).toBe(0);
  expect(await lstat(path).catch(() => null)).toBeNull();
  expect(noteCalls.join("\n")).toContain(
    "Removed .hack/.internal/compose.env.override.yml (values omitted)."
  );

  const references = renderComposeEnvReferenceOverride(projection)?.text ?? "";
  await writeFile(path, references, { mode: 0o600 });
  noteCalls.length = 0;
  expect(await fix()).toBe(0);
  expect(await readFile(path, "utf8")).toBe(references);
  for (const message of noteCalls) {
    expect(message).not.toContain(canary);
  }
  // Two full doctor --fix runs; the default 5 s budget is too tight on CI.
}, 30_000);

test("doctor --fix leaves a file behind a symlinked .hack/.internal untouched (HACK-1316)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const canary = "doctor-fix-outside-canary";
  // An outside directory that happens to hold a file named like the override,
  // which is not a Compose override Hack can verify (the reported case).
  const outside = resolve(tempDir, "outside");
  await mkdir(outside);
  const override = resolve(outside, "compose.env.override.yml");
  await writeFile(override, `${canary}\n`);
  const internal = resolve(projectRoot, ".hack", ".internal");
  await symlink(outside, internal);

  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli(["doctor", "--fix", "--no-interactive", "--path", projectRoot])
  ).toBe(0);
  expect(await readFile(override, "utf8")).toBe(`${canary}\n`);
  expect(await readdir(outside)).toEqual(["compose.env.override.yml"]);
  expect((await lstat(internal)).isSymbolicLink()).toBe(true);
  const notes = noteCalls.join("\n");
  // Neither planned nor performed.
  expect(notes).not.toContain(".hack/.internal/compose.env.override.yml");
  expect(notes).not.toContain(canary);
  expect(notes).not.toContain(outside);
}, 30_000);

/*
 * HACK-1368: a candidate run (`hack-next`, or the bundled `hack-v5` entrypoint,
 * which also sets HACK_DAEMON_AUTOSTART_DISABLE=1) must not start hackd from
 * `doctor --fix`. Every hackd repair step runs `hack daemon ...` through the
 * first `hack` on PATH, which for a candidate is the stable CLI. The mocked
 * `run` records each step instead of executing it.
 */
const HACKD_REPAIR_CASES = [
  {
    label: "a hack-v5 entrypoint run",
    env: {
      HACK_CANDIDATE_ENTRYPOINT: "hack-v5",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
    },
    reason: "HACK_DAEMON_AUTOSTART_DISABLE=1",
  },
  {
    label: "a hack-next run",
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    reason: "disabled for a candidate run",
  },
  {
    label: "the opt-out alone",
    env: { HACK_DAEMON_AUTOSTART_DISABLE: "1" },
    reason: "HACK_DAEMON_AUTOSTART_DISABLE=1",
  },
  {
    // Positive control: the same harness does clear and start hackd.
    label: "positive control: a stable run",
    env: {},
    reason: null,
  },
] as const;

const HACKD_REPAIR_ENV_KEYS = [
  "HACK_CANDIDATE_ENTRYPOINT",
  "HACK_DAEMON_AUTOSTART_DISABLE",
] as const;

for (const repairCase of HACKD_REPAIR_CASES) {
  test(`doctor --fix --no-interactive hackd repair: ${repairCase.label} (HACK-1368)`, async () => {
    const projectRoot = await createProjectWithStaleDaemonPid();
    const saved = HACKD_REPAIR_ENV_KEYS.map(
      (key) => [key, process.env[key]] as const
    );
    for (const key of HACKD_REPAIR_ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
    Object.assign(process.env, repairCase.env);
    try {
      const { runCli } = await import("../src/cli/run.ts");
      expect(
        await runCli([
          "doctor",
          "--fix",
          "--no-interactive",
          "--path",
          projectRoot,
        ])
      ).toBe(0);
    } finally {
      for (const [key, value] of saved) {
        restoreEnv(key, value);
      }
    }

    const daemonSteps = runCalls
      .filter((cmd) => cmd.includes("daemon"))
      .map((cmd) => cmd.slice(cmd.indexOf("daemon")).join(" "));
    const skipNote = noteCalls.find((message) =>
      message.startsWith("Skipped hackd repair")
    );
    if (repairCase.reason === null) {
      expect(daemonSteps).toEqual(["daemon clear", "daemon start"]);
      expect(skipNote).toBeUndefined();
      return;
    }
    expect(daemonSteps).toEqual([]);
    expect(skipNote).toContain("(hackd is stale)");
    expect(skipNote).toContain(repairCase.reason);
    expect(skipNote).toContain(
      "To repair it yourself, run: hack daemon clear && hack daemon start"
    );
  }, 30_000);
}

test("doctor --fix refuses an outside .hack and preserves its override (HACK-1316, HACK-1685)", async () => {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  // The whole `.hack` is a link to an outside directory that holds a Compose
  // project and a file named like the override, which Hack cannot verify.
  const canary = "doctor-fix-outside-hack-canary";
  const projectRoot = resolve(tempDir, "project");
  const outside = resolve(tempDir, "outside-hack");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(resolve(outside, ".internal"), { recursive: true });
  await writeFile(
    resolve(outside, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n"
  );
  const override = resolve(outside, ".internal", "compose.env.override.yml");
  await writeFile(override, `${canary}\n`);
  const hackDir = resolve(projectRoot, ".hack");
  await symlink(outside, hackDir);

  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli(["doctor", "--fix", "--no-interactive", "--path", projectRoot])
  ).toBe(1);
  expect(await readFile(override, "utf8")).toBe(`${canary}\n`);
  expect(await readdir(resolve(outside, ".internal"))).toEqual([
    "compose.env.override.yml",
  ]);
  expect((await readdir(outside)).sort()).toEqual([
    ".internal",
    "docker-compose.yml",
  ]);
  expect((await lstat(hackDir)).isSymbolicLink()).toBe(true);
  expect(await readlink(hackDir)).toBe(outside);
  expect(await readFile(resolve(outside, "docker-compose.yml"), "utf8")).toBe(
    "services:\n  api:\n    image: alpine:3.19\n"
  );
  const notes = noteCalls.join("\n");
  // Neither planned nor performed.
  expect(notes).not.toContain(".hack/.internal/compose.env.override.yml");
  expect(notes).not.toContain(canary);
  expect(notes).not.toContain(outside);
}, 30_000);

test("doctor contract migration keeps base and untracked overlays with undelivered entries (HACK-1695)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const projectDir = resolve(projectRoot, ".hack");
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "A", source: "plain_env" }],
    })
  );
  const files = {
    ".env": "A=synthetic-delivered\nUNDECLARED=synthetic-base-only\n",
    ".env.bak": "A=synthetic-backup\nBACKUP_ONLY=synthetic-backup-only\n",
    ".env.example":
      "A=synthetic-example\nEXAMPLE_ONLY=synthetic-example-only\n",
    ".env.qa": "A=synthetic-qa\n",
    ".env.same": "A=synthetic-delivered\n",
    ".env.empty": "A=\n",
  };
  for (const [name, text] of Object.entries(files)) {
    await writeFile(resolve(projectDir, name), text);
  }
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n    env_file: [./.env, ./.env.bak]\n"
  );
  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli([
      "doctor",
      "--migrate-env-config",
      "--no-interactive",
      "--path",
      projectRoot,
    ])
  ).toBe(0);
  const notes = noteCalls.join("\n");
  for (const name of [
    ".env",
    ".env.bak",
    ".env.example",
    ".env.empty",
  ] as const) {
    expect(await readFile(resolve(projectDir, name), "utf8")).toBe(files[name]);
  }
  for (const key of ["UNDECLARED", "BACKUP_ONLY", "EXAMPLE_ONLY"]) {
    expect(notes).toContain(
      `keys not preserved in env layers: ${key} (values omitted)`
    );
  }
  for (const text of Object.values(files)) {
    for (const line of text.trim().split("\n")) {
      const value = line.split("=")[1];
      if (value) {
        expect(notes).not.toContain(value);
      }
    }
  }
  expect(
    await lstat(resolve(projectDir, ".env.qa")).catch(() => null)
  ).toBeNull();
  expect(
    await lstat(resolve(projectDir, ".env.same")).catch(() => null)
  ).toBeNull();
  expect(
    await readFile(resolve(projectDir, "hack.env.default.yaml"), "utf8")
  ).toContain("synthetic-delivered");
  expect(
    await readFile(resolve(projectDir, "hack.env.bak.yaml"), "utf8")
  ).toContain("synthetic-backup");
  expect(
    await readFile(resolve(projectDir, "hack.env.example.yaml"), "utf8")
  ).toContain("synthetic-example");
});

test("doctor migration refusal leaves a missing .hack/.gitignore unwritten (HACK-1695)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const projectDir = resolve(projectRoot, ".hack");
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "TOKEN", source: "keychain" }],
    })
  );
  await mkdir(resolve(projectRoot, ".hack.secret.key"));
  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli([
      "doctor",
      "--migrate-env-config",
      "--no-interactive",
      "--path",
      projectRoot,
    ])
  ).toBe(1);
  expect(
    await lstat(resolve(projectDir, ".gitignore")).catch(() => null)
  ).toBeNull();
  expect(
    await lstat(resolve(projectDir, "hack.env.default.yaml")).catch(() => null)
  ).toBeNull();
});

test("doctor refuses a default overlay that would overwrite the migrated base (HACK-1695)", async () => {
  const projectRoot = await createProjectWithStaleDaemonPid();
  const projectDir = resolve(projectRoot, ".hack");
  await writeFile(
    resolve(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "A", source: "plain_env" }],
    })
  );
  const base = "A=synthetic-collision-base\n";
  const overlay = "A=synthetic-collision-overlay\n";
  await writeFile(resolve(projectDir, ".env"), base);
  await writeFile(resolve(projectDir, ".env.default"), overlay);
  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli([
      "doctor",
      "--migrate-env-config",
      "--no-interactive",
      "--path",
      projectRoot,
    ])
  ).toBe(1);
  expect(await readFile(resolve(projectDir, ".env"), "utf8")).toBe(base);
  expect(await readFile(resolve(projectDir, ".env.default"), "utf8")).toBe(
    overlay
  );
  expect(
    await lstat(resolve(projectDir, "hack.env.default.yaml")).catch(() => null)
  ).toBeNull();
  expect(
    await lstat(resolve(projectDir, ".gitignore")).catch(() => null)
  ).toBeNull();
  expect(
    await lstat(resolve(projectDir, "hack.env.json")).catch(() => null)
  ).not.toBeNull();
  expect(noteCalls.join("\n")).not.toContain("synthetic-collision-base");
  expect(noteCalls.join("\n")).not.toContain("synthetic-collision-overlay");
});
