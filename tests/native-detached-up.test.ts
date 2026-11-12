import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../src/backends/native-runtime-client.ts";
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
            : ""
      );
      if (
        [
          "ready",
          "shell-names",
          "shell-names-empty",
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

test("detached failure keeps validated runtime detail through cleanup wrappers, never their text", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-detached-failure-"));
  const launcher = Bun.spawn(
    [process.execPath, fixture, "launcher", root, "wrapped-failure"],
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
