import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureHackDirGitignore } from "../src/lib/project-env-config.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

/**
 * Regression coverage for the field report: `hack doctor` (and `--fix`) must
 * not create the tickets extension's local git cache (`.hack/tickets/`)
 * unless the extension is actually enabled for the project — it previously
 * checked the unrelated `tickets.git.enabled` flag (default `true`) instead
 * of `controlPlane.extensions["dance.hack.tickets"].enabled` (default
 * `false`), so every `hack doctor` run silently created the directory.
 *
 * Also covers the companion fix: once the committed `.hack/.gitignore` is
 * generated, `tickets/` is covered so an enabled project's cache never shows
 * up as untracked.
 *
 * Docker/shell/OS are mocked (as in tests/doctor-fix-noninteractive.test.ts)
 * so `--fix` never touches this machine's real Docker/global infra state.
 */

async function dirExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

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
    note: () => {},
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
      if (cmd[0] === "docker" && cmd[1] === "info") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "docker" && cmd[1] === "network" && cmd[2] === "inspect") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    },
    execOrThrow: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    run: async () => 0,
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

let tempHome: string | null = null;
let originalHome: string | undefined;
let originalMutagenPath: string | undefined;

beforeAll(() => {
  clackMock.activate();
  shellMock.activate();
  osMock.activate();
});

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalMutagenPath = process.env.HACK_MUTAGEN_PATH;
  tempHome = await mkdtemp(join(tmpdir(), "hack-doctor-tickets-home-"));
  process.env.HOME = tempHome;
  // Short-circuit mutagen path resolution so --fix never attempts a real
  // network install.
  process.env.HACK_MUTAGEN_PATH = "/usr/local/bin/mutagen";
});

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
  process.env.HOME = originalHome;
  if (originalMutagenPath === undefined) {
    Reflect.deleteProperty(process.env, "HACK_MUTAGEN_PATH");
  } else {
    process.env.HACK_MUTAGEN_PATH = originalMutagenPath;
  }
});

afterAll(() => {
  clackMock.deactivate();
  shellMock.deactivate();
  osMock.deactivate();
});

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-tickets-repo-"));
  tempDirs.add(dir);
  return dir;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

async function gitCheckIgnore(opts: {
  readonly repoRoot: string;
  readonly path: string;
}): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["git", "check-ignore", "-q", "--", opts.path],
    cwd: opts.repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function createFixtureRepo(opts: {
  readonly ticketsEnabled: boolean;
}): Promise<string> {
  const dir = await createTempDir();
  const repoRoot = resolve(dir, "repo");
  await mkdir(resolve(repoRoot, ".hack"), { recursive: true });
  await runGit(["init", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "Hack Test"], repoRoot);
  await runGit(["config", "user.email", "hack@example.com"], repoRoot);

  await writeFile(
    resolve(repoRoot, ".hack", "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.19\n"
  );
  await writeFile(
    resolve(repoRoot, ".hack", "hack.config.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        controlPlane: {
          extensions: {
            "dance.hack.tickets": { enabled: opts.ticketsEnabled },
          },
        },
      },
      null,
      2
    )}\n`
  );
  await ensureHackDirGitignore({ projectDir: resolve(repoRoot, ".hack") });
  await runGit(["add", "."], repoRoot);
  await runGit(["commit", "-m", "init"], repoRoot);
  return repoRoot;
}

async function runDoctor(opts: {
  readonly repoRoot: string;
  readonly extraArgs?: readonly string[];
}): Promise<number> {
  const { runCli } = await import("../src/cli/run.ts");
  return await runCli([
    "doctor",
    "--path",
    opts.repoRoot,
    "--no-interactive",
    ...(opts.extraArgs ?? []),
  ]);
}

test("hack doctor does not create .hack/tickets/ when the extension is disabled", async () => {
  const repoRoot = await createFixtureRepo({ ticketsEnabled: false });

  await runDoctor({ repoRoot });

  expect(await dirExists(resolve(repoRoot, ".hack", "tickets"))).toBe(false);
});

test("hack doctor --fix does not create .hack/tickets/ when the extension is disabled", async () => {
  const repoRoot = await createFixtureRepo({ ticketsEnabled: false });

  await runDoctor({ repoRoot, extraArgs: ["--fix"] });

  expect(await dirExists(resolve(repoRoot, ".hack", "tickets"))).toBe(false);
});

test("hack doctor creates .hack/tickets/ when the extension is enabled, and it is gitignored", async () => {
  const repoRoot = await createFixtureRepo({ ticketsEnabled: true });

  await runDoctor({ repoRoot });

  expect(await dirExists(resolve(repoRoot, ".hack", "tickets"))).toBe(true);
  expect(
    await gitCheckIgnore({ repoRoot, path: ".hack/tickets/git/bare.git" })
  ).toBe(true);

  const status = await runGit(["status", "--porcelain"], repoRoot);
  expect(status).toBe("");
});
