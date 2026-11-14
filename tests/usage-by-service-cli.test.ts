import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2218 R3: `hack usage --json --by-service` is the standard envelope with
 * `schema: "hack.usage.by-service.v1"`. A stub `docker` answers `docker ps`:
 * with nothing (a stopped project) or with a daemon failure.
 */
const CLI = resolve(import.meta.dir, "..", "index.ts");

const STUB = [
  "#!/bin/sh",
  'if [ "$1" = "ps" ]; then',
  '  if [ "$STUB_DOCKER_DOWN" = "1" ]; then',
  '    echo "Cannot connect to the Docker daemon" >&2',
  "    exit 1",
  "  fi",
  "  exit 0",
  "fi",
  "exit 0",
  "",
].join("\n");

let root: string;
let projectRoot: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-usage-svc-")));
  projectRoot = join(root, "project");
  const hackDir = join(projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "sample",
      dev_host: "sample.hack",
      internal: { dns: false, tls: false },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    ["services:", "  api:", "    image: alpine:3.22", ""].join("\n")
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runUsage(
  args: readonly string[],
  env: Record<string, string> = {}
) {
  const child = Bun.spawn([process.execPath, CLI, "usage", ...args], {
    cwd: root,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HACK_NO_INTERACTIVE: "1",
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
        ...env,
      },
    }),
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

test("a project with nothing running is an empty service list with the schema", async () => {
  const result = await runUsage([
    "--json",
    "--by-service",
    "--path",
    projectRoot,
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    data: {
      schema: "hack.usage.by-service.v1",
      project: "sample",
      backend: "compose",
      services: [],
    },
  });
}, 60_000);

test("an unreachable Docker runtime is E_DOCKER_UNAVAILABLE with exit 1", async () => {
  const result = await runUsage(
    ["--json", "--by-service", "--path", projectRoot],
    { STUB_DOCKER_DOWN: "1" }
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_DOCKER_UNAVAILABLE" },
  });
}, 60_000);

test("a path without a project is E_PROJECT_NOT_FOUND", async () => {
  const empty = join(root, "empty");
  await mkdir(empty);
  const result = await runUsage(["--json", "--by-service", "--path", empty]);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_PROJECT_NOT_FOUND" },
  });
}, 60_000);

test("--by-service without --json and --path without --by-service are usage errors", async () => {
  const noJson = await runUsage(["--by-service", "--path", projectRoot]);
  expect(noJson.exitCode).not.toBe(0);
  expect(noJson.stdout + noJson.stderr).toContain(
    "--by-service requires --json."
  );

  const noByService = await runUsage(["--json", "--path", projectRoot]);
  expect(noByService.exitCode).not.toBe(0);
  expect(JSON.parse(noByService.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_USAGE",
      message: "--path is supported only with --by-service.",
    },
  });
}, 60_000);
