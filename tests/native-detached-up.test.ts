import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { renderNativeHotReloadNotice } from "../src/backends/native-hot-reload-notice.ts";
import { NATIVE_IDLE_POOL_RESTART_NOTICE } from "../src/backends/native-project-source-preflight.ts";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../src/backends/native-runtime-client.ts";
import {
  NATIVE_HOOK_OUTPUT_TERMINAL_ONLY,
  nativeDetachedOwnerArgs,
  nativePrestartHookLines,
} from "../src/lib/native-detached-up.ts";
import { NATIVE_ROOT_DOTENV_IGNORED_NOTICE } from "../src/lib/native-environment-notices.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const fixture = join(import.meta.dir, "fixtures", "native-detached-owner.ts");

const fixtureProcesses = new Map<number, string>();
const fixtureRoots = new Set<string>();
async function fixtureRoot(prefix: string): Promise<string> {
  // The owner binds a Unix socket under this path. A caller-provided TMPDIR
  // can exceed the macOS socket path limit before the owner reports a phase.
  const root = await mkdtemp(join(await realpath("/tmp"), prefix));
  fixtureRoots.add(root);
  return root;
}

async function recordFixturePids(root: string): Promise<void> {
  for (const role of ["launcher", "owner", "channel-holder"]) {
    const marker = Bun.file(join(root, `${role}.fixture-pid`));
    if (await marker.exists()) {
      const pid = Number(await marker.text());
      fixtureProcesses.set(pid, root);
    }
  }
}

async function removeFixture(root: string): Promise<void> {
  await recordFixturePids(root);
  await rm(root, { recursive: true, force: true });
  fixtureRoots.delete(root);
}
const PS_SNAPSHOT_TIMEOUT_MS = 10_000;
const FIXTURE_EXIT_POLL_MS = 2 * PS_SNAPSHOT_TIMEOUT_MS + 2000;

function liveFixturePids(timeout: number): number[] | null {
  const snapshot = Bun.spawnSync(["/bin/ps", "-wwaxo", "pid=,stat=,args="], {
    timeout,
  });
  if (snapshot.exitedDueToTimeout) {
    return null;
  }
  expect(snapshot.exitCode).toBe(0);
  return snapshot.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/, 3);
      const pid = Number(fields[0]);
      const root = fixtureProcesses.get(pid);
      return root && !fields[1]?.startsWith("Z") && line.includes(` ${root} `)
        ? [pid]
        : [];
    });
}

afterAll(async () => {
  await Promise.all([...fixtureRoots].map(recordFixturePids));
  const deadline = performance.now() + FIXTURE_EXIT_POLL_MS;
  let alive: number[] | null = null;
  for (
    let remaining = Math.floor(deadline - performance.now());
    remaining > 0;
    remaining = Math.floor(deadline - performance.now())
  ) {
    alive = liveFixturePids(Math.min(PS_SNAPSHOT_TIMEOUT_MS, remaining));
    if (alive?.length === 0) {
      return;
    }
    await Bun.sleep(25);
  }
  expect(
    alive,
    alive === null
      ? "Could not verify fixture exit: ps snapshot timed out"
      : "Fixture processes still alive"
  ).toEqual([]);
}, 30_000);

function fixtureEnv(root: string) {
  return privateCliEnv({
    root,
    env: {
      HACK_NO_INTERACTIVE: "1",
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
    },
  });
}

async function waitForFile(path: string): Promise<string> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => null);
    if (value !== null) {
      return value;
    }
    await Bun.sleep(10);
  }
  throw new Error("Synthetic owner did not settle within its budget");
}

async function stop(root: string): Promise<void> {
  await fetch("http://localhost/stop", {
    unix: join(root, "control.sock"),
    signal: AbortSignal.timeout(1000),
  }).catch(() => undefined);
}

