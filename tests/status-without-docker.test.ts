import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGlobalCaddyIp } from "../src/lib/caddy-hosts.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2046. With no `docker` executable on PATH, `hack status` printed the
 * project table and then crashed with an uncaught spawn error from the global
 * Caddy lookup. `hack projects --json` already reported the same state as
 * `runtime_error` and exited 0.
 */

const repoRoot = join(import.meta.dir, "..");
let root = "";
let project = "";
let emptyBin = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-status-nodocker-")));
  project = join(root, "project");
  emptyBin = join(root, "empty-bin");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(emptyBin);
  await Bun.write(
    join(project, ".hack", "hack.config.json"),
    '{"name":"nodocker-fixture"}\n'
  );
  await Bun.write(
    join(project, ".hack", "docker-compose.yml"),
    "services:\n  web:\n    image: example/web:1\n"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function hack(args: readonly string[]) {
  const child = Bun.spawn(
    [process.execPath, join(repoRoot, "index.ts"), ...args],
    {
      cwd: project,
      env: privateCliEnv({
        root,
        // A PATH with no executables at all: `docker` cannot be found.
        env: { PATH: emptyBin, HACK_LOGGER: "console", NO_COLOR: "1" },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr, all: stdout + stderr };
}

test("hack status without docker on PATH keeps the project rows, says why, and exits 0", async () => {
  const result = await hack(["status"]);
  expect(result.all).not.toContain("Executable not found");
  expect(result.all).not.toContain("    at ");
  expect(result.code).toBe(0);
  // The rows and the per-project details are still there.
  expect(result.stdout).toContain("nodocker-fixture");
  expect(result.stdout).toContain("Repo root");
  // One short note names the cause.
  expect(
    result.all.split("docker is not installed or not on PATH").length
  ).toBe(2);
}, 60_000);

test("hack projects --json reports the same state as runtime_error (control)", async () => {
  const result = await hack(["projects", "--json"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    runtime_ok: boolean;
    runtime_error: string;
    projects: { name: string }[];
  };
  expect(parsed.runtime_ok).toBe(false);
  expect(parsed.runtime_error).toBe("docker is not installed or not on PATH");
  expect(parsed.projects.map((entry) => entry.name)).toEqual([
    "nodocker-fixture",
  ]);
}, 60_000);

test("the global Caddy lookup answers null when docker cannot be started", async () => {
  const previous = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    expect(await resolveGlobalCaddyIp()).toBeNull();
  } finally {
    restoreEnv("PATH", previous);
  }
});
