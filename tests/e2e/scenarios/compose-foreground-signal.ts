import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import {
  buildCliEnv,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";
import { downBestEffort } from "./docker-shared.ts";

/** A real terminal-group interrupt must finish Compose shutdown before CLI exit. */
export const composeForegroundSignalScenario: Scenario = {
  name: "compose-foreground-signal",
  tier: "docker",
  summary: "first foreground Compose Ctrl-C stops both containers before exit",
  run: async (ctx) => {
    const info = await runCommand({
      argv: ["docker", "info"],
      cwd: ctx.tempRoot,
      timeoutMs: 30_000,
    });
    if (info.exitCode !== 0) {
      ctx.skip("docker daemon unavailable");
    }
    for (const persistentUpBefore of [false, true]) {
      const fixture = await createMonorepoFixture({
        parentDir: ctx.tempRoot,
        withHackConfig: true,
        lifecycle: { disableInternal: true, persistentUpBefore },
      });
      const service = {
        image: "alpine:3.20",
        command: [
          "sh",
          "-c",
          "echo foreground-ready; trap 'sleep 3; exit 0' TERM; while :; do sleep 1; done",
        ],
        stop_grace_period: "8s",
      };
      await Bun.write(
        join(fixture.hackDir, "docker-compose.yml"),
        JSON.stringify({
          name: fixture.name,
          services: { app: service, worker: service },
        })
      );
      const logPath = join(ctx.tempRoot, `${fixture.name}.stdout.log`);
      const log = Bun.file(logPath);
      const errorLog = Bun.file(
        join(ctx.tempRoot, `${fixture.name}.stderr.log`)
      );
      const child = Bun.spawn(resolveCliSpawnArgs(["up"]), {
        cwd: fixture.root,
        env: buildCliEnv({
          hackHome: ctx.hackHome,
          extra: { HACK_RUNTIME_BACKEND: "compose" },
        }),
        detached: true,
        stdin: "ignore",
        stdout: log,
        stderr: errorLog,
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
      const containers = () =>
        runCommand({
          argv: [
            "docker",
            "ps",
            "-q",
            "--filter",
            `label=com.docker.compose.project=${fixture.name}`,
          ],
          cwd: fixture.root,
          timeoutMs: 15_000,
        });
      try {
        const deadline = Date.now() + 90_000;
        let ready = false;
        while (Date.now() < deadline && child.exitCode === null) {
          const output = await Bun.file(logPath).text();
          if ((output.match(/foreground-ready/g) ?? []).length >= 2) {
            ready = true;
            break;
          }
          await Bun.sleep(100);
        }
        expect({
          that: ready,
          message: `both services must emit logs before Ctrl-C: ${await Bun.file(logPath).text()}\n${await errorLog.text()}`,
        });
        const before = await containers();
        expectExit({
          result: before,
          codes: [0],
          message: "container inspection before Ctrl-C",
        });
        expect({
          that: before.stdout.trim().split("\n").length === 2,
          message: "two project containers must be running before Ctrl-C",
        });
        process.kill(-child.pid, "SIGINT");
        const code = await child.exited;
        const after = await containers();
        ctx.log(
          `persistent lifecycle=${persistentUpBefore}; foreground exit=${code}; running project containers=${after.stdout.trim() || "none"}; output:\n${await Bun.file(logPath).text()}\n${await errorLog.text()}`
        );
        expect({
          that: code === 130,
          message: "foreground Ctrl-C must exit 130",
        });
        expectExit({
          result: after,
          codes: [0],
          message: "container inspection immediately after CLI exit",
        });
        expect({
          that: after.stdout.trim() === "",
          message:
            "first Ctrl-C must leave no project container running at CLI exit",
          result: after,
        });
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
        await downBestEffort({ ctx, fixture });
      }
    }
  },
};