for (const mode of [
  "ready",
  "profile-notice",
  "pool-restart-notice",
  "branch-dropped",
  "hot-reload-off",
  "hot-reload-unsafe",
  "restart-action",
  "shell-names",
  "shell-names-empty",
  "shell-names-root-dotenv",
  "unsafe-failure",
  "unsafe-prestart-refusal",
  "fail",
  "builder-missing",
  "build-registry-limit",
  "provider-pin",
  "wrapped-provider-pin",
  "timeout",
  "launcher-loss",
  "cancel-at-accept",
  "late-ready",
  "launcher-interrupt",
  "launcher-terminate",
] as const) {
  test(`native detached owner: ${mode}`, async () => {
    const root = await fixtureRoot("native-detached-");
    const launcher = Bun.spawn(
      [process.execPath, fixture, "launcher", root, mode],
      {
        env: {
          ...fixtureEnv(root),
          FIXTURE_READY_ADDRESS: "https://sample.hack.local",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    try {
      const pid = Number(await waitForFile(join(root, "owner.pid")));
      expect(pid).toBeGreaterThan(0);
      if (mode === "launcher-loss") {
        launcher.kill("SIGKILL");
      } else if (mode === "launcher-interrupt") {
        launcher.kill("SIGINT");
      } else if (mode === "launcher-terminate") {
        launcher.kill("SIGTERM");
      }
      const code = await launcher.exited;
      const stdout = await new Response(launcher.stdout).text();
      const stderr = await new Response(launcher.stderr).text();
      expect(stderr).toBe(
        mode === "profile-notice"
          ? "Not starting 1 service whose Compose profiles are not selected: jobs. Selected profiles: none (from no --profile or COMPOSE_PROFILES). Select others with --profile or COMPOSE_PROFILES.\n"
          : mode === "pool-restart-notice"
            ? `${NATIVE_IDLE_POOL_RESTART_NOTICE}\n`
            : mode === "branch-dropped"
              ? "Branch feature-a: service web label caddy drops 2 sites outside this project's route namespaces; they stay with the base instance.\n"
              : mode === "hot-reload-off"
                ? `${renderNativeHotReloadNotice({ state: "off", reason: "large_share", limit: 100_000 })}\n`
                : mode === "shell-names"
                  ? "Forwarding shell variables: A_TOKEN, Z_TOKEN.\n"
                  : mode === "shell-names-empty"
                    ? "Forwarding shell variables: (none).\n"
                    : mode === "shell-names-root-dotenv"
                      ? `Forwarding shell variables: (none).\n${NATIVE_ROOT_DOTENV_IGNORED_NOTICE}\n`
                      : ""
      );
      if (
        [
          "ready",
          "profile-notice",
          "pool-restart-notice",
          "branch-dropped",
          "hot-reload-off",
          "hot-reload-unsafe",
          "restart-action",
          "shell-names",
          "shell-names-empty",
          "shell-names-root-dotenv",
          "unsafe-failure",
          "unsafe-prestart-refusal",
        ].includes(mode)
      ) {
        expect(code).toBe(0);
        // HACK native CLI gaps item 2: a detached restart reports the same
        // envelope as Compose's `restart --json`, with its own action.
        expect(JSON.parse(stdout)).toEqual({
          ok: true,
          data: {
            action: mode === "restart-action" ? "restart" : "up",
            project: "fixture",
            branch: null,
            composeProject: "fixture",
            services: {
              started: ["web"],
              completed: ["seed"],
              stopped: [],
              failed: [],
            },
            durationMs: expect.any(Number),
          },
        });
        // Launcher has exited. The independently addressed owner still serves
        // control from another process, rather than merely having emitted ready.
        process.kill(pid, 0);
        await stop(root);
      } else if (
        mode === "launcher-interrupt" ||
        mode === "launcher-terminate"
      ) {
        expect(code).toBe(mode === "launcher-interrupt" ? 130 : 143);
        expect(JSON.parse(stdout)).toMatchObject({
          ok: false,
          error: { code: "E_CANCELLED" },
        });
      } else if (mode === "build-registry-limit") {
        expect(code).toBe(1);
        expect(JSON.parse(stdout).error.message).toBe(
          "Image unavailable: could not resolve build base docker.io/library/python:3.12-alpine (registry rate limit reached).\nAlready present: docker.io/library/alpine:3.22.\nRetry hack up when the registry is reachable."
        );
      } else if (mode === "builder-missing") {
        // A detached owner reports the code only; the launcher must still tell the
        // user what is wrong and the one command that fixes it.
        expect(code).toBe(1);
        const result = JSON.parse(stdout);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "E_STARTUP_INCOMPLETE" },
        });
        expect(result.error.message).toContain("(builder_not_prepared)");
        expect(result.error.message).toContain(
          "the image builder is not installed in this native home"
        );
        expect(result.error.message).toContain(
          "native setup --accept-downloads"
        );
        expect(result.error.message).toContain("--builder");
        expect(result.error.message).not.toContain("os error");
        expect(stdout).not.toContain("synthetic-private-value");
      } else if (["provider-pin", "wrapped-provider-pin"].includes(mode)) {
        expect(code).toBe(1);
        const result = JSON.parse(stdout);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "E_STARTUP_INCOMPLETE" },
        });
        expect(result.error.message).toContain("provider_pin_changed");
        expect(result.error.message).toContain(NATIVE_PROVIDER_PIN_MESSAGE);
        expect(stdout).not.toContain("synthetic-private-value");
      } else {
        expect(code).not.toBe(0);
        expect(stdout).toBe("");
      }
      if (
        ![
          "fail",
          "builder-missing",
          "build-registry-limit",
          "provider-pin",
          "wrapped-provider-pin",
        ].includes(mode)
      ) {
        expect(await waitForFile(join(root, "stopped"))).toBe(
          "down.before\nprocess.stop\ndown.after\n"
        );
        expect(await readFile(join(root, "stop-signals"), "utf8")).toBe(
          [
            "ready",
            "profile-notice",
            "pool-restart-notice",
            "branch-dropped",
            "hot-reload-off",
            "hot-reload-unsafe",
            "restart-action",
            "shell-names",
            "shell-names-root-dotenv",
            "shell-names-empty",
            "unsafe-failure",
            "unsafe-prestart-refusal",
          ].includes(mode)
            ? "0"
            : "1"
        );
      }
    } finally {
      await stop(root);
      if (launcher.exitCode === null) {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
      await removeFixture(root);
    }
  }, 15_000);
}

