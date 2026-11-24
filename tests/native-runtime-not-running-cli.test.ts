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
import { NATIVE_RUN_SELECTION_REFUSAL } from "../src/backends/native-project-one-off.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { nativeSetupShellReply } from "./helpers/native-setup-inspection.ts";
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

async function fixture(opts: { readonly nativeCode?: string }) {
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
      services: {
        web: {
          image: "docker.io/library/busybox:1.37",
          labels: { caddy: "sample.hack" },
        },
        worker: { image: "docker.io/library/busybox:1.37" },
      },
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "not-running-fixture",
      dev_host: "sample.hack.local",
    })
  );
  const binary = join(root, "native-runtime");
  const graph = {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      resources: Object.fromEntries(
        ["web", "worker"].map((service) => [
          `container:${service}`,
          {
            kind: "container",
            key: service,
            id: "e".repeat(64),
            phase: "started",
          },
        ])
      ),
    },
    journal_incomplete: false,
    observations: {
      "container:web": { state: "running", health: "healthy" },
      "container:worker": { state: "exited", code: 1 },
    },
  };
  const reply = opts.nativeCode
    ? `printf '%s' '${JSON.stringify({ code: opts.nativeCode })}' >&2\nexit 1`
    : `printf '%s' '${JSON.stringify(graph)}'`;
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/native-calls"
${nativeSetupShellReply()}
${reply}
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
  // Project selection goes first: after a child command (`run web bun ...`)
  // every token belongs to the child.
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
  const result = await cli({
    fixture: f,
    args: ["ps"],
    env: { NO_COLOR: "1", COLUMNS: "20" },
  });
  const output = result.stdout + result.stderr;
  expect(result.code).toBe(0);
  expect(output).toContain(
    "Native runtime is not running; no services are running."
  );
  expect(result.stdout).toContain("SERVICE  ADDRESS  STATE\n\n0 services\n");
  expect(output).not.toContain("Native runtime request failed");
  expect(output).not.toMatch(STACK_FRAME);
  // Default text reads the graph once without a supplemental image lookup.
  expect(await nativeCalls(f.root)).toEqual([
    `--candidate-root ${join(f.root, "native-home")} graph status --run-id ${run.run} --json`,
  ]);
});

test("native ps keeps the complete address on a narrow plain terminal", async () => {
  const f = await fixture({});
  const result = await cli({
    fixture: f,
    args: ["ps"],
    env: { NO_COLOR: "1", COLUMNS: "20" },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    [
      "SERVICE  ADDRESS                    STATE",
      "web      https://alpha.sample.hack  healthy",
      "worker   no address                 exited (1)",
      "",
      "2 services",
      "",
    ].join("\n")
  );
});

test("native ps observes services despite an invalid startup-only setting", async () => {
  const f = await fixture({});
  const value = "invalid-fixture-setting";
  const env = { HACK_NATIVE_HOT_RELOAD: value, NO_COLOR: "1" };
  const ps = await cli({ fixture: f, args: ["ps"], env });
  expect(ps.code).toBe(0);
  expect(ps.stdout).toMatch(/web +https:\/\/alpha.sample.hack +healthy/);
  expect(ps.stdout).toContain("exited (1)");
  const up = await cli({ fixture: f, args: ["up"], env });
  expect(up.code).toBe(1);
  expect(up.stdout + up.stderr).toContain(
    "HACK_NATIVE_HOT_RELOAD must be auto, on or off."
  );
  expect(up.stdout + up.stderr).not.toContain(value);
});

test("native ps keeps observing when HTTPS settings cannot supply an address", async () => {
  const f = await fixture({});
  const value = "invalid-fixture-port";
  const ps = await cli({
    fixture: f,
    args: ["ps"],
    env: { HACK_NATIVE_HTTPS_PORT: value, NO_COLOR: "1" },
  });
  expect(ps.code).toBe(0);
  expect(ps.stdout).toMatch(/web +no address +healthy/);
  expect(ps.stdout).toContain(
    "native https settings invalid · addresses unavailable"
  );
  expect(ps.stdout + ps.stderr).not.toContain(value);
});

test("native ps reports the configured HTTPS frontend port", async () => {
  const f = await fixture({});
  const result = await cli({
    fixture: f,
    args: ["ps"],
    env: {
      HACK_NATIVE_CADDY_BINARY: join(f.root, "caddy"),
      HACK_NATIVE_CADDY_SHA256: "a".repeat(64),
      HACK_NATIVE_HTTPS_PORT: "18443",
      NO_COLOR: "1",
    },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("https://alpha.sample.hack:18443  healthy");
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

test("a native run with a differing profile prints one closed refusal, not the help or Hack's version", async () => {
  const f = await fixture({ nativeCode: "runtime_not_running" });
  const result = await cli({
    fixture: f,
    args: ["run", "--profile", "toolchain", "web", "bun", "--version"],
  });
  const output = result.stdout + result.stderr;
  expect(result.code).toBe(1);
  // The saved run started with no profiles; `toolchain` differs (HACK-1276).
  expect(output.trim()).toBe(`ERROR: E_USAGE: ${NATIVE_RUN_SELECTION_REFUSAL}`);
  expect(output).not.toContain("hack <command> [options]");
  expect(result.stdout).not.toMatch(/^hack v\d/m);
  expect(output).not.toMatch(STACK_FRAME);
  expect(await nativeCalls(f.root)).toEqual([]);
}, 30_000);

test("a child --version reaches the native one-off instead of printing Hack's version", async () => {
  const f = await fixture({ nativeCode: "runtime_not_running" });
  const result = await cli({
    fixture: f,
    args: ["run", "web", "bun", "--version"],
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toMatch(/^hack v\d/m);
  expect(result.stdout + result.stderr).not.toMatch(STACK_FRAME);
  // The one-off reached the runtime (which reports itself stopped).
  expect((await nativeCalls(f.root)).length).toBeGreaterThan(0);
}, 30_000);

test("native exec and run against a stopped runtime say so and how to recover", async () => {
  const f = await fixture({ nativeCode: "runtime_not_running" });
  for (const args of [
    ["exec", "web", "ls"],
    ["run", "web", "ls"],
  ]) {
    const result = await cli({ fixture: f, args });
    const output = result.stdout + result.stderr;
    expect(result.code).toBe(1);
    expect(output).toContain(
      "E_DOCKER_UNAVAILABLE: Native runtime is not running; no dependency refresh or command was requested. Start the native runtime and retry."
    );
    expect(output).not.toContain("identity or outcome is unconfirmed");
    expect(output).not.toMatch(STACK_FRAME);
  }
  // Each command looked once whether the run is warming (the stopped runtime
  // decides nothing there), then stopped at the refused dependency refresh.
  const refresh = `--candidate-root ${join(f.root, "native-home")} graph refresh-dependencies --run-id ${run.run} --json`;
  const look = `--candidate-root ${join(f.root, "native-home")} graph status --run-id ${run.run} --json`;
  expect(await nativeCalls(f.root)).toEqual([look, refresh, look, refresh]);
}, 30_000);

test("other refused dependency refreshes keep the unconfirmed refusal", async () => {
  const f = await fixture({ nativeCode: "graph_dependency_refresh_refused" });
  const result = await cli({ fixture: f, args: ["exec", "web", "ls"] });
  const output = result.stdout + result.stderr;
  expect(result.code).toBe(1);
  expect(output).toContain(
    "Native dependency refresh identity or outcome is unconfirmed; inspect the owned graph before retrying. No request or command was replayed. Native diagnostic: graph_dependency_refresh_refused."
  );
  expect(output).not.toMatch(STACK_FRAME);
}, 30_000);
