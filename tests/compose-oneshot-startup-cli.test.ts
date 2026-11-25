import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import { runPrivateTtyCli } from "./helpers/private-cli-tty.ts";

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
# After down, ps lists nothing (HACK-2340: down checks what is left).
case " $* " in
  *" down "*)
    : > "$state/down-ran"
    exit 0 ;;
  *" up --no-start "*|*" up "*" --no-start "*)
    printf '%s\\n' 'compose-no-start-marker'
    if [ -n "\${STUB_WARN:-}" ]; then
      printf '%s\\n' 'WARN[0000] The "STUB_UNSET" variable is not set. Defaulting to a blank string.' >&2
    fi
    if [ -n "\${STUB_ASK:-}" ]; then
      # Compose without a terminal on stdin: the question, no line break,
      # then one read; end-of-input means its default answer.
      printf '%s' "Volume \\"shop_db\\" exists but doesn't match configuration in compose file. Recreate (data will be lost)?"
      if read -r answer; then : > "$state/answered"; else : > "$state/end-of-input"; fi
      if [ -n "\${STUB_ASK_FAIL:-}" ]; then exit 1; fi
    fi
    exit 0 ;;
  *" up "*" -d "*|*" up -d"*)
    rm -f "$state/down-ran"
    : > "$state/up-started"
    printf '%s\\n' 'compose-up-stdout-marker'
    if [ -n "\${STUB_WARN:-}" ]; then
      printf '%s\\n' 'time="2026-01-01T00:00:00Z" level=warning msg="The \\"STUB_UNSET\\" variable is not set. Defaulting to a blank string."' >&2
    fi
    if [ -n "\${STUB_UP_FAIL:-}" ]; then
      i=1
      while [ "$i" -le 25 ]; do
        printf 'client line %s\\n' "$i" >&2
        i=$((i + 1))
      done
      printf '\\033[31mpull access denied for https://someone:hunter2@registry.invalid/app, token fixture-secret-value\\033[0m\\n' >&2
      if [ -n "\${APP_PORT:-}" ]; then
        printf 'Bind for 0.0.0.0:%s failed: port is already allocated (user %s, password %s)\\n' "$APP_PORT" "$APP_DB_USER" "$APP_DB_PASSWORD" >&2
      fi
      exit 1
    fi
    sleep "\${STUB_UP_SECONDS:-1}"
    : > "$state/up-done"
    exit 0 ;;
  *" ps "*)
    if [ -f "$state/down-ran" ]; then exit 0; fi
    if [ -f "$state/fail-refresh" ]; then
      ordinal=0
      if [ -f "$state/refresh-reads" ]; then
        read -r ordinal < "$state/refresh-reads"
      fi
      ordinal=$((ordinal + 1))
      printf '%s\n' "$ordinal" > "$state/refresh-reads"
      if [ "$ordinal" = 2 ]; then
        : > "$state/refresh-failed"
        exit 1
      fi
    fi
    if [ -n "\${STUB_PS_HANG:-}" ] && [ -f "$state/up-started" ] && [ ! -f "$state/up-done" ]; then
      printf '%s\\n' "$$" > "$state/ps.pid"
      exec sleep 60
    fi
    if [ -n "\${STUB_PS_FAIL_AFTER_FIRST:-}" ] && [ -f "$state/up-started" ]; then
      if [ -f "$state/ps-seen" ]; then exit 1; fi
      : > "$state/ps-seen"
    fi
    if [ -n "\${STUB_PS_EXTRA:-}" ]; then
      printf '%s\\n' "$STUB_PS_EXTRA"
    fi
    if [ -n "\${STUB_PS_SLEEP:-}" ] && [ ! -f "$state/up-done" ]; then
      sleep "$STUB_PS_SLEEP"
    fi
    case " $* " in
      *" --format "*)
        if [ -f "$state/up-done" ]; then
          printf '%s\\n' '{"ID":"c1","Service":"migrate","Name":"shop-migrate-1","State":"exited","Status":"Exited (0)","ExitCode":0,"Labels":"com.docker.compose.project.working_dir='"$STUB_PROJECT_DIR"'"}'
          printf '%s\\n' '{"ID":"c2","Service":"api","Name":"shop-api-1","State":"running","Status":"Up","ExitCode":0,"Labels":"com.docker.compose.project.working_dir='"$STUB_PROJECT_DIR"'"}'
        elif [ -f "$state/up-started" ]; then
          printf '%s\\n' '{"ID":"c1","Service":"migrate","Name":"shop-migrate-1","State":"running","Status":"Up","ExitCode":0,"Labels":"com.docker.compose.project.working_dir='"$STUB_PROJECT_DIR"'"}'
          printf '%s\\n' '{"ID":"c2","Service":"api","Name":"shop-api-1","State":"created","Status":"Created","ExitCode":0,"Labels":"com.docker.compose.project.working_dir='"$STUB_PROJECT_DIR"'"}'
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

