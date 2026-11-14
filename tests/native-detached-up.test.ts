import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../src/backends/native-runtime-client.ts";
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
  "shell-names",
  "shell-names-empty",
  "shell-names-root-dotenv",
  "unsafe-failure",
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
        mode === "shell-names"
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
          "shell-names",
          "shell-names-empty",
          "shell-names-root-dotenv",
          "unsafe-failure",
        ].includes(mode)
      ) {
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          ok: true,
          data: {
            action: "up",
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
            "shell-names",
            "shell-names-root-dotenv",
            "shell-names-empty",
            "unsafe-failure",
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
