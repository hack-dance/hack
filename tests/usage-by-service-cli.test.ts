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

test("--project resolves the registered project and its Compose name, with branch instances", async () => {
  // Registered as "shop"; Compose runs it as "shop-runtime". A different
  // project that happens to be named "shop" must not be measured.
  const shopRoot = join(root, "shop");
  await mkdir(join(shopRoot, ".hack"), { recursive: true });
  await writeFile(
    join(shopRoot, ".hack", "docker-compose.yml"),
    "name: shop-runtime\nservices:\n  api:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(shopRoot, ".hack", "hack.config.json"),
    `${JSON.stringify({ name: "shop", dev_host: "shop.hack" })}\n`
  );
  const state = join(root, "state");
  await mkdir(state);
  await writeFile(
    join(state, "projects.json"),
    `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: "shop-identity",
          name: "shop",
          repoRoot: shopRoot,
          projectDir: join(shopRoot, ".hack"),
          projectDirName: ".hack",
          devHost: "shop.hack",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    })}\n`
  );
  const row = (id: string, project: string, service: string) =>
    JSON.stringify({
      ID: id,
      State: "running",
      Status: "Up",
      Names: id,
      Labels: `com.docker.compose.project=${project},com.docker.compose.service=${service}`,
    });
  const stat = (id: string, cpu: string, mem: string) =>
    JSON.stringify({ ID: id, CPUPerc: cpu, MemUsage: `${mem} / 1GiB` });
  await writeFile(
    join(root, "ps.out"),
    [
      row("c1", "shop-runtime", "api"),
      row("c2", "shop-runtime", "api"),
      row("c3", "shop-runtime--feat", "api"),
      row("c4", "shop", "api"),
      "",
    ].join("\n")
  );
  await writeFile(
    join(root, "stats.out"),
    [
      stat("c1", "1.00%", "10MiB"),
      stat("c2", "2.00%", "20MiB"),
      stat("c3", "4.00%", "40MiB"),
      stat("c4", "50.00%", "500MiB"),
      "",
    ].join("\n")
  );
  await writeFile(
    join(root, "bin", "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      `  ps) cat "${join(root, "ps.out")}" ;;`,
      '  inspect) echo "[]" ;;',
      `  stats) cat "${join(root, "stats.out")}" ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );

  const result = await runUsage(
    ["--json", "--by-service", "--project", "shop"],
    {
      HACK_HOME: state,
      HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
    }
  );

  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.project).toBe("shop-runtime");
  expect(
    data.services.map(
      (service: Record<string, unknown>) =>
        `${service.composeProject}/${service.service}/${service.containers}/${service.cpuPercent}`
    )
  ).toEqual(["shop-runtime/api/2/3", "shop-runtime--feat/api/1/4"]);
}, 60_000);
