import { afterEach, beforeEach, expect, test } from "bun:test";
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
 * HACK-2218 R4: `hack logs --json` is a stable ndjson stream. The first line is
 * `start` with `schema: "hack.logs.v1"`, the last is one `end`, `--services`
 * selects several services on Compose, and `--max-line-bytes` bounds each
 * entry. A stub `docker` stands in for the engine; Loki is unreachable.
 */
const CLI = resolve(import.meta.dir, "..", "index.ts");
const LONG = `${"é".repeat(40)}tail`;

const STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "${0%/*}/../capture/docker-args.log"',
  'if [ "$1" = "compose" ]; then',
  '  case " $* " in',
  '    *" logs "*)',
  '      printf "%s\\n" "api-1     | 2026-01-02T03:04:05.000000000Z short"',
  `      printf "%s\\n" "worker-1  | 2026-01-02T03:04:06.000000000Z ${LONG}"`,
  "      exit 0 ;;",
  "    *) exit 0 ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

let root: string;
let projectRoot: string;
let capture: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-logs-ndjson-")));
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
      name: "sample",
      dev_host: "sample.hack",
      internal: { dns: false, tls: false },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    [
      "services:",
      "  api:",
      "    image: alpine:3.22",
      "  worker:",
      "    image: alpine:3.22",
      "  web:",
      "    image: alpine:3.22",
      "",
    ].join("\n")
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runLogs(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, "logs", ...args], {
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HACK_NO_INTERACTIVE: "1",
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
        // A closed port: Loki is unreachable, so snapshots use Compose.
        HACK_LOKI_URL: "http://127.0.0.1:9",
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

function parseLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("--json stream opens with the schema, reads every --services name and closes once", async () => {
  const result = await runLogs([
    "--json",
    "--no-follow",
    "--services",
    "api,worker",
  ]);

  expect(result.exitCode).toBe(0);
  const lines = parseLines(result.stdout);
  expect(lines[0]).toMatchObject({
    schema: "hack.logs.v1",
    type: "start",
    backend: "compose",
    services: ["api", "worker"],
    follow: false,
  });
  expect(lines.slice(1, -1).every((line) => line.type === "log")).toBe(true);
  expect(lines.slice(1).some((line) => "schema" in line)).toBe(false);
  expect(lines.at(-1)).toMatchObject({ type: "end", reason: "eof" });
  expect(lines.filter((line) => line.type === "end")).toHaveLength(1);
  const calls = await composeLogsCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.endsWith(" api worker")).toBe(true);
}, 60_000);

test("the positional service merges with --services and Compose accepts the pair", async () => {
  const result = await runLogs([
    "--json",
    "--no-follow",
    "--compose",
    "--services",
    "api",
    "worker",
  ]);

  expect(result.exitCode).toBe(0);
  expect(parseLines(result.stdout)[0]).toMatchObject({
    services: ["api", "worker"],
  });
  expect((await composeLogsCalls())[0]?.endsWith(" api worker")).toBe(true);
}, 60_000);

test("--max-line-bytes keeps a UTF-8 prefix of each entry and marks it truncated", async () => {
  const result = await runLogs([
    "--json",
    "--no-follow",
    "--max-line-bytes",
    "51",
  ]);

  expect(result.exitCode).toBe(0);
  const lines = parseLines(result.stdout);
  expect(lines[0]).toMatchObject({ type: "start", max_line_bytes: 51 });
  const entries = lines
    .filter((line) => line.type === "log")
    .map((line) => line.entry as Record<string, unknown>);
  const short = entries.find((entry) => entry.service === "api");
  const long = entries.find((entry) => entry.service === "worker");
  expect(short?.message).toBe("short");
  expect(short?.truncated).toBeUndefined();
  // "é" is two bytes, so 51 bytes keep 25 of them, never half a character.
  expect(long?.message).toBe("é".repeat(25));
  expect(long?.truncated).toBe(true);
  expect(
    new TextEncoder().encode(String(long?.raw)).length
  ).toBeLessThanOrEqual(51);
}, 60_000);

test("--max-line-bytes without --json is a usage error", async () => {
  const result = await runLogs(["--no-follow", "--max-line-bytes", "64"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(
    "--max-line-bytes requires --json."
  );
  expect(await composeLogsCalls()).toEqual([]);
}, 60_000);

test("an invalid --max-line-bytes under --json is an ok:false envelope", async () => {
  const result = await runLogs([
    "--json",
    "--no-follow",
    "--max-line-bytes",
    "0",
  ]);

  expect(result.exitCode).not.toBe(0);
  // One envelope document, not a stream: nothing started.
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_USAGE",
      message: expect.stringContaining(
        "--max-line-bytes requires a whole number"
      ),
    },
  });
  expect(await composeLogsCalls()).toEqual([]);
}, 60_000);

test("--services splits Compose services from lifecycle processes", async () => {
  // A lifecycle log for `hack up` processes; `dev` is not a Compose service.
  const lifecycleDir = join(projectRoot, ".hack", ".internal", "lifecycle");
  await mkdir(lifecycleDir, { recursive: true });
  await writeFile(
    join(lifecycleDir, "sample.log"),
    [
      "2026-01-02T03:04:07.000Z\tdev\tstdout\tdev ready",
      "2026-01-02T03:04:08.000Z\tother\tstdout\tnot requested",
      "",
    ].join("\n")
  );

  // A slow `tail`: Compose finishes first, and the snapshot must still wait
  // for the lifecycle lines instead of stopping the reader.
  await writeFile(
    join(root, "bin", "tail"),
    '#!/bin/sh\nsleep 0.5\nexec /usr/bin/tail "$@"\n'
  );
  await chmod(join(root, "bin", "tail"), 0o755);

  const result = await runLogs([
    "--json",
    "--no-follow",
    "--services",
    "api,dev",
  ]);

  expect(result.exitCode).toBe(0);
  const calls = await composeLogsCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.endsWith(" api")).toBe(true);
  const messages = parseLines(result.stdout)
    .filter((line) => line.type === "log")
    .map((line) => (line.entry as Record<string, unknown>).message);
  expect(messages).toContain("dev ready");
  expect(messages).toContain("short");
  expect(messages).not.toContain("not requested");
}, 60_000);