function fixtureEnv(extra: Readonly<Record<string, string>> = {}) {
  return privateCliEnv({
    root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HACK_RUNTIME_BACKEND: "compose",
      HACK_NO_INTERACTIVE: "1",
      NO_COLOR: "1",
      STUB_STATE: state,
      STUB_PROJECT_DIR: join(project, ".hack"),
      ...extra,
    },
  });
}

async function cli(
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: project,
    env: fixtureEnv(extra),
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
  // The watched start keeps the --json stdout reservation (HACK-2311).
  expect(result.stdout).not.toContain("compose-up-stdout-marker");
  expect(result.stderr).toContain("compose-up-stdout-marker");
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

test("Down reports a one-shot that starts during its before-hook", async () => {
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      internal: { dns: false, tls: false },
      lifecycle: {
        down: { before: [{ command: ': > "$STUB_STATE/up-started"' }] },
      },
    })
  );
  const result = await cli(["down", "--json"]);
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { interrupted: ["migrate"] },
  });
  expect(result.stderr).toContain("interrupted the one-shot service migrate");
}, 60_000);

test("Down keeps the known one-shot interruption when its refresh fails", async () => {
  await writeFile(join(state, "up-started"), "");
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      internal: { dns: false, tls: false },
      lifecycle: {
        down: { before: [{ command: ': > "$STUB_STATE/fail-refresh"' }] },
      },
    })
  );
  const result = await cli(["down", "--json"]);
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(await Bun.file(join(state, "refresh-failed")).exists()).toBe(true);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { interrupted: ["migrate"] },
  });
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

test("a slow poll never turns a start that already succeeded into a timeout", async () => {
  // The first poll begins at 1 s and takes 3 s; Compose succeeds at 2 s,
  // past the 1 s budget but before the poll returns.
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "2",
    STUB_PS_SLEEP: "3",
  });
  expect({ exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
    exitCode: 0,
  });
  expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
}, 60_000);

test("a targeted restart of a running one-shot reports the interruption; of another service it does not", async () => {
  await writeFile(join(state, "up-started"), "");
  const oneShot = await cli(["restart", "migrate", "--json"], {
    STUB_UP_SECONDS: "1",
  });
  expect(oneShot.exitCode).toBe(0);
  const interrupted = JSON.parse(oneShot.stdout) as {
    data: { interrupted?: string[]; warnings?: string[] };
  };
  expect(interrupted.data.interrupted).toEqual(["migrate"]);
  expect(interrupted.data.warnings?.[0]).toContain("hack restart interrupted");

  await rm(join(state, "up-done"), { force: true });
  await writeFile(join(state, "up-started"), "");
  const other = await cli(["restart", "api", "--json"], {
    STUB_UP_SECONDS: "1",
  });
  expect(other.exitCode).toBe(0);
  const untouched = JSON.parse(other.stdout) as {
    data: { interrupted?: string[] };
  };
  expect(untouched.data.interrupted).toBeUndefined();
}, 60_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hungPollPid(): Promise<number> {
  const text = await readFile(join(state, "ps.pid"), "utf8");
  const pid = Number(text.trim());
  expect(pid).toBeGreaterThan(0);
  return pid;
}

test("a hung poll neither delays a finished start nor outlives it", async () => {
  const started = Date.now();
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "2",
    STUB_PS_HANG: "1",
  });
  expect(result.exitCode).toBe(0);
  // Without cancellation the CLI waits out the 15 s inspection bound.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(alive(await hungPollPid())).toBe(false);
}, 60_000);

