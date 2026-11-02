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
 * Fresh native exec distinguishes a selection that changed since startup from
 * an environment that cannot be resolved (HACK-1297). The fake runtime answers
 * the read-only requests of a ready run and records every call.
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
const container = "e".repeat(64);
const STACK_FRAME = /^\s+at /m;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(opts: { readonly composeServices: readonly string[] }) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-exec-selection-cli-"))
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
      services: Object.fromEntries(
        opts.composeServices.map((name) => [
          name,
          { image: "docker.io/library/busybox:1.37" },
        ])
      ),
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "exec-selection-fixture",
      dev_host: "exec-selection-fixture.hack.local",
    })
  );
  const refreshed = JSON.stringify({
    ok: true,
    ...run,
    plan: run.planId,
    generation: "f".repeat(64),
    changed_slots: [],
  });
  const snapshot = JSON.stringify({
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id: container,
          phase: "started",
        },
      },
    },
    journal_incomplete: false,
    observations: { "container:web": { state: "running", health: "healthy" } },
  });
  const selection = JSON.stringify({
    ...run,
    plan: run.planId,
    service: "web",
    container,
    generation: "f".repeat(64),
    boot: "fixture-boot",
  });
  const binary = join(root, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/native-calls"
case "$4" in
  refresh-dependencies) printf '%s' '${refreshed}' ;;
  inspect) printf '%s' '${snapshot}' ;;
  exec-selection) printf '%s' '${selection}' ;;
  *) printf '%s' '{"code":"unexpected_request"}' >&2; exit 1 ;;
esac
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
  return { root, project, projectDir, env };
}

async function exec(f: Awaited<ReturnType<typeof fixture>>) {
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      "--path",
      f.project,
      "--branch",
      "alpha",
      "exec",
      "web",
      "ls",
    ],
    {
      cwd: f.root,
      env: f.env,
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
  return { output: stdout + stderr, code };
}

async function nativeCalls(root: string): Promise<string[]> {
  const text = await readFile(
    join(privateCliHome(root), "native-calls"),
    "utf8"
  ).catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[3] ?? "");
}

test("fresh native exec reports a service removed since startup as a changed selection", async () => {
  // The running graph has `web`; the current configuration no longer selects it.
  const f = await fixture({ composeServices: ["api"] });
  const result = await exec(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    "E_CONFIG_INVALID: Native fresh exec selection changed since startup: the service, environment or overlay this run started with is no longer selected. Restart the project to apply the current configuration; no command was requested. Values omitted."
  );
  expect(result.output).not.toContain("could not be resolved");
  expect(result.output).not.toMatch(STACK_FRAME);
  // Refused before any exec request reached the runtime.
  expect(await nativeCalls(f.root)).toEqual([
    "refresh-dependencies",
    "inspect",
    "exec-selection",
  ]);
}, 30_000);

test("fresh native exec reports unresolvable values apart from a changed selection", async () => {
  const f = await fixture({ composeServices: ["web"] });
  await writeFile(
    join(f.projectDir, "hack.env.default.yaml"),
    "values: [synthetic-unparseable"
  );
  const result = await exec(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    "E_CONFIG_INVALID: Native fresh exec environment could not be resolved; no command was requested. Values omitted."
  );
  expect(result.output).not.toContain("selection changed");
  expect(result.output).not.toContain("synthetic-unparseable");
  expect(result.output).not.toMatch(STACK_FRAME);
  expect(await nativeCalls(f.root)).toEqual([
    "refresh-dependencies",
    "inspect",
    "exec-selection",
  ]);
}, 30_000);
