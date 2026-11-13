import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readLifecycleState } from "../../../src/lib/lifecycle-runtime.ts";
import { quoteShellWord } from "../../../src/lib/logs.ts";
import { readProjectRuntimeState } from "../../../src/lib/project-runtime-state.ts";
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
        lifecycle: {
          disableInternal: true,
          persistentUpBefore,
          // A cooperative writer can take time to exit after TERM. Keep that
          // interval visible so mux acknowledgement cannot masquerade as exit.
          persistentUpBeforeCommand:
            "bun -e 'process.on(\"SIGTERM\", () => setTimeout(() => process.exit(0), 1000)); setInterval(() => {}, 60000)'",
        },
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
      const cleanupEntered = join(
        ctx.tempRoot,
        `${fixture.name}.cleanup-entered`
      );
      const cleanupReleased = join(
        ctx.tempRoot,
        `${fixture.name}.cleanup-released`
      );
      const shimDir = join(ctx.tempRoot, `${fixture.name}.bin`);
      if (persistentUpBefore) {
        const tmux = Bun.which("tmux");
        expect({
          that: tmux !== null,
          message: "lifecycle shutdown regression requires tmux",
        });
        await mkdir(shimDir);
        const shim = join(shimDir, "tmux");
        await Bun.write(
          shim,
          `#!/bin/sh
if [ "$1" = kill-session ]; then
  printf ready > ${quoteShellWord(cleanupEntered)}
  attempts=0
  while [ ! -f ${quoteShellWord(cleanupReleased)} ] && [ "$attempts" -lt 100 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
fi
exec ${quoteShellWord(tmux ?? "tmux")} "$@"
`
        );
        await chmod(shim, 0o700);
      }
      const child = Bun.spawn(resolveCliSpawnArgs(["up"]), {
        cwd: fixture.root,
        env: buildCliEnv({
          hackHome: ctx.hackHome,
          extra: {
            HACK_RUNTIME_BACKEND: "compose",
            ...(persistentUpBefore
              ? { PATH: `${shimDir}:${process.env.PATH}` }
              : {}),
          },
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
        await expectServicesReady({
          child,
          stdout: logPath,
          stderr: errorLog.name,
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
        const lifecycleBefore = await readLifecycleState({
          projectDir: fixture.hackDir,
        });
        const processGroup = lifecycleBefore.find(
          (entry) => entry.composeProject === fixture.name
        )?.processes[0]?.processGroupId;
        if (persistentUpBefore) {
          expect({
            that: processGroup !== undefined && processGroup > 1,
            message:
              "persistent lifecycle must publish its process group before Ctrl-C",
          });
        }
        process.kill(-child.pid, "SIGINT");
        await interruptDuringCleanup({
          enabled: persistentUpBefore,
          child,
          entered: cleanupEntered,
          released: cleanupReleased,
        });
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
        expect({
          that: !`${await Bun.file(logPath).text()}\n${await errorLog.text()}`.includes(
            "docker compose up failed"
          ),
          message: "an intentional interrupt is not a Compose startup failure",
        });
        expect({
          that:
            (await readProjectRuntimeState({ projectDir: fixture.hackDir }))
              .length === 0,
          message: "foreground shutdown must retire runtime state",
        });
        expect({
          that:
            (await readLifecycleState({ projectDir: fixture.hackDir }))
              .length === 0,
          message: "foreground shutdown must retire lifecycle state",
        });
        await expectLifecycleProcessGone({
          enabled: persistentUpBefore,
          processGroup,
          name: fixture.name,
          cwd: fixture.root,
        });
      } finally {
        await Bun.write(cleanupReleased, "release");
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

async function expectLifecycleProcessGone(opts: {
  readonly enabled: boolean;
  readonly processGroup: number | undefined;
  readonly name: string;
  readonly cwd: string;
}): Promise<void> {
  if (opts.enabled && opts.processGroup !== undefined) {
    const session = await runCommand({
      argv: ["tmux", "has-session", "-t", `=${opts.name}--lifecycle`],
      cwd: opts.cwd,
    });
    expect({
      that: session.exitCode !== 0,
      message: "persistent lifecycle session must be gone before CLI exit",
      result: session,
    });
    let groupAbsent = false;
    try {
      process.kill(-opts.processGroup, 0);
    } catch (error: unknown) {
      groupAbsent =
        error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    let members = "";
    if (!groupAbsent) {
      const snapshot = await runCommand({
        argv: ["ps", "-axo", "pid=,ppid=,pgid=,stat=,comm="],
        cwd: opts.cwd,
        timeoutMs: 1000,
      });
      members = snapshot.stdout
        .split("\n")
        .filter(
          (row) => row.trim().split(/\s+/)[2] === String(opts.processGroup)
        )
        .join("\n");
    }
    expect({
      that: groupAbsent,
      message: `persistent lifecycle command process group must be gone before CLI exit; pgid=${opts.processGroup}; members:\n${members}`,
    });
  }
}

async function interruptDuringCleanup(opts: {
  readonly enabled: boolean;
  readonly child: Bun.Subprocess;
  readonly entered: string;
  readonly released: string;
}): Promise<void> {
  if (opts.enabled) {
    const deadline = Date.now() + 15_000;
    while (
      !(await Bun.file(opts.entered).exists()) &&
      opts.child.exitCode === null &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }
    expect({
      that: await Bun.file(opts.entered).exists(),
      message: "must reach lifecycle teardown after Compose exits",
    });
    // Two more group interrupts arrive while the real tmux teardown is
    // paused. Neither may terminate Hack or abandon its owned cleanup.
    process.kill(-opts.child.pid, "SIGINT");
    await Bun.sleep(50);
    process.kill(-opts.child.pid, "SIGINT");
    await Bun.sleep(50);
    expect({
      that: opts.child.exitCode === null,
      message: "repeated Ctrl-C must not abort lifecycle cleanup",
    });
    await Bun.write(opts.released, "release");
  }
}

async function expectServicesReady(opts: {
  readonly child: Bun.Subprocess;
  readonly stdout: string;
  readonly stderr: string | undefined;
}): Promise<void> {
  const deadline = Date.now() + 90_000;
  let ready = false;
  let output = "";
  while (Date.now() < deadline && opts.child.exitCode === null) {
    output =
      (await Bun.file(opts.stdout).text()) +
      (opts.stderr ? await Bun.file(opts.stderr).text() : "");
    if ((output.match(/foreground-ready/g) ?? []).length >= 2) {
      ready = true;
      break;
    }
    await Bun.sleep(100);
  }
  expect({
    that: ready,
    message: `both services must emit logs before Ctrl-C: ${output}`,
  });
}
