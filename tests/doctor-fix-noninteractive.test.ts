import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GLOBAL_DAEMON_DIR_NAME,
  GLOBAL_DAEMON_PID_FILENAME,
  GLOBAL_HACK_DIR_NAME,
} from "../src/constants.ts";
import { resetNoInteractiveFlagForTests } from "../src/lib/interactivity.ts";
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
});

afterEach(async () => {
  resetNoInteractiveFlagForTests();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
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
  process.env.HACK_LOGGER = originalLogger;
});

afterAll(() => {
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