test("Ctrl-C during a watched start ends promptly and stops the hung poll", async () => {
  const child = Bun.spawn([process.execPath, CLI, "up", "--detach", "--json"], {
    cwd: project,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_NO_INTERACTIVE: "1",
        NO_COLOR: "1",
        STUB_STATE: state,
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "60000",
        STUB_UP_SECONDS: "30",
        STUB_PS_HANG: "1",
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait until the watchdog's poll is hanging.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const exists = await readFile(join(state, "ps.pid"), "utf8").catch(
      () => ""
    );
    if (exists.trim() !== "") {
      break;
    }
    await Bun.sleep(100);
  }
  const interruptedAt = Date.now();
  child.kill("SIGINT");
  const code = await child.exited;
  expect(Date.now() - interruptedAt).toBeLessThan(10_000);
  expect(code).not.toBe(0);
  expect(code).not.toBe(124);
  expect(alive(await hungPollPid())).toBe(false);
}, 60_000);

test("one-shot reads that stop answering end at the idle budget, not as a ceiling stop", async () => {
  // The first poll sees migrate running; every later read fails.
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "20",
    STUB_PS_FAIL_AFTER_FIRST: "1",
  });
  expect(result.exitCode).toBe(124);
  const envelope = JSON.parse(result.stdout) as {
    error: { message: string; detail: Record<string, unknown> };
  };
  expect(envelope.error.message).toContain("startup budget of 1000 ms");
  expect(envelope.error.message).not.toContain("start ceiling");
  expect(envelope.error.detail).not.toHaveProperty("inProgress");
}, 60_000);

test("ps renders a Created service named like an Object member", async () => {
  await writeFile(join(project, ".hack", "docker-compose.yml"), PLAIN_COMPOSE);
  const result = await cli(["ps"], {
    STUB_PS_EXTRA:
      '{"ID":"c9","Service":"constructor","Name":"shop-constructor-1","State":"created","Status":"Created","ExitCode":0}',
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
    exitCode: 0,
  });
  expect(result.stdout).toContain("constructor");
  expect(result.stdout).not.toContain("waiting for");
}, 60_000);

test("a service-scoped up ignores a running one-shot outside its scope", async () => {
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    `${ONE_SHOT_COMPOSE}  web:\n    image: alpine:3.22\n`
  );
  // migrate keeps running, but web does not wait on it: the plain budget.
  const result = await cli(["up", "--detach", "--json", "web"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect(result.exitCode).toBe(124);
  const envelope = JSON.parse(result.stdout) as {
    error: { message: string };
  };
  expect(envelope.error.message).toContain("startup budget of 1000 ms");
}, 60_000);

test("a profile variable set only in Compose's .env keeps the one-shot wait", async () => {
  // api's profile comes from APP_PROFILE, which only Compose's own .env sets
  // (Hack does not read it); under --profile prod Compose starts api and
  // waits for migrate, so Hack must keep waiting too.
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    ONE_SHOT_COMPOSE.replace(
      "  api:\n    image: alpine:3.22\n",
      '  api:\n    image: alpine:3.22\n    profiles: ["${APP_PROFILE:-dev}"]\n'
    )
  );
  await writeFile(join(project, ".hack", ".env"), "APP_PROFILE=prod\n");
  const result = await cli(["up", "--detach", "--json", "--profile", "prod"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect({ exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
    exitCode: 0,
  });
}, 60_000);

test("COMPOSE_PROFILES set only in Compose's .env enables the waiting service", async () => {
  // api is in profile ops, which only Compose's .env enables: Compose starts
  // api and waits for migrate, so Hack must keep waiting too.
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    ONE_SHOT_COMPOSE.replace(
      "  api:\n    image: alpine:3.22\n",
      "  api:\n    image: alpine:3.22\n    profiles: [ops]\n"
    )
  );
  await writeFile(join(project, ".hack", ".env"), "COMPOSE_PROFILES=ops\n");
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect({ exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
    exitCode: 0,
  });
}, 60_000);

test("an interpolated COMPOSE_PROFILES in Compose's .env is resolved", async () => {
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    ONE_SHOT_COMPOSE.replace(
      "  api:\n    image: alpine:3.22\n",
      "  api:\n    image: alpine:3.22\n    profiles: [ops]\n"
    )
  );
  await writeFile(
    join(project, ".hack", ".env"),
    "ENABLED_PROFILE=ops\nCOMPOSE_PROFILES=${ENABLED_PROFILE}\n"
  );
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect({ exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
    exitCode: 0,
  });
}, 60_000);

