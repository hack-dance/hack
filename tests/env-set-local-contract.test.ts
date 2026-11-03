import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/** Contract migration must keep legacy plaintext machine-local (HACK-1712/1713). */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const VALUE = ["synthetic", "local", "1710"].join("-");
const CONTRACT = `${JSON.stringify({
  version: 1,
  vars: [{ key: "LOCAL_KEY", source: "plain_env", required: false }],
})}\n`;

const CLI_TEST_TIMEOUT_MS = 60_000;

const roots: string[] = [];
const running = new Set<Bun.Subprocess>();

afterEach(async () => {
  // A test timeout doesn't end its child, so stop and await any still running
  // before removing the fixture it works in.
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

async function createProject(opts: {
  readonly contract: boolean;
  readonly mirrored?: boolean;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-1710-")));
  roots.push(root);
  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n    env_file:\n      - path: .env\n        required: false\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "hack-1710",
      dev_host: "hack-1710.hack",
      ...(opts.mirrored
        ? {
            controlPlane: {
              secrets: {
                backend: "encrypted_file",
                storePlaintextInBackend: true,
                encryptedFile: {
                  path: resolve(projectRoot, "secrets.enc.json"),
                  keyPath: resolve(projectRoot, "secrets-file.key"),
                },
              },
            },
          }
        : {}),
    })}\n`
  );
  if (opts.contract) {
    await writeFile(resolve(projectDir, "hack.env.json"), CONTRACT);
  }
  return { root, projectRoot, projectDir };
}

type Project = Awaited<ReturnType<typeof createProject>>;

async function runEnv(
  project: Project,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {}
) {
  const proc = Bun.spawn(
    [
      process.execPath,
      ENTRYPOINT,
      "env",
      ...args,
      "--value-stdin",
      "--path",
      project.projectRoot,
    ],
    {
      cwd: project.projectRoot,
      env: privateCliEnv({
        root: project.root,
        env: {
          HACK_GLOBAL_CONFIG_PATH: join(project.root, "hack-config.json"),
          HACK_HOME: join(project.root, "hack-home"),
          HACK_LOGGER: "console",
          HACK_NO_INTERACTIVE: "1",
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          NO_COLOR: "1",
          ...extraEnv,
        },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  running.add(proc);
  proc.stdin.write(`${VALUE}\n`);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  running.delete(proc);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function tree(project: Project): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(project.projectRoot, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[relative(project.projectRoot, path)] = await readFile(path, "utf8");
    }
  }
  return out;
}

const setLocal = (project: Project) =>
  runEnv(project, ["set", "LOCAL_KEY", "--local"]);

test(
  "with a contract and no layers, set --local writes legacy dotenv",
  async () => {
    const project = await createProject({ contract: true });

    const run = await setLocal(project);

    expect(run.exitCode).toBe(0);
    const files = await tree(project);
    expect(files[".hack/hack.env.default.yaml"]).toBeUndefined();
    expect(files[".hack/.env"]).toContain(VALUE);
    expect(run.output).not.toContain(VALUE);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "set --env staging --local writes the legacy overlay",
  async () => {
    const project = await createProject({ contract: true });

    const run = await runEnv(project, [
      "set",
      "LOCAL_KEY",
      "--env",
      "staging",
      "--local",
    ]);

    expect(run.exitCode).toBe(0);
    const files = await tree(project);
    expect(files[".hack/hack.env.default.yaml"]).toBeUndefined();
    expect(files[".hack/.env.staging"]).toContain(VALUE);
    expect(run.output).not.toContain(VALUE);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "with a mirrored backend, set --local writes legacy dotenv",
  async () => {
    const project = await createProject({ contract: true, mirrored: true });

    const run = await runEnv(project, ["set", "LOCAL_KEY", "--local"], {
      HACK_SECRETS_FILE_KEY: ["synthetic", "file", "1712"].join("-"),
    });

    expect(run.exitCode).toBe(0);
    const files = await tree(project);
    expect(files[".hack/hack.env.default.yaml"]).toBeUndefined();
    expect(files[".hack/.env"]).toContain(VALUE);
    expect(run.output).not.toContain(VALUE);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env add keeps the value out of tracked layers",
  async () => {
    const project = await createProject({ contract: true });

    const run = await runEnv(project, ["add", "LOCAL_KEY", "--local"]);

    expect(run.exitCode).toBe(0);
    const files = await tree(project);
    expect(files[".hack/hack.env.local.yaml"]).toContain(VALUE);
    expect(files[".hack/hack.env.default.yaml"]).not.toContain(VALUE);
    expect(files[".hack/.env"]).toBeUndefined();
    // And set --local now has layers to write to.
    const again = await setLocal(project);
    expect(again.exitCode).toBe(0);
    expect((await tree(project))[".hack/hack.env.default.yaml"]).not.toContain(
      VALUE
    );
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "env add with --env writes that overlay's local layer, not the base",
  async () => {
    const project = await createProject({ contract: true });

    const run = await runEnv(project, [
      "add",
      "LOCAL_KEY",
      "--env",
      "staging",
      "--local",
    ]);

    expect(run.exitCode).toBe(0);
    const files = await tree(project);
    expect(files[".hack/hack.env.staging.local.yaml"]).toContain(VALUE);
    expect(files[".hack/hack.env.local.yaml"] ?? "").not.toContain(VALUE);
    expect(files[".hack/hack.env.default.yaml"]).not.toContain(VALUE);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "--secret --local writes the store and not .env",
  async () => {
    const project = await createProject({ contract: true, mirrored: true });

    const run = await runEnv(
      project,
      ["set", "UNDECLARED_KEY", "--secret", "--local"],
      { HACK_SECRETS_FILE_KEY: ["synthetic", "file", "1710"].join("-") }
    );

    expect(run.exitCode).toBe(0);
    const files = await tree(project);
    expect(files[".hack/.env"]).toBeUndefined();
    expect(JSON.stringify(files)).not.toContain(VALUE);
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "without a contract, set --local still writes .env",
  async () => {
    const project = await createProject({ contract: false });

    const run = await setLocal(project);

    expect(run.exitCode).toBe(0);
    expect((await tree(project))[".hack/.env"]).toContain(VALUE);
  },
  CLI_TEST_TIMEOUT_MS
);

async function runDoctor(project: Project) {
  const tools = join(project.root, "tools");
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, "bun"), "#!/bin/sh\necho 1.4.2\n", {
    mode: 0o700,
  });
  await writeFile(
    join(tools, "docker"),
    '#!/bin/sh\ncase "$1" in\ninfo|version) exit 0;;\nnetwork) echo "[]"; exit 0;;\nps) echo "[]"; exit 0;;\n*) exit 0;;\nesac\n',
    { mode: 0o700 }
  );
  await writeFile(join(tools, "mutagen"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  const proc = Bun.spawn(
    [
      process.env.HACK_TEST_CLI_BINARY ?? process.execPath,
      ...(process.env.HACK_TEST_CLI_BINARY ? [] : [ENTRYPOINT]),
      "doctor",
      "--migrate-env-config",
      "--no-interactive",
      "--path",
      project.projectRoot,
    ],
    {
      cwd: project.projectRoot,
      env: privateCliEnv({
        root: project.root,
        env: {
          PATH: `${tools}:/usr/bin:/bin`,
          HACK_MUTAGEN_PATH: join(tools, "mutagen"),
          HACK_HOME: join(project.root, "hack-home"),
          HACK_GLOBAL_CONFIG_PATH: join(project.root, "hack-config.json"),
          HACK_LOGGER: "console",
          HACK_NO_INTERACTIVE: "1",
          NO_COLOR: "1",
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  running.add(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  running.delete(proc);
  return { exitCode, output: stdout + stderr };
}

async function git(project: Project, args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd: project.projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout;
}

for (const lateContract of [false, true]) {
  test(
    lateContract
      ? "HACK-1713: no-contract set --local then doctor with a new contract keeps plaintext local"
      : "HACK-1712: doctor moves a contract dotenv value to an ignored local layer without output or tracked leakage",
    async () => {
      const project = await createProject({ contract: !lateContract });
      await git(project, ["init", "--quiet"]);
      if (lateContract) {
        expect((await setLocal(project)).exitCode).toBe(0);
        expect(
          await readFile(join(project.projectDir, ".env"), "utf8")
        ).toContain(VALUE);
        await writeFile(join(project.projectDir, "hack.env.json"), CONTRACT);
      }
      await git(project, [
        "add",
        ".hack/hack.env.json",
        ".hack/hack.config.json",
        ".hack/docker-compose.yml",
      ]);
      if (!lateContract) {
        await writeFile(
          join(project.projectDir, ".env"),
          `LOCAL_KEY=${VALUE}\n`
        );
      }
      const run = await runDoctor(project);
      expect(run.output).not.toContain(VALUE);
      expect(run.exitCode, run.output).toBe(0);
      const local = join(project.projectDir, "hack.env.local.yaml");
      expect(
        await readFile(
          join(project.projectDir, "hack.env.default.yaml"),
          "utf8"
        )
      ).not.toContain(VALUE);
      expect(await readFile(local, "utf8")).toContain(VALUE);
      expect(run.output).toContain(
        "Moved LOCAL_KEY to .hack/hack.env.local.yaml"
      );
      expect(await git(project, ["check-ignore", "--", local])).toContain(
        "hack.env.local.yaml"
      );
      await git(project, ["add", "."]);
      const tracked = (await git(project, ["ls-files", "-z"]))
        .split("\0")
        .filter(Boolean);
      expect(tracked).not.toContain(".hack/hack.env.local.yaml");
      for (const path of tracked) {
        expect(
          await readFile(join(project.projectRoot, path), "utf8")
        ).not.toContain(VALUE);
      }
    },
    CLI_TEST_TIMEOUT_MS
  );
}

test(
  "doctor refuses a local overlay file even when it adds no value of its own",
  async () => {
    const project = await createProject({ contract: true });
    await git(project, ["init", "--quiet"]);
    const text = `LOCAL_KEY=${VALUE}\n`;
    await writeFile(join(project.projectDir, ".env"), text);
    await writeFile(join(project.projectDir, ".env.local"), text);
    const run = await runDoctor(project);
    expect(run.exitCode).toBe(1);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(".env.local would collide");
    expect(await readFile(join(project.projectDir, ".env.local"), "utf8")).toBe(
      text
    );
    await expect(
      readFile(join(project.projectDir, "hack.env.default.yaml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "doctor refuses the reserved local overlay without exposing or losing plaintext",
  async () => {
    const project = await createProject({ contract: true });
    await git(project, ["init", "--quiet"]);
    await writeFile(join(project.projectDir, ".env"), `LOCAL_KEY=${VALUE}\n`);
    await writeFile(
      join(project.projectDir, ".env.local"),
      `LOCAL_KEY=${VALUE}-local\n`
    );
    const run = await runDoctor(project);
    expect(run.exitCode).toBe(1);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain('".env.local" uses a name reserved');
    expect(await readFile(join(project.projectDir, ".env"), "utf8")).toContain(
      VALUE
    );
    expect(
      await readFile(join(project.projectDir, "hack.env.json"), "utf8")
    ).toBe(CONTRACT);
    await expect(
      readFile(join(project.projectDir, "hack.env.default.yaml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
  CLI_TEST_TIMEOUT_MS
);

test(
  "doctor migration refuses an outdated read-only ignore file before writing plaintext",
  async () => {
    const project = await createProject({ contract: true });
    await git(project, ["init", "--quiet"]);
    const envPath = join(project.projectDir, ".env");
    const ignorePath = join(project.projectDir, ".gitignore");
    const original = `LOCAL_KEY=${VALUE}\n`;
    await writeFile(envPath, original);
    await writeFile(ignorePath, "# outdated fixture rules\n");
    await chmod(ignorePath, 0o444);
    const run = await runDoctor(project);
    expect(run.exitCode).toBe(1);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(".hack/.gitignore is read-only");
    expect(await readFile(envPath, "utf8")).toBe(original);
    expect(await readFile(ignorePath, "utf8")).toBe(
      "# outdated fixture rules\n"
    );
    expect(
      await readFile(join(project.projectDir, "hack.env.json"), "utf8")
    ).toBe(CONTRACT);
    for (const name of ["hack.env.local.yaml", "hack.env.default.yaml"]) {
      await expect(
        readFile(join(project.projectDir, name), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
  CLI_TEST_TIMEOUT_MS
);

test.each(["staging.local", "staging.LOCAL"])(
  "doctor migration refuses aliased overlay %s and keeps every legacy source",
  async (overlayName) => {
    const project = await createProject({ contract: true });
    await git(project, ["init", "--quiet"]);
    const sources = {
      ".env": `LOCAL_KEY=${VALUE}\n`,
      ".env.staging": `LOCAL_KEY=${VALUE}-staging\n`,
      [`.env.${overlayName}`]: `LOCAL_KEY=${VALUE}-other\n`,
    };
    for (const [name, text] of Object.entries(sources)) {
      await writeFile(join(project.projectDir, name), text);
    }
    const run = await runDoctor(project);
    expect(run.exitCode).toBe(1);
    expect(run.output).not.toContain(VALUE);
    expect(run.output).toContain(`".env.${overlayName}" uses a name reserved`);
    for (const [name, text] of Object.entries(sources)) {
      expect(await readFile(join(project.projectDir, name), "utf8")).toBe(text);
    }
    expect(
      await readFile(join(project.projectDir, "hack.env.json"), "utf8")
    ).toBe(CONTRACT);
    for (const name of [
      "hack.env.default.yaml",
      "hack.env.local.yaml",
      "hack.env.staging.yaml",
      "hack.env.staging.local.yaml",
      "hack.env.staging.local.local.yaml",
    ]) {
      await expect(
        readFile(join(project.projectDir, name), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
  CLI_TEST_TIMEOUT_MS
);
