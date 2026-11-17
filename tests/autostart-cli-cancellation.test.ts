import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

async function checkpoint(path: string, alive: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!(await Bun.file(path).exists())) {
    if (!alive() || Date.now() >= deadline) {
      throw new Error("Owned cancellation fixture checkpoint unavailable");
    }
    await Bun.sleep(10);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`explicit autostart CLI ${signal} awaits detached startup settlement`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-autostart-cancel-"));
    const env = privateCliEnv({ root });
    const hackHome = join(env.HOME ?? root, ".hack");
    await mkdir(hackHome, { mode: 0o700 });
    const registryPath = join(hackHome, "projects.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: ["alpha", "beta"].map((name) => ({
          id: name,
          name,
          repoRoot: join(root, name),
          projectDir: join(root, name, ".hack"),
          projectDirName: ".hack",
          createdAt: "2026-01-01T00:00:00Z",
          autostart: {
            branch: null,
            paused: false,
            lastResult: null,
            lastAttemptBootId: null,
          },
        })),
      }),
      { mode: 0o600 }
    );
    const ready = join(root, "ready"),
      stopping = join(root, "stopping"),
      settled = join(root, "settled");
    const helper = join(root, "startup.ts");
    await writeFile(
      helper,
      `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(stopping)}, "stopping");
  setTimeout(() => { writeFileSync(${JSON.stringify(settled)}, "settled"); process.exit(0); }, 250);
});
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 60000);
`
    );
    const driver = join(root, "driver.ts");
    const modulePath = resolve("src/daemon/autostart.ts");
    await writeFile(
      driver,
      `
import { mock } from "bun:test";
const actual = await import(${JSON.stringify(modulePath)});
const runPass = actual.runAutostartAtLogin;
mock.module(${JSON.stringify(modulePath)}, () => ({ ...actual,
 runAutostartAtLogin: (options) => runPass({ ...options, dependencies: {
  bootId: async () => "fixture-boot", now: Date.now, sleep: (ms) => Bun.sleep(ms),
  engineReady: async () => true, routingInstalled: async () => false,
  startRouting: async () => true, inspect: async () => "stopped",
  start: async (_project, signal) => actual.classifyAutostartExit(await actual.runAutostartSubprocess(
   [process.execPath, ${JSON.stringify(helper)}], { timeoutMs: 120000, signal, env: process.env }
  )),
 } }),
}));
const { runCli } = await import(${JSON.stringify(resolve("src/cli/run.ts"))});
process.exitCode = await runCli(["autostart", "run", "--no-interactive", "--json"]);
`
    );
    const proc = Bun.spawn([process.execPath, driver], {
      env,
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text(),
      stderr = new Response(proc.stderr).text();
    let helperPid: number | undefined;
    try {
      await checkpoint(ready, () => proc.exitCode === null);
      helperPid = Number(await readFile(ready, "utf8"));
      expect(Number.isSafeInteger(helperPid)).toBe(true);
      proc.kill(signal);
      await checkpoint(stopping, () => proc.exitCode === null);
      expect(proc.exitCode).toBeNull();
      proc.kill(signal);
      expect(await proc.exited, await stderr).toBe(
        signal === "SIGINT" ? 130 : 143
      );
      expect(await Bun.file(settled).text()).toBe("settled");
      expect(await stdout).toBe("");
      expect(() => process.kill(helperPid ?? -1, 0)).toThrow();
      const registry = await Bun.file(registryPath).json();
      expect(registry.autostartGlobal.loginRun.inProgress).toBe(false);
      expect(registry.projects[0].autostart.lastResult).toMatchObject({
        status: "skipped",
        reason: "daemon_stopped",
      });
      expect(registry.projects[1].autostart.lastAttemptBootId).toBeNull();
    } finally {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
      }
      await proc.exited;
      if (
        helperPid !== undefined &&
        Number.isSafeInteger(helperPid) &&
        helperPid > 1
      ) {
        try {
          process.kill(-helperPid, "SIGKILL");
        } catch {
          /* Owned group already settled. */
        }
      }
      await Promise.all([stdout, stderr]);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