for (const phase of ["static-preflight", "after-start"] as const) {
  test(`detached ${phase} failure keeps validated runtime detail through cleanup wrappers, never their text`, async () => {
    const root = await fixtureRoot("native-detached-failure-");
    const launcher = Bun.spawn(
      [
        process.execPath,
        fixture,
        "launcher",
        root,
        phase === "static-preflight"
          ? "wrapped-static-failure"
          : "wrapped-failure",
      ],
      {
        env: fixtureEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("graph_port_publication") },
      });
      expect(stdout).toContain("Native publishes only TCP ports");
      if (phase === "static-preflight") {
        expect(stdout).toContain("nothing was started");
        expect(stdout).toContain("keep UDP publication on the Compose backend");
        expect(stdout).toContain("hack doctor --native-preflight");
        expect(stdout).not.toContain("retained owners and recovery evidence");
        expect(stdout).not.toContain("inspect hack ps");
      } else {
        expect(stdout).toContain("inspect hack ps before retrying");
        expect(stdout).toContain(
          "retained owners and recovery evidence are preserved"
        );
        expect(stdout).not.toContain("nothing was started");
      }
      expect(stdout + stderr).not.toContain("synthetic-private-value");
      expect(stderr).toBe("");
    } finally {
      if (launcher.exitCode === null) {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
      await removeFixture(root);
    }
  });
}

test("the detached CLI preserves the native authored attempt limit refusal", async () => {
  const root = await fixtureRoot("native-detached-attempt-limit-");
  const launcher = Bun.spawn(
    [process.execPath, fixture, "launcher", root, "authored-attempt-limit"],
    { env: fixtureEnv(root), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      launcher.exited,
      new Response(launcher.stdout).text(),
      new Response(launcher.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: {
        code: "E_STARTUP_INCOMPLETE",
        message: expect.stringContaining(
          "native authored graph limit is 64 attempts"
        ),
        detail: { nativeCode: "native_graph_attempt_limit" },
      },
    });
    expect(stdout).toContain("private environment records");
    expect(stdout).toContain("hack doctor --native-cleanup inspect");
    expect(stderr).toBe("");
  } finally {
    if (launcher.exitCode === null) {
      launcher.kill("SIGTERM");
      await launcher.exited;
    }
    await removeFixture(root);
  }
});