test("an inline comment after COMPOSE_PROFILES in Compose's .env is ignored", async () => {
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    ONE_SHOT_COMPOSE.replace(
      "  api:\n    image: alpine:3.22\n",
      "  api:\n    image: alpine:3.22\n    profiles: [ops]\n"
    )
  );
  await writeFile(
    join(project, ".hack", ".env"),
    "COMPOSE_PROFILES=ops # enable the ops services\n"
  );
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect({ exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
    exitCode: 0,
  });
}, 60_000);

test("a start whose extends chains cannot be resolved is bounded only by the ceiling", async () => {
  const lines = [
    "services:",
    "  migrate:",
    "    image: alpine:3.22",
    "  level0:",
    "    image: alpine:3.22",
    "    depends_on:",
    "      migrate:",
    "        condition: service_completed_successfully",
  ];
  for (let level = 1; level <= 40; level += 1) {
    lines.push(`  level${level}:`, `    extends: level${level - 1}`);
  }
  lines.push("  api:", "    extends: level40", "");
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    lines.join("\n")
  );
  // No one-shot is ever observed, but the graph is incomplete: a 1 s budget
  // must not cut the 4 s start short.
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  expect({ exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
    exitCode: 0,
  });
  expect(result.stderr).toContain("could not be resolved");
}, 60_000);

test("a migration dependency declared in an included file keeps the wait", async () => {
  await writeFile(
    join(project, ".hack", "app.yml"),
    [
      "services:",
      "  api:",
      "    image: alpine:3.22",
      "    depends_on:",
      "      migrate:",
      "        condition: service_completed_successfully",
      "",
    ].join("\n")
  );
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    "include:\n  - app.yml\nservices:\n  migrate:\n    image: alpine:3.22\n"
  );
  const result = await cli(["up", "--detach", "--json"], {
    HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000",
    STUB_UP_SECONDS: "4",
  });
  // The start is not cut short: Compose ran to completion past the 1 s
  // budget. (Post-start readiness reads only the base file, so it may still
  // classify the included edge differently; that is not the start budget.)
  expect(result.exitCode).not.toBe(124);
  const envelope = JSON.parse(result.stdout) as {
    error?: { code?: string };
  };
  expect(envelope.error?.code).not.toBe("E_STARTUP_TIMEOUT");
  expect(result.stderr).toContain("compose-up-stdout-marker");
}, 60_000);

