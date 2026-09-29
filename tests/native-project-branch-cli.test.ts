import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadNativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const refusal = "Native runtime request failed";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(approveSource = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-branch-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  const home = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(home);
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify({
      services: { web: { image: "docker.io/library/busybox:1.37" } },
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "branch-fixture",
      dev_host: "branch-fixture.hack.local",
      lifecycle: { up: { before: ["touch hook-ran"] } },
    })
  );
  const binary = join(root, "native-tripwire");
  await writeFile(join(root, "hack-relay-guest"), "synthetic fixture artifact");
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$4" = "check-project-share" ]; then
  touch "$HOME/preflight-ran"
  ${approveSource ? `printf '%s\\n' '{"source_admitted":true,"pool_initialized":false}'\n  exit 0` : "exit 71"}
fi
touch "$HOME/native-ran"
exit 71
`,
    {
      mode: 0o700,
    }
  );
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    HACK_HOME: join(home, ".hack"),
    HACK_RUNTIME_BACKEND: "native",
    HACK_NATIVE_BINARY: binary,
    HACK_NATIVE_HOME: nativeHome,
    HACK_NATIVE_SHARED_SOURCE: "1",
    HACK_NO_INTERACTIVE: "1",
    HACK_LOGGER: "console",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  return { root, project, nativeHome, home, env };
}

async function invoke(opts: {
  fixture: Awaited<ReturnType<typeof fixture>>;
  command: "up" | "restart";
  project?: string;
  branch?: string;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      opts.command,
      "--path",
      opts.project ?? opts.fixture.project,
      ...(opts.branch ? ["--branch", opts.branch] : []),
    ],
    {
      cwd: opts.fixture.root,
      env: opts.fixture.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output: stdout + stderr, code };
}

async function assertNoEffects(
  f: Awaited<ReturnType<typeof fixture>>,
  project: string
) {
  expect(await Bun.file(join(project, "hook-ran")).exists()).toBe(false);
  expect(await Bun.file(join(f.home, "native-ran")).exists()).toBe(false);
  expect(await Bun.file(join(f.home, "preflight-ran")).exists()).toBe(true);
  expect(await Bun.file(join(f.home, ".hack/projects.json")).exists()).toBe(
    false
  );
  expect(await readdir(f.nativeHome)).toEqual([]);
}

for (const command of ["up"] as const) {
  test(`native ${command} refuses an explicit branch before hooks or runtime effects`, async () => {
    const f = await fixture();
    const result = await invoke({ fixture: f, command, branch: "feature/new" });
    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    await assertNoEffects(f, f.project);
  });

  test(`native ${command} refuses an automatically selected linked-worktree branch`, async () => {
    const f = await fixture();
    const linked = join(f.root, "linked");
    for (const args of [
      ["init", "-b", "main"],
      ["add", "."],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      ["worktree", "add", "-b", "feature/linked", linked],
    ]) {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: f.project,
        env: f.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    }
    const result = await invoke({ fixture: f, command, project: linked });
    expect(result.code).toBe(1);
    expect(result.output).toContain(refusal);
    await assertNoEffects(f, linked);
  });
}

test("native base startup still reaches the selected executor (tripwire control)", async () => {
  const f = await fixture();
  const result = await invoke({ fixture: f, command: "up" });
  expect(result.code).toBe(1);
  expect(result.output).toContain(refusal);
  expect(await Bun.file(join(f.home, "preflight-ran")).exists()).toBe(true);
  expect(await Bun.file(join(f.home, "native-ran")).exists()).toBe(false);
});

test("admitted native branch startup runs hooks before runtime up", async () => {
  const f = await fixture(true);
  const result = await invoke({
    fixture: f,
    command: "up",
    branch: "feature/new",
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain(refusal);
  expect(await Bun.file(join(f.home, "preflight-ran")).exists()).toBe(true);
  expect(await Bun.file(join(f.project, "hook-ran")).exists()).toBe(true);
  expect(await Bun.file(join(f.home, "native-ran")).exists()).toBe(true);
});

test("native branch restart checks source before cleanup and preserves its mapping", async () => {
  const f = await fixture();
  const scope = {
    projectRoot: f.project,
    projectDir: join(f.project, ".hack"),
    nativeHome: f.nativeHome,
    branch: "feature-new",
  };
  const run = {
    run: "a".repeat(32),
    owner: "b".repeat(32),
    namespace: "c".repeat(64),
    planId: "d".repeat(64),
    profiles: [],
    effectiveEnvName: null,
    aws: null,
  };
  await saveNativeProjectRun({ ...scope, run });
  const result = await invoke({
    fixture: f,
    command: "restart",
    branch: "feature/new",
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain(refusal);
  expect(await Bun.file(join(f.home, "preflight-ran")).exists()).toBe(true);
  expect(await Bun.file(join(f.project, "hook-ran")).exists()).toBe(false);
  expect(await Bun.file(join(f.home, "native-ran")).exists()).toBe(false);
  expect(await loadNativeProjectRun(scope)).toEqual(run);
});
