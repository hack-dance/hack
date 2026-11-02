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
import {
  NATIVE_RUN_EMPTY_SELECTION_REFUSAL,
  NATIVE_RUN_SELECTION_REFUSAL,
} from "../src/backends/native-project-one-off.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * HACK-1276: native `hack run --profile X` after `hack up --profile X`. The
 * stub runtime answers the one-off protocol (dependency refresh, run
 * selection, run-service completion) for the saved run, so a run whose
 * selection matches the running one completes, and one that differs refuses
 * before any runtime request.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const ids = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  plan: "d".repeat(64),
  generation: "e".repeat(64),
  job: "f".repeat(32),
};
/** A JavaScript stack frame as Bun prints it. */
const STACK_FRAME = /^\s+at /m;
const CHILD_STDOUT = "1.4.2\n";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(opts: {
  readonly profiles?: readonly string[];
  readonly effectiveEnvName?: string | null;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-run-selection-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify({
      services: {
        toolchain: {
          image: "docker.io/library/busybox:1.37",
          profiles: ["toolchain"],
        },
      },
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "run-selection-fixture",
      dev_host: "run-selection-fixture.hack.local",
    })
  );
  const refresh = JSON.stringify({
    ok: true,
    run: ids.run,
    owner: ids.owner,
    namespace: ids.namespace,
    plan: ids.plan,
    generation: ids.generation,
    changed_slots: [],
  });
  const selection = JSON.stringify({
    run: ids.run,
    owner: ids.owner,
    namespace: ids.namespace,
    plan: ids.plan,
    service: "toolchain",
    generation: ids.generation,
    boot: "boot",
  });
  const completion = JSON.stringify({
    job: ids.job,
    cleanup_confirmed: true,
    exit_code: 0,
    stdout_base64: Buffer.from(CHILD_STDOUT).toString("base64"),
    stderr_base64: "",
    truncated: false,
  });
  const binary = join(root, "native-runtime");
  // argv: --candidate-root HOME graph <operation> ...
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/native-calls"
case "$4" in
  refresh-dependencies) printf '%s' '${refresh}' ;;
  run-selection) printf '%s' '${selection}' ;;
  run-service) cat > /dev/null; printf '%s' '${completion}' ;;
  *) printf '%s' '{"code":"runtime_not_running"}' >&2; exit 1 ;;
