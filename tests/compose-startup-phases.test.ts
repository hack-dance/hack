import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntimeBackend } from "../src/backends/runtime-backend.ts";
import {
  type ComposeStartupPhase,
  composeStartupFailure,
} from "../src/lib/compose-startup-budget.ts";

/**
 * Stub `docker` that models Compose image handling without a Docker engine:
 * any `up` without `--no-build` "builds" missing images (sleeping
 * STUB_BUILD_SECONDS, then marking them present); `up --no-build` refuses when
 * images are missing; `up -d` then "starts" containers, and with
 * STUB_START_HANG=1 waits forever on a grandchild like a dependency that never
 * becomes healthy. It records each argv and the hanging grandchild's pid.
 */
const STUB_DOCKER = `#!/bin/sh
[ "$1" = warmup ] && exit 0
dir="$(dirname "$0")"
echo "$*" >> "$dir/calls.log"
no_build=0; no_start=0; detach=0
for arg in "$@"; do
  case "$arg" in
    --no-build) no_build=1 ;;
    --no-start) no_start=1 ;;
    -d) detach=1 ;;
  esac
done
if [ ! -f "$dir/images-ready" ]; then
  if [ "$no_build" = 1 ]; then
    echo "image missing" >&2
    exit 17
  fi
  sleep "$STUB_BUILD_SECONDS"
  if [ "$STUB_BUILD_HANG" = 1 ]; then
    sleep 30 &
    echo $! > "$dir/hang.pid"
    wait
  fi
  : > "$dir/images-ready"
fi
if [ "$no_start" = 1 ] || [ "$detach" = 0 ]; then
  exit 0
fi
if [ "$STUB_START_HANG" = 1 ]; then
  sleep 30 &
  echo $! > "$dir/hang.pid"
  wait
fi
exit 0
`;

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function stubCompose(opts: {
  readonly buildSeconds: number;
  readonly buildHang?: boolean;
  readonly startHang?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), "hack-compose-phases-"));
  dirs.push(dir);
  await writeFile(join(dir, "docker"), STUB_DOCKER);
  await chmod(join(dir, "docker"), 0o700);
  // Execute the new script once outside any deadline: the first exec of a
  // freshly written executable can be slow (for example, macOS policy scans)
  // and must not be charged to the 1 s budgets under test.
  expect(Bun.spawnSync([join(dir, "docker"), "warmup"]).exitCode).toBe(0);
  return {
    dir,
    env: {
      // The stub shadows any engine client; no socket or HOME is reachable.
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: dir,
      DOCKER_HOST: `unix://${join(dir, "no-engine.sock")}`,
      STUB_BUILD_SECONDS: String(opts.buildSeconds),
      STUB_BUILD_HANG: opts.buildHang ? "1" : "0",
      STUB_START_HANG: opts.startHang ? "1" : "0",
    },
  };
}

async function detachedUp(opts: {
  readonly dir: string;
  readonly env: Record<string, string>;
  readonly startupTimeoutMs: number;
  readonly imageTimeoutMs: number;
}) {
  const phases: ComposeStartupPhase[] = [];
  const started = Date.now();
  const code = await composeRuntimeBackend.up({
    composeFiles: ["compose.yml"],
    composeProject: "phases",
    cwd: opts.dir,
    env: opts.env,
    detach: true,
    startupTimeoutMs: opts.startupTimeoutMs,
    imageTimeoutMs: opts.imageTimeoutMs,
    routeStdoutToStderr: true,
    onStartupPhase: (phase) => {
      phases.push(phase);
    },
  });
  const calls = (await readFile(join(opts.dir, "calls.log"), "utf8"))
    .trim()
    .split("\n");
  return { code, phases, calls, elapsedMs: Date.now() - started };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 4000;
  while (processExists(pid) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  expect(processExists(pid)).toBe(false);
}

test("a first-time build longer than the startup budget still starts", async () => {
  // Build takes 1.6 s; the start/dependency-wait budget is only 1 s.
  const stub = await stubCompose({ buildSeconds: 1.6 });
  const result = await detachedUp({
    ...stub,
    startupTimeoutMs: 1000,
    imageTimeoutMs: 10_000,
  });

  expect(result.code).toBe(0);
  expect(result.phases).toEqual(["images", "start"]);
  expect(result.calls).toEqual([
    "compose -p phases -f compose.yml up --no-start",
    "compose -p phases -f compose.yml up -d --no-build",
  ]);
}, 15_000);

test("a genuine readiness hang still times out in the named start phase", async () => {
  const stub = await stubCompose({ buildSeconds: 0, startHang: true });
  const result = await detachedUp({
    ...stub,
    startupTimeoutMs: 1000,
    imageTimeoutMs: 10_000,
  });

  expect(result.code).toBe(124);
  expect(result.phases).toEqual(["images", "start"]);
  // Bounded by the 1 s start budget, not the 10 s image budget.
  expect(result.elapsedMs).toBeLessThan(5000);
  // The owned process group, including the hanging grandchild, is terminated.
  const hangPid = Number(await readFile(join(stub.dir, "hang.pid"), "utf8"));
  await expectProcessGone(hangPid);

  const failure = composeStartupFailure({
    code: result.code,
    action: "docker compose up",
    phase: result.phases.at(-1) ?? "start",
    budgets: { startupTimeoutMs: 1000, imageTimeoutMs: 10_000 },
  });
  expect(failure.code).toBe("E_STARTUP_TIMEOUT");
  expect(failure.message).toContain(
    "startup budget of 1000 ms (phase: start and dependency wait)"
  );
  expect(failure.message).toContain(
    "Raise it with HACK_COMPOSE_STARTUP_TIMEOUT_MS=<ms>"
  );
}, 15_000);

test("a hung image build times out in the named image phase without starting", async () => {
  const stub = await stubCompose({ buildSeconds: 0, buildHang: true });
  const result = await detachedUp({
    ...stub,
    startupTimeoutMs: 60_000,
    imageTimeoutMs: 1000,
  });

  expect(result.code).toBe(124);
  expect(result.phases).toEqual(["images"]);
  expect(result.calls).toEqual([
    "compose -p phases -f compose.yml up --no-start",
  ]);
  expect(result.elapsedMs).toBeLessThan(5000);
  const hangPid = Number(await readFile(join(stub.dir, "hang.pid"), "utf8"));
  await expectProcessGone(hangPid);

  const failure = composeStartupFailure({
    code: result.code,
    action: "docker compose up",
    phase: result.phases.at(-1) ?? "start",
    budgets: { startupTimeoutMs: 60_000, imageTimeoutMs: 1000 },
  });
  expect(failure.code).toBe("E_STARTUP_TIMEOUT");
  expect(failure.message).toContain(
    "image build/pull budget of 1000 ms (phase: image build/pull and container creation)"
  );
  expect(failure.message).toContain(
    "Raise it with HACK_COMPOSE_IMAGE_TIMEOUT_MS=<ms>"
  );
}, 15_000);

test("non-timeout failures keep E_COMPOSE_FAILED and name the phase", () => {
  const failure = composeStartupFailure({
    code: 17,
    action: "docker compose up",
    phase: "images",
    budgets: { startupTimeoutMs: 90_000, imageTimeoutMs: 1_800_000 },
  });
  expect(failure).toMatchObject({
    code: "E_COMPOSE_FAILED",
    message:
      "docker compose up failed (exit 17) during Compose image build/pull and container creation",
  });
});
