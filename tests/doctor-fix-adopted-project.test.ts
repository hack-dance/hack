import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADOPTED_COMPOSE_ENV_OVERRIDE_NEXT_STEP,
  INTERRUPTED_OPERATION_ADOPTED_COMPOSE_ENV_OVERRIDE_NEXT_STEP,
} from "../src/lib/compose-env-at-rest.ts";
import { renderManagedComposeEnvOverride } from "../src/lib/compose-managed-env.ts";
import { resetNoInteractiveFlagForTests } from "../src/lib/interactivity.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { restoreEnv } from "./helpers/env.ts";
import {
  leaveRetainedSourceBindOperationPending,
  retainedSourceBindFixture,
  SOURCE_BIND_CANARY,
} from "./helpers/retained-source-bind-adoption.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

/**
 * HACK-1311: `hack doctor --fix --no-interactive` in an adopted
 * (`hack config adopt`) project whose generated files are tracked by Git. Every
 * `--fix` step must leave the adoption alone instead of reaching a legacy
 * writer that refuses the project as native input: the untrack step changes
 * the Git index (and the root key entry) but not the adoption's
 * `.hack/.gitignore`, and the Docker-backed project steps and env migration
 * skip the project. The fixture is the synthetic retained source-bind
 * adoption; Docker, DNS, prompts and child commands are mocked, and Git runs
 * only against the fixture checkout with no global or system config.
 */

const LITERAL_CANARY = "hack-1414-literal-override-canary";
const runCalls: string[][] = [];
const noteCalls: string[] = [];

/** Real `git` for the fixture checkout only; never through the mocked shell. */
async function gitExec(cmd: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn(["/usr/bin/git", ...cmd.slice(1)], {
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

let home = "";
function gitEnv(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

const mocks = await Promise.all([
  registerScopedModuleMock({
    importerPath: import.meta.path,
    specifier: "node:dns/promises",
    overrides: {
      lookup: async () => {
        throw new Error("Fixture DNS is not configured");
      },
    },
  }),
  registerScopedModuleMock({
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
      spinner: () => ({ start: () => {}, stop: () => {} }),
    },
  }),
  registerScopedModuleMock({
    importerPath: import.meta.path,
    specifier: "../src/lib/shell.ts",
    overrides: {
      exec: async (cmd: readonly string[]) => {
        if (cmd[0] === "git") {
          return await gitExec(cmd);
        }
        // Docker is reachable, so the Docker-backed --fix steps run too.
        if (cmd[0] === "docker" && cmd[1] === "info") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          cmd[0] === "docker" &&
          cmd[1] === "network" &&
          cmd[2] === "inspect"
        ) {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      execOrThrow: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      run: async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      },
      findExecutableInPath: (name?: string) =>
        name === "hack" || name === "bun" || name === "docker"
          ? `/usr/local/bin/${name}`
          : null,
      CommandError: class CommandError extends Error {},
    },
  }),
  registerScopedModuleMock({
    importerPath: import.meta.path,
    specifier: "../src/lib/os.ts",
    overrides: {
      isMac: () => true,
      isLinux: () => false,
      openUrl: async () => 0,
    },
  }),
]);

const ENV_KEYS = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_NO_INTERACTIVE",
  "HACK_MUTAGEN_PATH",
  "HACK_LOGGER",
] as const;
let saved: Record<string, string | undefined> = {};
let h: Awaited<ReturnType<typeof retainedSourceBindFixture>>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = await mkdtemp(join(tmpdir(), "hack-doctor-fix-adopted-"));
  h = await retainedSourceBindFixture();
  runCalls.length = 0;
  noteCalls.length = 0;
});

afterEach(async () => {
  for (const mock of mocks) {
    mock.deactivate();
  }
  resetNoInteractiveFlagForTests();
  for (const key of ENV_KEYS) {
    restoreEnv(key, saved[key]);
  }
  await h.cleanup();
  await rm(home, { recursive: true, force: true });
});

