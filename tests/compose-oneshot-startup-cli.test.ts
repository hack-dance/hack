import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-2310: a detached start keeps waiting while a one-shot dependency
 * (the target of `service_completed_successfully`) runs, and says so when it
 * does stop. The stub `docker` models `up -d` waiting on `migrate`: while
 * `up -d` runs, `ps` shows `migrate` running and `api` Created; when it
 * ends, `migrate` exited 0 and `api` runs. The real 150 s run is the e2e
 * scenario in tests/e2e.
 */

const CLI = resolve(import.meta.dir, "..", "index.ts");

const STUB = `#!/bin/sh
state="$STUB_STATE"
if [ "$1" != "compose" ]; then exit 0; fi
case " $* " in
  *" up "*" --no-start"*) exit 0 ;;
  *" up "*" -d "*|*" up -d"*)
    : > "$state/up-started"
    sleep "\${STUB_UP_SECONDS:-1}"
    : > "$state/up-done"
    exit 0 ;;
  *" ps "*)
    case " $* " in
      *" --format "*)
        if [ -f "$state/up-done" ]; then
          printf '%s\\n' '{"ID":"c1","Service":"migrate","Name":"shop-migrate-1","State":"exited","Status":"Exited (0)","ExitCode":0}'
          printf '%s\\n' '{"ID":"c2","Service":"api","Name":"shop-api-1","State":"running","Status":"Up","ExitCode":0}'
        elif [ -f "$state/up-started" ]; then
          printf '%s\\n' '{"ID":"c1","Service":"migrate","Name":"shop-migrate-1","State":"running","Status":"Up","ExitCode":0}'
          printf '%s\\n' '{"ID":"c2","Service":"api","Name":"shop-api-1","State":"created","Status":"Created","ExitCode":0}'
        fi ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
`;

const ONE_SHOT_COMPOSE = `services:
  migrate:
    image: alpine:3.22
    restart: "no"
  api:
    image: alpine:3.22
    depends_on:
      migrate:
        condition: service_completed_successfully
`;

const PLAIN_COMPOSE = `services:
  migrate:
    image: alpine:3.22
  api:
    image: alpine:3.22
`;

let root = "";
let project = "";
let bin = "";
let state = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-oneshot-start-"));
  project = join(root, "project");
  bin = join(root, "bin");
  state = join(root, "state");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "docker"), STUB);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({ name: "shop", internal: { dns: false, tls: false } })
  );
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    ONE_SHOT_COMPOSE
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function cli(
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: project,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_NO_INTERACTIVE: "1",
        NO_COLOR: "1",
        STUB_STATE: state,
        ...extra,
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

test("up -d keeps waiting past its budget while a one-shot runs, and starts everything", async () => {
  const started = Date.now();
  const result = await cli(["up", "--detach", "--json"], {
    // A 1 s budget against a 4 s migration: a wall-clock budget would stop.
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
    exitCode: 0,
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(3500);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { services: { started: string[]; completed: string[] } };
  };
  expect(envelope.ok).toBe(true);
  expect(envelope.data.services.started).toEqual(["api"]);
  expect(envelope.data.services.completed).toEqual(["migrate"]);
}, 60_000);

test("the project setting sets the budget when no host variable does", async () => {
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      internal: { dns: false, tls: false },
      compose: { startupTimeoutMs: 1000, startupCeilingMs: 2500 },
    })
  );
  const result = await cli(["up", "--detach", "--json"], {
    STUB_UP_SECONDS: "20",
  });
  expect(result.exitCode).toBe(124);
  const envelope = JSON.parse(result.stdout) as {
    error: { message: string };
  };
  expect(envelope.error.message).toContain("start ceiling of 2500 ms");
}, 60_000);

test("a start cut short at the ceiling names the one-shot, and ps shows who waits on it", async () => {
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    HACK_COMPOSE_STARTUP_CEILING_MS: "2500",
    STUB_UP_SECONDS: "20",
  });
  expect(result.exitCode).toBe(124);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; message: string; detail: Record<string, unknown> };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe("E_STARTUP_TIMEOUT");
  expect(envelope.error.message).toContain("the one-shot service migrate");
  expect(envelope.error.message).toContain("the start is still in progress");
  expect(envelope.error.message).toContain(
    "Running hack restart or hack down now would interrupt migrate"
  );
  expect(envelope.error.detail).toMatchObject({
    composePhase: "start",
    budgetEnv: "HACK_COMPOSE_STARTUP_CEILING_MS",
    inProgress: ["migrate"],
  });

  // The stub's `up -d` was stopped before it finished: migrate still runs.
  const ps = await cli(["ps", "--json"]);
  expect(ps.exitCode).toBe(0);
  const payload = JSON.parse(ps.stdout) as {
    waiting: Record<string, string[]>;
  };
  expect(payload.waiting).toEqual({ api: ["migrate"] });
  const table = await cli(["ps"]);
  expect(table.stdout).toContain("created (waiting for migrate)");
}, 60_000);

test("without a one-shot the start budget stays a wall-clock bound", async () => {
  await writeFile(join(project, ".hack", "docker-compose.yml"), PLAIN_COMPOSE);
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect(result.exitCode).toBe(124);
  const envelope = JSON.parse(result.stdout) as {
    error: { message: string };
  };
  expect(envelope.error.message).toContain("startup budget of 1000 ms");
}, 60_000);

test("down --json while a one-shot runs proceeds and reports what it interrupted", async () => {
  // The state of a start that was cut short: migrate running, api Created.
  await writeFile(join(state, "up-started"), "");
  const result = await cli(["down", "--json"]);
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { interrupted: string[]; warnings: string[] };
  };
  expect(envelope.ok).toBe(true);
  expect(envelope.data.interrupted).toEqual(["migrate"]);
  expect(envelope.data.warnings[0]).toContain(
    "interrupted the one-shot service migrate"
  );
  expect(result.stderr).toContain("interrupted the one-shot service migrate");
}, 60_000);

test("restart --json while a one-shot runs reports what it interrupted", async () => {
  await writeFile(join(state, "up-started"), "");
  const result = await cli(["restart", "--json"], { STUB_UP_SECONDS: "1" });
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    data: { interrupted: string[]; warnings: string[] };
  };
  expect(envelope.data.interrupted).toEqual(["migrate"]);
  expect(envelope.data.warnings[0]).toContain("hack restart interrupted");
}, 60_000);