test("the detached owner gets only the command and its selection options", () => {
  expect(
    nativeDetachedOwnerArgs({
      action: "restart",
      options: {
        path: "/work/app",
        branch: "feature-x",
        env: "qa",
        profile: "web,jobs",
      },
    })
  ).toEqual([
    "restart",
    "--path=/work/app",
    "--branch=feature-x",
    "--env=qa",
    "--profile=web,jobs",
  ]);
  expect(nativeDetachedOwnerArgs({ action: "up", options: {} })).toEqual([
    "up",
  ]);
});

test("detached failure names the services that failed during startup and how to see their output, never the output", async () => {
  const root = await fixtureRoot("native-detached-failed-services-");
  const launcher = Bun.spawn(
    [process.execPath, fixture, "launcher", root, "failed-services"],
    {
      env: fixtureEnv(root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      launcher.exited,
      new Response(launcher.stdout).text(),
      new Response(launcher.stderr).text(),
    ]);
    expect(code).toBe(1);
    const message = JSON.parse(stdout).error.message as string;
    expect(message).toContain(
      "Native detached startup failed (engine_rejected)"
    );
    // Sorted, de-duplicated, and only names that pass the service-name rule.
    expect(message).toContain("Failed during startup: api, web.");
    expect(message).toContain("run hack up without -d in a terminal");
    expect(message).toContain("inspect hack ps before retrying");
    expect(stdout + stderr).not.toContain("synthetic-private-value");
    expect(stdout + stderr).not.toContain("synthetic private value");
    expect(stdout + stderr).not.toContain("break");
    expect(stderr).toBe("");
  } finally {
    if (launcher.exitCode === null) {
      launcher.kill("SIGTERM");
      await launcher.exited;
    }
    await removeFixture(root);
  }
});

test("detached immediate exit drains its fixed failure before reporting an unconfirmed start", async () => {
  const modes = [
    "exit-first-failure",
    ...new Array<string>(8).fill("immediate-failure"),
  ];
  for (const mode of modes) {
    const root = await fixtureRoot("native-detached-exit-");
    const launcher = Bun.spawn(
      [process.execPath, fixture, "launcher", root, mode],
      {
        env: fixtureEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: { code: "E_STARTUP_INCOMPLETE" },
      });
      expect(stdout).toContain("graph_port_publication");
      expect(stdout).toContain("Native publishes only TCP ports");
      expect(stdout).not.toContain("startup was not confirmed");
      expect(stdout + stderr).not.toContain("synthetic-private-value");
      expect(stderr).toBe("");
    } finally {
      if (launcher.exitCode === null) {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
      await removeFixture(root);
    }
  }
}, 30_000);

