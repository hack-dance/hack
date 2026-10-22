import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1277: `hack logs --no-follow` reads Loki by default. A one-shot service
 * that exited before Alloy discovered it has no Loki entries, while
 * `docker compose logs` still has its output. The CLI must answer from compose
 * (implicit Loki) or hint at `--compose` (explicit Loki). A stub `docker` and an
 * in-process fake Loki stand in for the engine and the global logging stack.
 */
const CLI = resolve(import.meta.dir, "..", "index.ts");
const COMPOSE_LINE = "migrate-1  | migrations applied (from compose)";

const STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_CAPTURE/docker-args.log"',
  'if [ "$1" = "compose" ]; then',
  '  case " $* " in',
  `    *" logs "*) printf "%s\\n" "${COMPOSE_LINE}"; exit 0 ;;`,
  "    *) exit 0 ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

let root: string;
let projectRoot: string;
let capture: string;
let lokiStreams: unknown[] = [];
const lokiQueries: string[] = [];
let fakeLoki: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  fakeLoki = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/ready") {
        return new Response("ready");
      }
      if (url.pathname === "/loki/api/v1/query_range") {
        lokiQueries.push(url.searchParams.get("query") ?? "");
        return Response.json({
          status: "success",
          data: { resultType: "streams", result: lokiStreams },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  fakeLoki?.stop(true);
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-loki-empty-")));
  projectRoot = join(root, "project");
  capture = join(root, "capture");
  const hackDir = join(projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await mkdir(capture);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "oneshot",
      dev_host: "oneshot.hack",
      internal: { dns: false, tls: false },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    [
      "services:",
      "  migrate:",
      "    image: alpine:3.22",
      '    command: ["echo", "migrations applied"]',
      "",
    ].join("\n")
  );
});

afterEach(async () => {
  lokiStreams = [];
  lokiQueries.length = 0;
  await rm(root, { recursive: true, force: true });
});

async function runLogs(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, "logs", ...args], {
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        STUB_CAPTURE: capture,
        HACK_NO_INTERACTIVE: "1",
        HACK_LOKI_URL: `http://127.0.0.1:${fakeLoki?.port ?? 0}`,
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

async function composeLogsCalls(): Promise<string[]> {
  const log = await readFile(join(capture, "docker-args.log"), "utf8").catch(
    () => ""
  );
  return log.split("\n").filter((line) => / logs( |$)/.test(line));
}

test("implicit Loki snapshot with no entries answers from docker compose logs", async () => {
  const result = await runLogs(["--no-follow", "migrate"]);

  expect(result.exitCode).toBe(0);
  expect(lokiQueries).toEqual(['{project="oneshot",service="migrate"}']);
  expect(result.stderr).toContain(
    'Loki returned no log entries for {project="oneshot",service="migrate"}; showing docker compose logs instead'
  );
  expect(result.stdout).toContain("migrations applied (from compose)");
  expect(await composeLogsCalls()).toHaveLength(1);
}, 60_000);

test("explicit --loki snapshot with no entries hints at --compose and stays on Loki", async () => {
  const result = await runLogs(["--loki", "--no-follow", "migrate"]);

  expect(result.exitCode).toBe(0);
  expect(lokiQueries).toHaveLength(1);
  expect(result.stderr).toContain("try `hack logs --compose migrate`");
  expect(result.stdout).not.toContain("from compose");
  expect(await composeLogsCalls()).toEqual([]);
}, 60_000);

test("implicit Loki snapshot with entries prints Loki and skips compose", async () => {
  lokiStreams = [
    {
      stream: { project: "oneshot", service: "migrate" },
      values: [["1792584000000000000", "migrations applied (from loki)"]],
    },
  ];
  const result = await runLogs(["--no-follow", "migrate"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    "oneshot/migrate | 2026-10-21T12:00:00.000Z migrations applied (from loki)"
  );
  expect(result.stderr).not.toContain("Loki returned no log entries");
  expect(await composeLogsCalls()).toEqual([]);
}, 60_000);
