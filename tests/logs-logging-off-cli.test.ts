import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * HACK-2468: the global logging stack is opt-in. In a home where it is off,
 * plain `hack logs` reads container logs without looking for Loki, and an
 * explicit Loki request says how to turn the stack on instead of reporting
 * an unreachable Loki. A stub `docker` stands in for the engine; no Loki runs.
 */
const CLI = resolve(import.meta.dir, "..", "index.ts");
const COMPOSE_LINE = "web-1  | listening (from compose)";

const STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "${0%/*}/../capture/docker-args.log"',
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

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-logging-off-")));
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
      name: "offhome",
      dev_host: "offhome.hack",
      internal: { dns: false, tls: false },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    "services:\n  web:\n    image: alpine:3.22\n"
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runLogs(args: readonly string[]) {
  return await runHack(["logs", ...args]);
}

/**
 * A loopback port this test owns and nothing listens on: the local Loki
 * address for every run (HACK_TEST_LOCAL_LOKI_URL), so no test reaches a
 * Loki the machine itself runs on 3100.
 */
let closedLokiUrl = "";
beforeAll(async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  closedLokiUrl = `http://127.0.0.1:${port}`;
});

async function runHack(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: projectRoot,
    // No HACK_LOKI_URL: the local stack's setting decides; its Loki address
    // is a closed port this test owns.
    env: privateCliEnv({
      root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HACK_NO_INTERACTIVE: "1",
        HACK_TEST_LOCAL_LOKI_URL: closedLokiUrl,
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

test("with the stack off, plain hack logs reads container logs and never mentions Loki", async () => {
  const result = await runLogs(["--no-follow", "web"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("listening (from compose)");
  expect(`${result.stdout}${result.stderr}`).not.toMatch(/loki/i);
  expect(await composeLogsCalls()).toHaveLength(1);
}, 60_000);

test("with the stack off, --since alone reads container logs with that range", async () => {
  const result = await runLogs(["--no-follow", "--since", "10m", "web"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("listening (from compose)");
  const calls = await composeLogsCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--since 10m");
}, 60_000);

test("with the stack off, --since 2d and --until 1d are converted to hours Docker accepts", async () => {
  const result = await runLogs(["--no-follow", "--since", "2d", "web"]);
  expect(result.exitCode).toBe(0);
  const ranged = await runLogs([
    "--no-follow",
    "--since",
    "1w",
    "--until",
    "1d",
    "web",
  ]);
  expect(ranged.exitCode).toBe(0);
  const calls = await composeLogsCalls();
  expect(calls).toHaveLength(2);
  // Docker rejects "2d" (Go durations have no day unit).
  expect(calls[0]).toContain("--since 48h");
  expect(calls[1]).toContain("--since 168h");
  expect(calls[1]).toContain("--until 24h");
}, 60_000);

test("with the stack off, --loki and --query fail with E_LOGGING_OFF and read nothing", async () => {
  for (const args of [
    ["--loki", "--no-follow"],
    ["--query", '{project="offhome"}', "--no-follow"],
  ]) {
    const result = await runLogs(args);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("E_LOGGING_OFF");
    expect(`${result.stdout}${result.stderr}`).toContain(
      "cannot run: the global logging stack (Loki, Alloy, Grafana) is off. Turn it on with: hack global up --logging"
    );
  }
  const json = await runLogs(["--loki", "--no-follow", "--json"]);
  expect(json.exitCode).toBe(1);
  const envelope = JSON.parse(json.stdout);
  expect(envelope).toMatchObject({
    ok: false,
    error: { code: "E_LOGGING_OFF" },
  });
  expect(await composeLogsCalls()).toEqual([]);
}, 60_000);

test("with the stack off, hack open logs fails with E_LOGGING_OFF and opens nothing", async () => {
  const text = await runHack(["open", "logs"]);
  expect(text.exitCode).toBe(1);
  expect(`${text.stdout}${text.stderr}`).toContain(
    "Grafana (hack open logs) cannot run: the global logging stack (Loki, Alloy, Grafana) is off. Turn it on with: hack global up --logging"
  );
  const json = await runHack(["open", "logs", "--json"]);
  expect(json.exitCode).toBe(1);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_LOGGING_OFF" },
  });
  // No browser opener was started, and Docker was not asked for Grafana.
  expect(await composeLogsCalls()).toEqual([]);
}, 60_000);

test("a home that turned the stack on gets the reachability answer instead", async () => {
  const home = join(privateCliHome(root), ".hack");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "hack.config.json"),
    `${JSON.stringify({ logging: { enabled: true } })}\n`
  );
  const result = await runLogs(["--loki", "--no-follow"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Loki is not reachable at ${closedLokiUrl}.`);
  expect(`${result.stdout}${result.stderr}`).not.toContain("E_LOGGING_OFF");
}, 60_000);

type DoctorCheck = {
  readonly id: string;
  readonly status: string;
  readonly detail: string;
};

async function doctorChecks(): Promise<readonly DoctorCheck[]> {
  const result = await runHack(["doctor", "--json"]);
  const report = JSON.parse(result.stdout) as {
    readonly data?: { readonly checks?: readonly DoctorCheck[] };
  };
  return report.data?.checks ?? [];
}

test("doctor reports the stack as off, and a bad logging.enabled value as a finding, not a crash", async () => {
  const grafana = (checks: readonly DoctorCheck[]) =>
    checks.find((check) => check.id === "grafana");
  const off = await doctorChecks();
  expect(grafana(off)).toMatchObject({ status: "ok" });
  expect(grafana(off)?.detail).toContain(
    "Logging stack off (opt-in); turn it on with: hack global up --logging"
  );

  const home = join(privateCliHome(root), ".hack");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "hack.config.json"),
    `${JSON.stringify({ logging: { enabled: "yes" } })}\n`
  );
  const bad = await doctorChecks();
  expect(bad.length).toBeGreaterThan(1);
  expect(grafana(bad)).toMatchObject({ status: "warn" });
  expect(grafana(bad)?.detail).toContain(
    "logging.enabled must be true or false"
  );
}, 120_000);