test("detached owner exit has a short grace even when its descendant holds the IPC descriptor", async () => {
  const root = await fixtureRoot("native-detached-channel-");
  const started = performance.now();
  const launcher = Bun.spawn(
    [process.execPath, fixture, "launcher", root, "held-channel"],
    {
      env: fixtureEnv(root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 6000,
    }
  );
  try {
    await waitForFile(join(root, "holder-ready"));
    const code = await launcher.exited;
    expect(code).toBe(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1000);
    expect(performance.now() - started).toBeLessThan(5000);
    // The descendant still owns its endpoint when the launcher has returned.
    const held = await fetch("http://localhost/stop", {
      unix: join(root, "holder.sock"),
    });
    expect(await held.text()).toBe("held");
    await waitForFile(join(root, "holder-stopped"));
  } finally {
    if (launcher.exitCode === null) {
      launcher.kill("SIGTERM");
      await launcher.exited;
    }
    await fetch("http://localhost/stop", {
      unix: join(root, "holder.sock"),
    }).catch(() => undefined);
    if (await Bun.file(join(root, "holder-ready")).exists()) {
      await waitForFile(join(root, "holder-stopped"));
    }
    await removeFixture(root);
  }
}, 12_000);

test("HACK-2339: a refusal before VM work reaches the launcher as the foreground prints it, with the failed hook's lines on stderr", async () => {
  for (const mode of [
    "prestart-refusal",
    "prestart-after-runtime",
    "prestart-plain-error",
  ]) {
    const root = await fixtureRoot("native-detached-prestart-");
    const launcher = Bun.spawn(
      [process.execPath, fixture, "launcher", root, mode],
      {
        env: fixtureEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ]);
      expect(code).toBe(1);
      const error = JSON.parse(stdout).error;
      if (mode === "prestart-refusal") {
        expect(error).toEqual({
          code: "E_LIFECYCLE_FAILED",
          message:
            "Lifecycle (native up before) failed (exit 3); values omitted.",
        });
        // stderr is not a terminal here: one fixed line, never the hook's.
        expect(stderr).toBe(`${NATIVE_HOOK_OUTPUT_TERMINAL_ONLY}\n`);
        expect(stdout + stderr).not.toContain("red hook line");
      } else {
        // After VM work starts, or for an error that is not a closed refusal,
        // nothing crosses: the start stays unconfirmed, as before.
        expect(error.code).toBe("E_STARTUP_INCOMPLETE");
        expect(error.message).toContain("was not confirmed");
        expect(stderr).toBe("");
        expect(stdout + stderr).not.toContain("synthetic-private-value");
      }
    } finally {
      if (launcher.exitCode === null) {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
      await removeFixture(root);
    }
  }
}, 30_000);

test("detached native up closes with its served address or no address", async () => {
  for (const address of ["https://sample.hack.local:8443", ""]) {
    const root = await fixtureRoot("native-detached-closing-");
    const launcher = Bun.spawn(
      [process.execPath, fixture, "launcher", root, "ready"],
      {
        env: {
          ...fixtureEnv(root),
          FIXTURE_TEXT_OUTPUT: "1",
          FIXTURE_READY_ADDRESS: address,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
      }
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toStartWith(`${address || "no address"}  up in `);
      expect(stdout).toMatch(/\d+\.\ds · native\n$/);
      await stop(root);
    } finally {
      await removeFixture(root);
    }
  }
}, 20_000);

test("a detached fixture owner exits when its root disappears", async () => {
  const root = await fixtureRoot("native-detached-root-");
  const launcher = Bun.spawn(
    [process.execPath, fixture, "launcher", root, "ready"],
    { env: fixtureEnv(root), stdout: "ignore", stderr: "ignore", timeout: 8000 }
  );
  try {
    expect(await launcher.exited).toBe(0);
    expect(await Bun.file(join(root, "owner.fixture-pid")).exists()).toBe(true);
  } finally {
    await removeFixture(root);
  }
}, 15_000);

/** The fixture's `prestart-long` refusal (the fixture runs on import, so it is not imported). */
const PRESTART_LONG_MESSAGE = `Selected source is too large. ${"assets/deeply/nested/".repeat(2100)}`;

/** Run one HACK-2339 fixture mode through a real launcher and owner. */
async function prestartRun(mode: string, terminal = false) {
  const root = await fixtureRoot("native-detached-prestart-");
  const launcher = Bun.spawn(
    [process.execPath, fixture, "launcher", root, mode],
    {
      env: {
        ...fixtureEnv(root),
        ...(terminal ? { FIXTURE_STDERR_TERMINAL: "1" } : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      launcher.exited,
      new Response(launcher.stdout).text(),
      new Response(launcher.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    if (launcher.exitCode === null) {
      launcher.kill("SIGTERM");
      await launcher.exited;
    }
    try {
      await stop(root);
      if (launcher.exitCode === 0) {
        await waitForFile(join(root, "stopped"));
      }
    } finally {
      await removeFixture(root);
    }
  }
}

test("HACK-2339: a refusal longer than one line, such as a long source-size list, crosses whole", async () => {
  const result = await prestartRun("prestart-long");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toEqual({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: PRESTART_LONG_MESSAGE,
  });
}, 30_000);

test("HACK-2339: a real failed hook's output reaches a terminal launcher bounded per line", async () => {
  const result = await prestartRun("prestart-hook-long-line", true);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("E_LIFECYCLE_FAILED");
  expect(result.stderr.split("\n")).toEqual([
    "Lifecycle (native up before): seed-check: head -c 3000000 /dev/zero | tr '\\000' x; echo; printf 'last line\\n'; exit 3",
    "x".repeat(500),
    "last line",
    "Lifecycle (native up before) failed (exit 3): seed-check: head -c 3000000 /dev/zero | tr '\\000' x; echo; printf 'last line\\n'; exit 3",
    "",
  ]);
}, 30_000);

test("HACK-2339: a persistent up.before command that cannot start shows its step and failure on a terminal", async () => {
  const result = await prestartRun("prestart-persistent-hook", true);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("E_LIFECYCLE_FAILED");
  expect(result.stderr).toBe(
    "Lifecycle (native up before): session: run-session\nLifecycle session could not start.\n"
  );
}, 30_000);

test("HACK-2339: a failed hook's lines reach only a terminal stderr; otherwise one fixed line says how to see them", async () => {
  const terminal = await prestartRun("prestart-refusal", true);
  // Escape sequences dropped, each line bounded; never on stdout.
  expect(terminal.stderr).toBe(
    [
      "Lifecycle (native up before): seed-check: ./seed.sh",
      "[31mred hook line[0m",
      "x".repeat(500),
      "Lifecycle (native up before) failed (exit 3): seed-check: ./seed.sh",
      "",
    ].join("\n")
  );
  expect(terminal.stdout).not.toContain("red hook line");
  // A captured stderr (an agent tool, a pipe) never receives hook output.
  const captured = await prestartRun("prestart-hook-long-line");
  expect(captured.stderr).toBe(`${NATIVE_HOOK_OUTPUT_TERMINAL_ONLY}\n`);
  expect(captured.stdout + captured.stderr).not.toContain("last line");
  expect(JSON.parse(captured.stdout).error.code).toBe("E_LIFECYCLE_FAILED");
  expect(
    nativePrestartHookLines({ lines: undefined, terminal: false })
  ).toEqual([]);
  expect(nativePrestartHookLines({ lines: ["a"], terminal: true })).toEqual([
    "a",
  ]);
}, 60_000);

test("detached JSON retains every image refusal and recovery action", async () => {
  const result = await prestartRun("image-batch-errors");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_LIFECYCLE_FAILED",
      detail: {
        images: [
          {
            reference: "fixture/image:a",
            code: "provider_busy",
            recovery:
              "Run hack up again after the current image work finishes.",
          },
          {
            reference: "fixture/image:b",
            code: "image_disk_space",
            recovery: "Free disk space and run hack up again.",
          },
        ],
      },
    },
  });
}, 30_000);

test("HACK-2351: image work longer than the budget, with heartbeats, still completes", async () => {
  const result = await prestartRun("slow-images");
  expect(result.code, result.stdout || result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { action: "up", services: { started: ["web"] } },
  });
}, 30_000);

for (const mode of ["slow-runtime", "images-ceiling", "images-wait-ceiling"]) {
  test(`HACK-2351: ${mode} times out naming its phase, and its owner has stopped when the launcher returns`, async () => {
    const root = await fixtureRoot("native-detached-deadline-");
    const launcher = Bun.spawn(
      [process.execPath, fixture, "launcher", root, mode],
      {
        env: fixtureEnv(root),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    try {
      const [code, stdout] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
      ]);
      expect(code).toBe(1);
      const error = JSON.parse(stdout).error;
      if (mode === "images-wait-ceiling") {
        expect(error.message.split("\n")).toEqual([
          "Image unavailable: another start is downloading docker.io/fixture/image:stable.",
          "Already present: could not verify.",
          "Run hack up again after the download finishes.",
        ]);
      } else {
        expect(error.code).toBe("E_STARTUP_TIMEOUT");
        expect(error.message).toContain(
          mode === "slow-runtime"
            ? "it was starting the native runtime when its 1 s budget"
            : "it was building and loading service images when its 2 s ceiling"
        );
        expect(error.message).toContain("Run hack down for this instance next");
      }
      // The launcher waited for the owner to stop before it returned.
      expect(await readFile(join(root, "stopped"), "utf8")).toBe(
        "down.before\nprocess.stop\ndown.after\n"
      );
    } finally {
      await stop(root);
      if (launcher.exitCode === null) {
        launcher.kill("SIGTERM");
        await launcher.exited;
      }
      await removeFixture(root);
    }
  }, 30_000);
}
