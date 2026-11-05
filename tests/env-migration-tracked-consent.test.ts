import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFixtureGit } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1904: the env migration never deletes or edits a git-tracked file
 * without consent, native doctor runs the same migration as Compose doctor,
 * and the implicit route reports moved keys and drops its plaintext copy.
 * Every case uses a real temporary git repository and synthetic values.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const KEY = "SYNTH_KEY";
const VALUE = ["synthetic", "value", "1904"].join("-");
const CONTRACT = `${JSON.stringify({
  version: 1,
  vars: [{ key: KEY, source: "plain_env", required: false }],
})}\n`;
const COMPOSE_WITH_ENV_FILE =
  "services:\n  api:\n    image: alpine:3.20\n    env_file: .env\n";
const COMPOSE_PLAIN = "services:\n  api:\n    image: alpine:3.20\n";
const CONFIG = `${JSON.stringify({ name: "hack-1904", dev_host: "hack-1904.hack" })}\n`;
const CLI_TEST_TIMEOUT_MS = 60_000;

const roots: string[] = [];
const running = new Set<Bun.Subprocess>();

afterEach(async () => {
  const children = [...running];
  running.clear();
  for (const child of children) {
    child.kill("SIGKILL");
  }
  await Promise.all(children.map((child) => child.exited));
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

type Project = {
  readonly root: string;
  readonly projectRoot: string;
  readonly projectDir: string;
};

async function git(project: Project, args: readonly string[]) {
  const result = await runFixtureGit({ cwd: project.projectRoot, args });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
}

/** A committed contract, config and Compose file, plus an untracked `.hack/.env`. */
async function createProject(opts: {
  readonly compose: string;
}): Promise<Project> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-1904-")));
  roots.push(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(resolve(projectDir, "docker-compose.yml"), opts.compose);
  await writeFile(resolve(projectDir, "hack.config.json"), CONFIG);
  await writeFile(resolve(projectDir, "hack.env.json"), CONTRACT);
  const project = { root, projectRoot, projectDir };
  await git(project, ["init", "--quiet"]);
  await git(project, ["add", ".hack"]);
  await git(project, ["commit", "--quiet", "-m", "fixture"]);
  await writeFile(resolve(projectDir, ".env"), `${KEY}=${VALUE}\n`);
  return project;
}

async function status(project: Project): Promise<string[]> {
  return (
    await git(project, ["status", "--porcelain", "--untracked-files=all"])
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}

async function runCli(opts: {
  readonly project: Project;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}) {
  const tools = join(opts.project.root, "tools");
  await mkdir(tools, { recursive: true });
  // Docker is unreachable; the migration changes project files only.
  await writeFile(join(tools, "docker"), "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  await writeFile(join(tools, "mutagen"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...opts.args], {
    cwd: opts.project.projectRoot,
    env: privateCliEnv({
      root: opts.project.root,
      env: {
        PATH: `${tools}:/usr/bin:/bin`,
        HACK_MUTAGEN_PATH: join(tools, "mutagen"),
        HACK_HOME: join(opts.project.root, "hack-home"),
        HACK_GLOBAL_CONFIG_PATH: join(opts.project.root, "hack-config.json"),
        HACK_LOGGER: "console",
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        NO_COLOR: "1",
        ...opts.env,
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  running.delete(proc);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

const BACKENDS = {
  compose: { HACK_RUNTIME_BACKEND: "compose" },
  native: {
    HACK_RUNTIME_BACKEND: "native",
    HACK_NATIVE_BINARY: "/nonexistent/hack-native",
    HACK_NATIVE_HOME: "/nonexistent/native-home",
  },
} as const;

function runDoctor(opts: {
  readonly project: Project;
  readonly backend: keyof typeof BACKENDS;
  readonly accept: boolean;
}) {
  return runCli({
    project: opts.project,
    args: [
      "doctor",
      "--migrate-env-config",
      ...(opts.accept ? ["--accept-tracked-env-changes"] : []),
      "--path",
      opts.project.projectRoot,
    ],
    env: BACKENDS[opts.backend],
  });
}

for (const backend of ["compose", "native"] as const) {
  test(
    `${backend} doctor without a prompt refuses to change tracked files and changes nothing`,
    async () => {
      const project = await createProject({ compose: COMPOSE_WITH_ENV_FILE });

      const run = await runDoctor({ project, backend, accept: false });

      expect(run.exitCode).toBe(1);
      expect(run.output).not.toContain(VALUE);
      expect(run.output).toContain("E_INTERACTIVE_REQUIRED");
      expect(run.output).toContain(
        "git-tracked files (edit .hack/docker-compose.yml; delete .hack/hack.env.json)"
      );
      expect(run.output).toContain("--accept-tracked-env-changes");
      expect(run.output).not.toContain("v4");
      expect(await status(project)).toEqual(["?? .hack/.env"]);
      expect(
        await readFile(join(project.projectDir, "hack.env.json"), "utf8")
      ).toBe(CONTRACT);
      expect(
        await readFile(join(project.projectDir, "docker-compose.yml"), "utf8")
      ).toBe(COMPOSE_WITH_ENV_FILE);
      expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
        `${KEY}=${VALUE}\n`
      );
    },
    CLI_TEST_TIMEOUT_MS
  );

  test(
    `${backend} doctor with --accept-tracked-env-changes migrates and changes the tracked files`,
    async () => {
      const project = await createProject({ compose: COMPOSE_WITH_ENV_FILE });

      const run = await runDoctor({ project, backend, accept: true });

      expect(run.output).not.toContain(VALUE);
      expect(run.output).not.toContain("E_INTERACTIVE_REQUIRED");
      expect(run.output).toContain(
        `Moved ${KEY} to .hack/hack.env.local.yaml (values omitted).`
      );
      expect(run.output).toContain("tracked by git and can now be removed");
      expect(await status(project)).toEqual([
        " D .hack/hack.env.json",
        " M .hack/docker-compose.yml",
        "?? .hack/.gitignore",
        "?? .hack/hack.env.default.yaml",
      ]);
      expect(
        await readFile(join(project.projectDir, "hack.env.local.yaml"), "utf8")
      ).toContain(VALUE);
      // The plaintext copy is gone once Compose no longer names it.
      await expect(
        readFile(join(project.projectDir, ".env"), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    CLI_TEST_TIMEOUT_MS
  );
}

test(
  "doctor without a prompt still migrates when no tracked file would change",
  async () => {
    const project = await createProject({ compose: COMPOSE_PLAIN });
    // An untracked contract is this checkout's own file.
    await git(project, ["rm", "--quiet", "--cached", ".hack/hack.env.json"]);
    await git(project, ["commit", "--quiet", "-m", "untrack contract"]);

    const run = await runDoctor({ project, backend: "native", accept: false });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(`Moved ${KEY} to .hack/hack.env.local.yaml`);
    expect(await status(project)).toEqual([
      "?? .hack/.gitignore",
      "?? .hack/hack.env.default.yaml",
    ]);
  },
  CLI_TEST_TIMEOUT_MS
);

function runImplicit(project: Project, env: Record<string, string> = {}) {
  return runCli({
    project,
    args: ["env", "exec", "--path", project.projectRoot, "--", "true"],
    env: { ...BACKENDS.native, ...env },
  });
}

test(
  "implicit migration names moved keys, drops the plaintext copy and leaves tracked files alone",
  async () => {
    const project = await createProject({ compose: COMPOSE_PLAIN });

    const run = await runImplicit(project);

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(
      `Moved ${KEY} to .hack/hack.env.local.yaml (values omitted).`
    );
    expect(run.output).toContain("Removed .hack/.env");
    expect(await status(project)).toEqual([
      "?? .hack/.gitignore",
      "?? .hack/hack.env.default.yaml",
    ]);
    expect(
      await readFile(join(project.projectDir, "hack.env.json"), "utf8")
    ).toBe(CONTRACT);
    expect(
      await readFile(join(project.projectDir, "hack.env.local.yaml"), "utf8")
    ).toContain(VALUE);
    await expect(
      readFile(join(project.projectDir, ".env"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "implicit migration keeps a .env Compose still names and says why",
  async () => {
    const project = await createProject({ compose: COMPOSE_WITH_ENV_FILE });

    const run = await runImplicit(project);

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(`Moved ${KEY} to .hack/hack.env.local.yaml`);
    expect(run.output).toContain(
      "Kept .hack/.env: Compose still names it as env_file."
    );
    // The new managed ignore block covers .env, so status no longer lists it.
    expect(await status(project)).toEqual([
      "?? .hack/.gitignore",
      "?? .hack/hack.env.default.yaml",
    ]);
    expect(await readFile(join(project.projectDir, ".env"), "utf8")).toBe(
      `${KEY}=${VALUE}\n`
    );
    expect(
      await readFile(join(project.projectDir, "docker-compose.yml"), "utf8")
    ).toBe(COMPOSE_WITH_ENV_FILE);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "a shell-only contract value refusal doesn't claim a .hack/.env exists",
  async () => {
    const project = await createProject({ compose: COMPOSE_PLAIN });
    await rm(join(project.projectDir, ".env"));

    const run = await runImplicit(project, { [KEY]: VALUE });

    expect(run.exitCode).not.toBe(0);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(
      "Refusing to migrate the legacy env config: the contract declares"
    );
    expect(run.output).not.toContain(".hack/.env files");
    expect(await status(project)).toEqual([]);
  },
  CLI_TEST_TIMEOUT_MS
);