afterAll(() => {
  for (const mock of mocks) {
    mock.deactivate();
  }
});

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", "-C", h.root, ...args], {
    env: gitEnv(),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in the fixture; output omitted.`);
  }
  return result.stdout.toString();
}

const receiptPath = () =>
  join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json");

/**
 * A committed project env key (the reported case) and a committed generated
 * env state file. The key is also an `env key` error found before `--fix`
 * runs, so that doctor run still exits 1 after completing every step.
 */
const CASES = [
  {
    tracked: ".hack.secret.key",
    content: () => `${randomBytes(32).toString("base64url")}\n`,
    exit: 1,
    rootGitignore: "# project env key\n.hack.secret.key\n",
    lastNotes: [
      "Re-run: hack doctor",
      "Fix the errors above, then rerun: hack doctor",
    ],
  },
  {
    tracked: ".hack/.env.state.json",
    content: () => "{}\n",
    exit: 0,
    rootGitignore: null,
    lastNotes: ["Re-run: hack doctor"],
  },
] as const;

for (const testCase of CASES) {
  test(`doctor --fix in an adopted project untracks a committed ${testCase.tracked} and completes without the native-input refusal (HACK-1311)`, async () => {
    await runAdoptedFixCase(testCase);
  }, 120_000);
}

test("doctor --fix with a pending adoption leaves the pending operation for explicit recovery and completes the global steps (HACK-1311)", async () => {
  // A real Git checkout with a committed generated file, as in the cases above.
  await rm(join(h.root, ".git"), { recursive: true });
  git(["init", "-q"]);
  const trackedPath = join(h.root, ".hack/.env.state.json");
  await writeFile(trackedPath, "{}\n", { mode: 0o600 });
  git(["add", "-f", ".hack/.env.state.json"]);
  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    await store.publish({ generation, binary: h.compiler });
  } finally {
    await store.close();
  }
  await leaveRetainedSourceBindOperationPending(h);
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("pending");
  const receipt = await readFile(receiptPath(), "utf8");
  const engineCommands = (await h.commands()).length;

  const code = await runDoctorFix();

  const notes = noteCalls.join("\n");
  expect(notes).not.toContain("E_NATIVE_PROJECT");
  expect(notes).not.toContain(SOURCE_BIND_CANARY);
  // The pending project check is a warning, so doctor exits 0.
  expect(code).toBe(0);
  expect(notes).toContain(
    "Leave the adopted Compose project's inputs, retained containers and adoption state to 'hack config adopt'; --fix changes none of them."
  );
  expect(notes).toContain(
    "Removed 1 path(s) from the git index. Left .hack/.gitignore unchanged: an adopted Compose project's .hack/ belongs to 'hack config adopt'."
  );
  expect(notes).toContain(
    "Skip env migration because an adopted Compose project's env config belongs to 'hack config adopt'."
  );
  // Every step ran: the closing note follows the last one.
  expect(noteCalls.at(-1)).toBe("Re-run: hack doctor");
  expect(git(["ls-files"])).toBe("");
  expect(await lstat(join(h.root, ".hack/.gitignore")).catch(() => null)).toBe(
    null
  );

  // The pending operation is left for explicit recovery: the journal is
  // unchanged, and no retained container or project command ran.
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("pending");
  expect(await readFile(receiptPath(), "utf8")).toBe(receipt);
  expect((await h.commands()).length).toBe(engineCommands);
  for (const call of runCalls) {
    expect(call.join(" ")).not.toContain(h.root);
  }
}, 120_000);

test("doctor --fix keeps a literal env override that a pending adoption pins and names the recovery that state accepts (HACK-1414)", async () => {
  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    await store.publish({ generation, binary: h.compiler });
  } finally {
    await store.close();
  }
  // An interrupted retained command of the active adoption: rollback (plain
  // or `--recover`) refuses until `hack down --recover` settles it.
  await leaveRetainedSourceBindOperationPending(h);
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("pending");
  // An earlier version's literal override. Doctor reads only the adoption
  // status, so it reports the file as pinned without loading the adoption.
  const overridePath = join(h.root, ".hack/.internal/compose.env.override.yml");
  const literal =
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv: { web: { LITERAL_SECRET: LITERAL_CANARY } },
    }) ?? "";
  await writeFile(overridePath, literal, { mode: 0o600 });
  const receipt = await readFile(receiptPath(), "utf8");

  const code = await runDoctorFix();

  const notes = noteCalls.join("\n");
  expect(code).toBe(0);
  expect(notes).toContain(
    `Kept .hack/.internal/compose.env.override.yml: a saved 'hack config adopt' generation pins it, and removing it would break the adoption (values omitted). ${INTERRUPTED_OPERATION_ADOPTED_COMPOSE_ENV_OVERRIDE_NEXT_STEP}`
  );
  expect(notes).toContain("'hack down --recover'");
  // The settled and pending-switch steps both name commands this state
  // refuses.
  expect(notes).not.toContain(ADOPTED_COMPOSE_ENV_OVERRIDE_NEXT_STEP);
  expect(notes).not.toContain("--recover --rollback");
  expect(notes).not.toContain(LITERAL_CANARY);
  expect(notes).not.toContain(SOURCE_BIND_CANARY);
  // Kept as is, and the adoption is left for explicit recovery.
  expect(await readFile(overridePath, "utf8")).toBe(literal);
  expect(await readFile(receiptPath(), "utf8")).toBe(receipt);
}, 120_000);

/** `runCli doctor --fix` in the fixture with a private HOME and the mocks on. */
async function runDoctorFix(): Promise<number> {
  process.env.HOME = home;
  process.env.HACK_HOME = join(home, "hack-home");
  Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  process.env.HACK_NO_INTERACTIVE = "1";
  process.env.HACK_MUTAGEN_PATH = "/usr/local/bin/mutagen";
  process.env.HACK_LOGGER = "console";
  for (const mock of mocks) {
    mock.activate();
  }
  try {
    const { runCli } = await import("../src/cli/run.ts");
    return await runCli([
      "doctor",
      "--fix",
      "--no-interactive",
      "--migrate-env-config",
      "--path",
      h.root,
    ]);
  } finally {
    for (const mock of mocks) {
      mock.deactivate();
    }
  }
}

async function runAdoptedFixCase(testCase: (typeof CASES)[number]) {
  // A real Git checkout with a committed generated file.
  await rm(join(h.root, ".git"), { recursive: true });
  git(["init", "-q"]);
  const content = testCase.content();
  const trackedPath = join(h.root, testCase.tracked);
  await writeFile(trackedPath, content, { mode: 0o600 });
  git(["add", "-f", testCase.tracked]);

  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    await store.publish({ generation, binary: h.compiler });
  } finally {
    await store.close();
  }
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("active");
  const receipt = await readFile(receiptPath(), "utf8");
  const engineCommands = (await h.commands()).length;

  const code = await runDoctorFix();

  const notes = noteCalls.join("\n");
  expect(notes).not.toContain("E_NATIVE_PROJECT");
  expect(notes).not.toContain(SOURCE_BIND_CANARY);
  if (testCase.tracked === ".hack.secret.key") {
    expect(notes).not.toContain(content.trim());
  }
  expect(code).toBe(testCase.exit);
  // The plan and the step name the adopted project's Git-index-only change.
  expect(notes).toContain(
    `Untrack machine-local generated files from git (git rm --cached; files stay on disk) and leave the adopted project's .hack/.gitignore unchanged: ${testCase.tracked}`
  );
  expect(notes).toContain(
    "Removed 1 path(s) from the git index. Left .hack/.gitignore unchanged: an adopted Compose project's .hack/ belongs to 'hack config adopt'."
  );
  expect(notes).toContain(
    "Skip env migration because an adopted Compose project's env config belongs to 'hack config adopt'."
  );
  // Every step after the untrack ran: the closing notes follow the last one.
  expect(noteCalls.slice(-testCase.lastNotes.length)).toEqual([
    ...testCase.lastNotes,
  ]);

  // Index only: the file stays on disk, untracked; the key is ignored at the
  // root, and the adoption's .hack/.gitignore is not created.
  expect(git(["ls-files"])).toBe("");
  expect(await readFile(trackedPath, "utf8")).toBe(content);
  expect(
    await readFile(join(h.root, ".gitignore"), "utf8").catch(() => null)
  ).toBe(testCase.rootGitignore);
  expect(await lstat(join(h.root, ".hack/.gitignore")).catch(() => null)).toBe(
    null
  );

  // The adoption is unchanged and no retained container moved.
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("active");
  expect(await readFile(receiptPath(), "utf8")).toBe(receipt);
  expect((await h.commands()).length).toBe(engineCommands);
  expect(await lstat(join(h.outer, "unexpected")).catch(() => null)).toBe(null);
  // No project command ran for the adopted project; only global repairs.
  for (const call of runCalls) {
    expect(call.join(" ")).not.toContain(h.root);
  }
}