test("Compose closes a confirmed start and stop with plain lifecycle lines", async () => {
  const file = join(project, ".hack", "docker-compose.yml");
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      dev_host: "SAMPLE.hack.local",
      lifecycle: {
        up: {
          before: [{ name: "prepare", command: "printf 'before output\\n'" }],
          after: [{ name: "verify", command: "printf 'after output\\n'" }],
        },
      },
      internal: { dns: false, tls: false },
    })
  );
  await writeFile(
    file,
    `${ONE_SHOT_COMPOSE}    labels:
      caddy: http://alias.hack.local, https://sample.hack.local
  dormant:
    image: alpine:3.22
    profiles: ["extra"]
    labels:
      caddy: https://dormant.hack.local
`
  );
  const up = await cli(["up", "--detach"], { STUB_UP_SECONDS: "0" });
  expect(up.exitCode).toBe(0);
  expect(up.stdout).toMatch(
    /https:\/\/sample\.hack\.local {2}up in \d+\.\ds · compose · 2 routes warming\n$/
  );
  expect(up.stdout).not.toContain("dormant.hack.local");
  expect(up.stdout).not.toContain("printf");
  const output = up.stdout.split("\n");
  const before = output.findIndex((line) =>
    /^✓ before +prepare +done · \d+\.\ds$/.test(line)
  );
  const after = output.findIndex((line) =>
    /^✓ after +verify +done · \d+\.\ds$/.test(line)
  );
  const migration = output.findIndex((line) =>
    /^✓ services +migrate +completed$/.test(line)
  );
  const service = output.findIndex((line) =>
    /^✓ services +api +up$/.test(line)
  );
  const images = output.findIndex((line) =>
    /^✓ images +ready · \d+\.\ds$/.test(line)
  );
  // HACK-2542: the Compose client's own lines are not passed through.
  for (const marker of [
    "compose-no-start-marker",
    "compose-up-stdout-marker",
  ]) {
    expect(up.stdout).not.toContain(marker);
    expect(up.stderr).not.toContain(marker);
  }
  expect(output.indexOf("before output")).toBeGreaterThanOrEqual(0);
  expect(before).toBeGreaterThan(output.indexOf("before output"));
  expect(images).toBeGreaterThan(before);
  expect(migration).toBeGreaterThan(images);
  expect(service).toBeGreaterThan(migration);
  expect(output.indexOf("after output")).toBeGreaterThan(service);
  expect(after).toBeGreaterThan(output.indexOf("after output"));
  expect(up.stdout).not.toContain(" ...");

  const down = await cli(["down"]);
  expect(down.exitCode).toBe(0);
  expect(down.stdout).toMatch(/✓ services {2}stopped · \d+\.\ds\n$/);

  await writeFile(file, ONE_SHOT_COMPOSE);
  const unrouted = await cli(["up", "--detach"], { STUB_UP_SECONDS: "0" });
  expect(unrouted.exitCode).toBe(0);
  expect(unrouted.stdout).toMatch(/no address {2}up in \d+\.\ds · compose\n$/);
}, 60_000);

test("a detached Compose branch prefers its branch-qualified primary route", async () => {
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      dev_host: "sample.hack.local",
      internal: { dns: false, tls: false },
    })
  );
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    `${ONE_SHOT_COMPOSE}    labels:
      caddy: api.sample.hack.local, sample.hack.local
`
  );
  const up = await cli(["up", "--detach", "--branch", "feature"], {
    STUB_UP_SECONDS: "0",
  });
  expect(up.exitCode).toBe(0);
  expect(up.stdout).toMatch(
    /^https:\/\/feature\.sample\.hack\.local {2}up in \d+\.\ds · compose · 2 routes warming$/m
  );
}, 60_000);

