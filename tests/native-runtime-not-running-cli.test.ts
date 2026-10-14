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
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * A stopped native runtime is an ordinary state for read-only commands. The
 * fake runtime binary answers every request the way the candidate does when
 * its runtime is stopped: a closed `{"code": ...}` on stderr and exit 1.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  profiles: [],
  effectiveEnvName: null,
  aws: null,
};
/** A JavaScript stack frame as Bun prints it. */
const STACK_FRAME = /^\s+at /m;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(opts: { readonly nativeCode: string }) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-not-running-cli-"))
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
      services: { web: { image: "docker.io/library/busybox:1.37" } },
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "not-running-fixture",
      dev_host: "not-running-fixture.hack.local",
    })
  );
  const binary = join(root, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/native-calls"
printf '%s' '{"code":"${opts.nativeCode}"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  await saveNativeProjectRun({
    projectRoot: project,
    projectDir,
    nativeHome,
    branch: "alpha",
    run,
  });
  const env = (extra: Record<string, string> = {}) =>
    privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
        ...extra,
      },
    });
  return { root, project, env };
}

async function cli(opts: {
  readonly fixture: Awaited<ReturnType<typeof fixture>>;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      ...opts.args,
      "--path",
      opts.fixture.project,
      "--branch",
      "alpha",
    ],
    {
      cwd: opts.fixture.root,
      env: opts.fixture.env(opts.env),
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

test("native ps reports a stopped runtime as a status, not a failure", async () => {
  const f = await fixture({ nativeCode: "runtime_not_running" });
  const result = await cli({ fixture: f, args: ["ps"] });
  const output = result.stdout + result.stderr;
  expect(result.code).toBe(0);
  expect(output).toContain(
    "Native runtime is not running; no services are running."
  );
  expect(output).toContain("NATIVE SERVICE");
  expect(output).not.toContain("Native runtime request failed");
  expect(output).not.toMatch(STACK_FRAME);
  // The read reached the runtime exactly once (graph inspect for the mapping).
  expect(await nativeCalls(f.root)).toEqual([
    `--candidate-root ${join(f.root, "native-home")} graph inspect --run-id ${run.run} --json`,
  ]);
});

test("native ps --json returns the ok envelope with runtime_not_running", async () => {
  const f = await fixture({ nativeCode: "runtime_not_running" });
  const result = await cli({ fixture: f, args: ["ps", "--json"] });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    data: {
      backend: "native",
      status: "runtime_not_running",
      run: run.run,
      phase: null,
      items: [],
    },
  });
  expect(result.stderr).not.toMatch(STACK_FRAME);
});

test("native logs --no-follow refuses a stopped runtime with a closed message", async () => {
  const f = await fixture({ nativeCode: "runtime_not_running" });
  const human = await cli({ fixture: f, args: ["logs", "web", "--no-follow"] });
  expect(human.code).toBe(1);
  expect(human.stdout + human.stderr).toContain(
    "E_DOCKER_UNAVAILABLE: Native runtime is not running; no service logs are available."
  );
  expect(human.stdout + human.stderr).not.toMatch(STACK_FRAME);

  const json = await cli({
    fixture: f,
    args: ["logs", "web", "--no-follow", "--json"],
  });
  expect(json.code).toBe(1);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_DOCKER_UNAVAILABLE" },
  });
  expect(json.stderr).not.toMatch(STACK_FRAME);
});

test("other native refusals still fail ps, with the closed message and no stack", async () => {
  const f = await fixture({ nativeCode: "graph_journal_incomplete" });
  const result = await cli({ fixture: f, args: ["ps"] });
  const output = result.stdout + result.stderr;
  expect(result.code).toBe(1);
  expect(output).toContain(
    "Native runtime request failed (graph_journal_incomplete); inspect owned state before retrying."
  );
  // Printed once: not repeated as the head of a stack trace.
  expect(output.split("Native runtime request failed").length - 1).toBe(1);
  expect(output).not.toMatch(STACK_FRAME);

  const json = await cli({ fixture: f, args: ["ps", "--json"] });
  expect(json.code).toBe(1);
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: false });
  expect(json.stderr).not.toMatch(STACK_FRAME);
});

test("HACK_DEBUG=1 adds the stack to a closed native refusal", async () => {
  const f = await fixture({ nativeCode: "graph_journal_incomplete" });
  const result = await cli({
    fixture: f,
    args: ["ps"],
    env: { HACK_DEBUG: "1" },
  });
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).toMatch(STACK_FRAME);
});
