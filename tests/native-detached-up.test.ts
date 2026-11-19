import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../src/backends/native-runtime-client.ts";
import {
  NATIVE_HOOK_OUTPUT_TERMINAL_ONLY,
  nativeDetachedOwnerArgs,
  nativePrestartHookLines,
} from "../src/lib/native-detached-up.ts";
import { NATIVE_ROOT_DOTENV_IGNORED_NOTICE } from "../src/lib/native-environment-notices.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const fixture = join(import.meta.dir, "fixtures", "native-detached-owner.ts");

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
  }).catch(() => undefined);
}

for (const mode of [
  "ready",
  "profile-notice",
  "branch-dropped",
  "restart-action",
  "shell-names",
  "shell-names-empty",
  "shell-names-root-dotenv",
  "unsafe-failure",
  "unsafe-prestart-refusal",
  "fail",
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
    const root = await mkdtemp(join(tmpdir(), "native-detached-"));
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
          : mode === "branch-dropped"
            ? "Branch feature-a: service web label caddy drops 2 sites outside this project's route namespaces; they stay with the base instance.\n"
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
          "branch-dropped",
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
      if (!["fail", "provider-pin", "wrapped-provider-pin"].includes(mode)) {
        expect(await waitForFile(join(root, "stopped"))).toBe(
          "down.before\nprocess.stop\ndown.after\n"
        );
        expect(await readFile(join(root, "stop-signals"), "utf8")).toBe(
          [
            "ready",
            "profile-notice",
            "branch-dropped",
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
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}

for (const phase of ["static-preflight", "after-start"] as const) {
  test(`detached ${phase} failure keeps validated runtime detail through cleanup wrappers, never their text`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-detached-failure-"));
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
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
  const root = await mkdtemp(
    join(tmpdir(), "native-detached-failed-services-")
  );
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
    await rm(root, { recursive: true, force: true });
  }
});

test("detached immediate exit drains its fixed failure before reporting an unconfirmed start", async () => {
  const modes = [
    "exit-first-failure",
    ...new Array<string>(8).fill("immediate-failure"),
  ];
  for (const mode of modes) {
    const root = await mkdtemp(join(tmpdir(), "native-detached-exit-"));
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
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("detached owner exit has a short grace even when its descendant holds the IPC descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-detached-channel-"));
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
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test("HACK-2339: a refusal before VM work reaches the launcher as the foreground prints it, with the failed hook's lines on stderr", async () => {
  for (const mode of [
    "prestart-refusal",
    "prestart-after-runtime",
    "prestart-plain-error",
  ]) {
    const root = await mkdtemp(join(tmpdir(), "native-detached-prestart-"));
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
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

/** The fixture's `prestart-long` refusal (the fixture runs on import, so it is not imported). */
const PRESTART_LONG_MESSAGE = `Selected source is too large. ${"assets/deeply/nested/".repeat(2100)}`;

/** Run one HACK-2339 fixture mode through a real launcher and owner. */
async function prestartRun(mode: string, terminal = false) {
  const root = await mkdtemp(join(tmpdir(), "native-detached-prestart-"));
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
    await rm(root, { recursive: true, force: true });
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