test("detached Compose up clears its transient hook and service waits on a TTY", async () => {
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      internal: { dns: false, tls: false },
      lifecycle: {
        up: {
          before: [
            { name: "prepare", command: "sleep 0.1; echo before-output" },
          ],
          after: [{ name: "verify", command: "sleep 0.1" }],
        },
      },
    })
  );
  const result = await runPrivateTtyCli({
    cwd: project,
    args: ["up", "--detach"],
    env: fixtureEnv({ TERM: "xterm", STUB_UP_SECONDS: "0" }),
  });
  expect(result.exitCode).toBe(0);
  const erase = "\r\x1b[2K";
  expect(result.stdout).toContain(
    `${erase}before prepare ...${erase}before-output`
  );
  expect(result.stdout).toContain(`${erase}services ...${erase}✓ services`);
  expect(result.stdout).toContain(`${erase}after verify ...${erase}✓ after`);
  // Through the terminal-group runner too, the client's lines stay captured
  // and each detached phase shows only a transient wait.
  expect(result.stdout).toContain(`${erase}images ...${erase}✓ images`);
  expect(result.stdout).not.toContain("compose-no-start-marker");
  expect(result.stdout).not.toContain("compose-up-stdout-marker");
  expect(result.stdout.indexOf("before prepare ...")).toBeLessThan(
    result.stdout.indexOf("services ...")
  );
  expect(result.stdout.indexOf("✓ services")).toBeLessThan(
    result.stdout.indexOf("after verify ...")
  );
}, 20_000);