esac
`,
    { mode: 0o700 }
  );
  await saveNativeProjectRun({
    projectRoot: project,
    projectDir,
    nativeHome,
    branch: "alpha",
    run: {
      run: ids.run,
      owner: ids.owner,
      namespace: ids.namespace,
      planId: ids.plan,
      profiles: [...(opts.profiles ?? [])],
      effectiveEnvName: opts.effectiveEnvName ?? null,
      aws: null,
    },
  });
  const env = privateCliEnv({
    root,
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: binary,
      HACK_NATIVE_HOME: nativeHome,
      HACK_NO_INTERACTIVE: "1",
      HACK_LOGGER: "console",
    },
  });
  return { root, project, env };
}

async function cli(opts: {
  readonly fixture: Awaited<ReturnType<typeof fixture>>;
  readonly args: readonly string[];
}) {
  // Project selection goes first: after the child command every token
  // belongs to the child.
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      "--path",
      opts.fixture.project,
      "--branch",
      "alpha",
      ...opts.args,
    ],
    {
      cwd: opts.fixture.root,
      env: opts.fixture.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function nativeCalls(root: string): Promise<string[]> {
  const text = await readFile(
    join(privateCliHome(root), "native-calls"),
    "utf8"
  ).catch(() => "");
  return text.split("\n").filter(Boolean);
}

function operations(calls: readonly string[]): string[] {
  return calls.map((call) => call.split(" ")[3] ?? "");
}

test("run --profile with the running profile set runs the child command", async () => {
  const f = await fixture({ profiles: ["toolchain"] });
  const result = await cli({
    fixture: f,
    args: [
      "run",
      "--profile",
      "toolchain",
      "toolchain",
      "--",
      "bun",
      "--version",
    ],
  });
  expect(result.stderr).not.toMatch(STACK_FRAME);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(CHILD_STDOUT);
  const calls = await nativeCalls(f.root);
  expect(operations(calls)).toEqual([
    "refresh-dependencies",
    "run-selection",
    "run-service",
  ]);
  // The child argv reaches the runtime unchanged, after its separator.
  expect(calls[2]?.endsWith(" -- bun --version")).toBe(true);
}, 30_000);

test("a matching --env and an unordered, repeated profile list also run", async () => {
  const f = await fixture({
    profiles: ["toolchain", "tools"],
    effectiveEnvName: null,
  });
  const result = await cli({
    fixture: f,
    args: [
      "run",
      "--env",
      "base",
      "--profile",
      "toolchain,tools,toolchain",
      "toolchain",
      "bun",
      "--version",
    ],
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(CHILD_STDOUT);
  expect(operations(await nativeCalls(f.root))).toContain("run-service");
}, 30_000);

for (const request of [
  { name: "a different profile", args: ["--profile", "web"] },
  { name: "a subset of the running profiles", args: ["--profile", "tools"] },
  { name: "an extra profile", args: ["--profile", "toolchain,tools,web"] },
  { name: "a different env", args: ["--env", "staging"] },
]) {
  test(`run with ${request.name} refuses with one closed line and no runtime request`, async () => {
    const f = await fixture({ profiles: ["toolchain", "tools"] });
    const result = await cli({
      fixture: f,
      args: ["run", ...request.args, "toolchain", "bun", "--version"],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      `ERROR: E_USAGE: ${NATIVE_RUN_SELECTION_REFUSAL}`
    );
    expect(result.stderr).not.toContain("hack <command> [options]");
    expect(result.stderr).not.toContain("--help");
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(await nativeCalls(f.root)).toEqual([]);
  }, 30_000);
}

/**
 * HACK-1338: an empty `--env` or `--profile` is a closed usage error, never a
 * silent "inherit" or an explicit empty selection. The fixture runs with no
 * profiles and the base env, so without this rule `--env ""` (base) and
 * `--profile ""` (no profiles) would match the running selection and run.
 */
for (const request of [
  { name: "an empty --env", args: ["--env", ""] },
  { name: "an empty --env=", args: ["--env="] },
  { name: "a whitespace --env", args: ["--env", "  "] },
  { name: "an empty --profile", args: ["--profile", ""] },
  { name: "a comma-only --profile", args: ["--profile", " , "] },
]) {
  test(`run with ${request.name} refuses with one closed line and no runtime request`, async () => {
    const f = await fixture({ profiles: [], effectiveEnvName: null });
    const result = await cli({
      fixture: f,
      args: ["run", ...request.args, "toolchain", "bun", "--version"],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      `ERROR: E_USAGE: ${NATIVE_RUN_EMPTY_SELECTION_REFUSAL}`
    );
    expect(result.stderr).not.toMatch(STACK_FRAME);
    expect(await nativeCalls(f.root)).toEqual([]);
  }, 30_000);
}

/**
 * HACK-1371: a profile list is empty only when every entry is. An empty entry
 * beside a real profile is dropped, so the list is compared with the running
 * selection like any other: it runs when the real entries match and refuses
 * with the mismatch refusal (not the empty one) when they differ.
 */
for (const profile of ["toolchain,", ",toolchain", " , toolchain , "]) {
  test(`run --profile ${JSON.stringify(profile)} keeps its real entry and runs`, async () => {
    const f = await fixture({ profiles: ["toolchain"] });
    const result = await cli({
      fixture: f,
      args: ["run", "--profile", profile, "toolchain", "bun", "--version"],
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(CHILD_STDOUT);
    expect(operations(await nativeCalls(f.root))).toEqual([
      "refresh-dependencies",
      "run-selection",
      "run-service",
    ]);
  }, 30_000);
}

test('run --profile "web," with a different running profile refuses as a mismatch', async () => {
  const f = await fixture({ profiles: ["toolchain"] });
  const result = await cli({
    fixture: f,
    args: ["run", "--profile", "web,", "toolchain", "bun", "--version"],
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    `ERROR: E_USAGE: ${NATIVE_RUN_SELECTION_REFUSAL}\n`
  );
  expect(await nativeCalls(f.root)).toEqual([]);
}, 30_000);

test("run without --env or --profile still inherits the running selection", async () => {
  const f = await fixture({ profiles: [], effectiveEnvName: null });
  const result = await cli({
    fixture: f,
    args: ["run", "toolchain", "bun", "--version"],
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(CHILD_STDOUT);
  expect(operations(await nativeCalls(f.root))).toContain("run-service");
}, 30_000);