test("a failed detached Compose start quotes the client's last lines, redacted, before the reason", async () => {
  const result = await cli(["up", "--detach"], {
    STUB_UP_SECONDS: "0",
    STUB_UP_FAIL: "1",
    STUB_API_TOKEN: "fixture-secret-value",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).not.toContain("client line");
  const lines = result.stderr.split("\n");
  const heading = lines.indexOf("docker compose output (last 20 lines):");
  expect(heading, result.stderr).toBeGreaterThanOrEqual(0);
  const quoted = lines.slice(heading + 1, heading + 21);
  expect(quoted[0]).toBe("  client line 7");
  expect(quoted[18]).toBe("  client line 25");
  expect(quoted[19]).toBe(
    "  pull access denied for https://[REDACTED]@registry.invalid/app, token [REDACTED]"
  );
  expect(lines).not.toContain("  client line 6");
  // One hint names where the whole output is.
  expect(lines[heading + 21]).toBe(
    "For Compose's full output, run `hack up` in the foreground or `hack up --detach --json`."
  );
  expect(result.stderr).not.toContain("hunter2");
  expect(result.stderr).not.toContain("fixture-secret-value");
  expect(result.stderr).not.toContain("\x1b[31m");
  // Hack's own reason is still reported after the quoted lines.
  expect(result.stdout + lines.slice(heading + 22).join("\n")).toContain(
    "docker compose up"
  );
}, 60_000);

test("a successful detached Compose start repeats each client warning once", async () => {
  const result = await cli(["up", "--detach"], {
    STUB_UP_SECONDS: "0",
    STUB_WARN: "1",
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const warnings = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("! compose"));
  expect(warnings).toEqual([
    '! compose  The "STUB_UNSET" variable is not set. Defaulting to a blank string.',
  ]);
  expect(result.stderr).not.toContain("WARN[0000]");
  expect(result.stderr).not.toContain("level=warning");
}, 60_000);

test("a failed start's quoted lines keep non-secret env-layer values and redact secret ones", async () => {
  const hackDir = join(project, ".hack");
  await writeFile(join(project, PROJECT_ENV_KEY_FILENAME), "synthetic-key");
  for (const [key, value, secret] of [
    ["APP_PORT", "43210", false],
    ["APP_DB_USER", "shopuser", false],
    ["APP_DB_PASSWORD", "layer-secret-value", true],
  ] as const) {
    await setProjectEnvValue({
      projectRoot: project,
      projectDir: hackDir,
      envName: null,
      scope: "global",
      key,
      value,
      secret,
    });
  }
  const result = await cli(["up", "--detach"], {
    STUB_UP_SECONDS: "0",
    STUB_UP_FAIL: "1",
  });
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.stderr).toContain(
    "  Bind for 0.0.0.0:43210 failed: port is already allocated (user shopuser, password [REDACTED])"
  );
  expect(result.stderr).not.toContain("layer-secret-value");
}, 60_000);

test("a startup notice during a detached phase does not land on the transient wait", async () => {
  const lines = [
    "services:",
    "  migrate:",
    "    image: alpine:3.22",
    "  level0:",
    "    image: alpine:3.22",
    "    depends_on:",
    "      migrate:",
    "        condition: service_completed_successfully",
  ];
  for (let level = 1; level <= 40; level += 1) {
    lines.push(`  level${level}:`, `    extends: level${level - 1}`);
  }
  lines.push("  api:", "    extends: level40", "");
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    lines.join("\n")
  );
  const result = await runPrivateTtyCli({
    cwd: project,
    args: ["up", "--detach"],
    env: fixtureEnv({ TERM: "xterm", STUB_UP_SECONDS: "0" }),
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const output = result.stdout.replace(/\x1b\[[\d;]*m/g, "");
  const erase = "\r\x1b[2K";
  expect(output).toContain(`services ...${erase}Some Compose extends chains`);
  expect(output).not.toContain("services ...Some Compose");
  // The wait comes back after the notice.
  const notice = output.indexOf("Some Compose extends chains");
  expect(output.indexOf(`${erase}services ...`, notice)).toBeGreaterThan(
    notice
  );
}, 20_000);

const VOLUME_QUESTION =
  'Volume "shop_db" exists but doesn\'t match configuration in compose file. Recreate (data will be lost)?';
const PROMPT_HINT =
  "Compose asked a question, and a detached `hack up` cannot answer it. Run `hack up` in the foreground to answer it.";

test("a question Compose answered with its default during a successful detached start is reported", async () => {
  const result = await cli(["up", "--detach"], {
    STUB_UP_SECONDS: "0",
    STUB_ASK: "1",
  });
  expect(result.exitCode, result.stderr).toBe(0);
  // The closed stdin gave the client end-of-input, not an answer.
  expect(await Bun.file(join(state, "end-of-input")).exists()).toBe(true);
  expect(await Bun.file(join(state, "answered")).exists()).toBe(false);
  const lines = result.stderr.split("\n");
  // The question is its own line, not joined to the next phase's output.
  expect(lines, result.stderr).toContain(
    `! compose  unanswered question: ${VOLUME_QUESTION}`
  );
  expect(lines).toContain(
    "A detached `hack up` cannot answer Compose's questions, so Compose went on with its default answer. To answer, run `hack up` in the foreground."
  );
  expect(result.stderr).not.toContain("compose-up-stdout-marker");
}, 60_000);

test("a failed detached start quotes the question Compose asked with the prompt hint", async () => {
  const result = await cli(["up", "--detach"], {
    STUB_UP_SECONDS: "0",
    STUB_ASK: "1",
    STUB_ASK_FAIL: "1",
  });
  expect(result.exitCode).toBe(1);
  const lines = result.stderr.split("\n");
  const heading = lines.findIndex((line) =>
    line.startsWith("docker compose output (last ")
  );
  expect(heading, result.stderr).toBeGreaterThanOrEqual(0);
  expect(lines.slice(heading + 1, heading + 4)).toEqual([
    "  compose-no-start-marker",
    `  ${VOLUME_QUESTION}`,
    PROMPT_HINT,
  ]);
}, 60_000);

test("a failed start names a question Compose asked before its quoted lines", async () => {
  const result = await cli(["up", "--detach"], {
    STUB_UP_SECONDS: "0",
    STUB_ASK: "1",
    STUB_UP_FAIL: "1",
  });
  expect(result.exitCode).toBe(1);
  const lines = result.stderr.split("\n");
  const heading = lines.indexOf("docker compose output (last 20 lines):");
  expect(heading, result.stderr).toBeGreaterThanOrEqual(0);
  // The images phase asked; the start phase's 26 lines pushed it out.
  expect(lines.slice(heading + 21, heading + 23)).toEqual([
    `Compose asked earlier: ${VOLUME_QUESTION}`,
    PROMPT_HINT,
  ]);
}, 60_000);
