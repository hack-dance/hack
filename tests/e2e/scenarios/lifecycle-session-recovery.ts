import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveExecutableCapability } from "../capabilities.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  buildCliEnv,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";

const SESSION_WAIT_TIMEOUT_MS = 10_000;

export const lifecycleSessionRecoveryScenario: Scenario = {
  name: "lifecycle-session-recovery",
  tier: "local",
  summary: "owned lifecycle sessions reconcile and clean up without Docker",
  run: async (ctx) => {
    const tmux = resolveExecutableCapability({
      executable: "tmux",
      executablePath: Bun.which("tmux"),
      required: process.env.HACK_E2E_REQUIRE_TMUX === "1",
      installHint: "install tmux to run lifecycle recovery E2E",
    });
    if (tmux.kind === "skip") {
      ctx.skip(tmux.reason);
    }
    if (tmux.kind === "fail") {
      throw new Error(tmux.reason);
    }
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: {
        persistentProcess: true,
        disableInternal: true,
      },
    });
    const fakeBin = join(ctx.tempRoot, "fake-bin");
    await writeFakeDocker({ fakeBin });
    const path = `${fakeBin}:${process.env.PATH ?? ""}`;
    const dockerLog = join(ctx.tempRoot, "fake-docker.log");
    const cliEnv = { PATH: path, E2E_DOCKER_LOG: dockerLog };
    const sessionName = `${fixture.name}--lifecycle`;
    const statePath = join(
      fixture.hackDir,
      ".internal",
      "lifecycle",
      "state.json"
    );

    try {
      const firstUp = await ctx.cli({
        args: ["up", "--detach", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: firstUp,
        codes: [0],
        message: "local lifecycle fixture should start",
      });
      const firstToken = (await readState({ statePath })).entries[0]
        ?.ownershipToken;
      expect({
        that: Boolean(firstToken),
        message: "lifecycle startup did not persist ownership metadata",
        result: firstUp,
      });

      const repeatedUp = await ctx.cli({
        args: ["up", "--detach", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: repeatedUp,
        codes: [0],
        message: "a repeated up should adopt the healthy owned session",
      });
      expect({
        that:
          (await readState({ statePath })).entries[0]?.ownershipToken ===
          firstToken,
        message: "healthy adoption replaced the owner token",
        result: repeatedUp,
      });

      await writeEnvOverlay({
        hackDir: fixture.hackDir,
        envName: "qa",
        value: "qa-first",
      });
      const qaUp = await ctx.cli({
        args: ["up", "--detach", "--json", "--env", "qa"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: qaUp,
        codes: [0],
        message: "switching lifecycle overlays should succeed",
      });
      const qaToken = (await readState({ statePath })).entries[0]
        ?.ownershipToken;
      expect({
        that: Boolean(qaToken) && qaToken !== firstToken,
        message:
          "switching overlays adopted lifecycle helpers from the old environment",
        result: qaUp,
      });
      await expectSessionEnvironment({
        sessionName,
        cwd: fixture.root,
        key: "E2E_PLAIN",
        value: "qa-first",
      });

      await writeEnvOverlay({
        hackDir: fixture.hackDir,
        envName: "qa",
        value: "qa-second",
      });
      const changedValueUp = await ctx.cli({
        args: ["up", "--detach", "--json", "--env", "qa"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: changedValueUp,
        codes: [0],
        message: "changing lifecycle env values should succeed",
      });
      const changedValueToken = (await readState({ statePath })).entries[0]
        ?.ownershipToken;
      expect({
        that: Boolean(changedValueToken) && changedValueToken !== qaToken,
        message:
          "changed env values adopted lifecycle helpers from the old environment",
        result: changedValueUp,
      });
      await expectSessionEnvironment({
        sessionName,
        cwd: fixture.root,
        key: "E2E_PLAIN",
        value: "qa-second",
      });

      const branchName = "feat-msp-human-handoff";
      const branchUp = await ctx.cli({
        args: ["up", "--detach", "--json", "--branch", branchName],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: branchUp,
        codes: [0],
        message: "explicit branch fixture should start",
      });
      const branchComposeProject = `${fixture.name}--${branchName}`;
      const branchToken = (await readState({ statePath })).entries.find(
        (entry) => entry.composeProject === branchComposeProject
      )?.ownershipToken;
      expect({
        that: Boolean(branchToken),
        message: "branch lifecycle entry should have an ownership token",
        result: branchUp,
      });

      await Bun.write(dockerLog, "");
      const baseRestart = await ctx.cli({
        args: ["restart", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: baseRestart,
        codes: [0],
        message: "primary checkout restart should succeed",
      });
      const restartCalls = (await Bun.file(dockerLog).text())
        .split("\n")
        .filter((line) => line.length > 0);
      expect({
        that:
          restartCalls.length >= 3 &&
          restartCalls.every(
            (line) =>
              !(
                line.includes(`-p ${branchComposeProject}`) ||
                line.includes(branchName)
              )
          ),
        message: `primary restart routed to a branch compose project:\n${restartCalls.join("\n")}`,
        result: baseRestart,
      });
      const branchSession = await runCommand({
        argv: [
          "tmux",
          "has-session",
          "-t",
          `${fixture.name}--lifecycle-${branchName}`,
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: branchSession,
        codes: [0],
        message: "primary restart stopped the running branch lifecycle session",
      });
      expect({
        that:
          (await readState({ statePath })).entries.find(
            (entry) => entry.composeProject === branchComposeProject
          )?.ownershipToken === branchToken,
        message: "primary restart replaced the branch lifecycle owner",
        result: baseRestart,
      });

      const down = await ctx.cli({
        args: ["down", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: down,
        codes: [0],
        message: "down should stop the owned lifecycle session",
      });
      await expectSessionAbsent({
        sessionName,
        cwd: fixture.root,
        phase: "base down",
      });
      const branchDown = await ctx.cli({
        args: ["down", "--json", "--branch", branchName],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: branchDown,
        codes: [0],
        message: "explicit branch down should clean its lifecycle session",
      });

      const foreignSession = await runCommand({
        argv: [
          "tmux",
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          fixture.root,
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: foreignSession,
        codes: [0],
        message: "failed to create isolated foreign collision session",
      });
      const collidedUp = await ctx.cli({
        args: ["up", "--detach", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expect({
        that:
          collidedUp.exitCode !== 0 &&
          collidedUp.combined.includes("ownership proof"),
        message: "same-name foreign session should block destructive recovery",
        result: collidedUp,
      });
      const foreignStillPresent = await runCommand({
        argv: ["tmux", "has-session", "-t", sessionName],
        cwd: fixture.root,
      });
      expectExit({
        result: foreignStillPresent,
        codes: [0],
        message: "foreign collision session was destroyed",
      });
      await runCommand({
        argv: ["tmux", "kill-session", "-t", sessionName],
        cwd: fixture.root,
      });

      const failedUp = await ctx.cli({
        args: ["up", "--detach", "--json"],
        cwd: fixture.root,
        env: { ...cliEnv, E2E_DOCKER_FAIL_UP: "1" },
      });
      expect({
        that: failedUp.exitCode !== 0,
        message: "fake compose failure should propagate",
        result: failedUp,
      });
      await expectSessionAbsent({
        sessionName,
        cwd: fixture.root,
        phase: "compose failure",
      });
      expect({
        that: (await readState({ statePath })).entries.length === 0,
        message: "compose failure left lifecycle state behind",
        result: failedUp,
      });

      const signalResult = await runSignalProbe({
        cwd: fixture.root,
        hackHome: ctx.hackHome,
        path,
        sessionName,
      });
      expect({
        that: signalResult.exitCode === 143,
        message: `signaled up should exit 143, got ${signalResult.exitCode}\n${signalResult.stderr}`,
      });
      await expectSessionAbsent({
        sessionName,
        cwd: fixture.root,
        phase: "SIGTERM",
      });
      expect({
        that: (await readState({ statePath })).entries.length === 0,
        message: "SIGTERM left lifecycle state behind",
      });

      const downFailureFixture = await createMonorepoFixture({
        parentDir: ctx.tempRoot,
        withHackConfig: true,
        lifecycle: {
          persistentProcess: true,
          disableInternal: true,
          downBeforeFailure: true,
        },
      });
      const downFailureSession = `${downFailureFixture.name}--lifecycle`;
      const downFailureStatePath = join(
        downFailureFixture.hackDir,
        ".internal",
        "lifecycle",
        "state.json"
      );
      try {
        const downFailureUp = await ctx.cli({
          args: ["up", "--detach", "--json"],
          cwd: downFailureFixture.root,
          env: cliEnv,
        });
        expectExit({
          result: downFailureUp,
          codes: [0],
          message: "down-failure fixture should start",
        });
        const downFailureToken = (
          await readState({ statePath: downFailureStatePath })
        ).entries[0]?.ownershipToken;
        expect({
          that: Boolean(downFailureToken),
          message: "down-failure fixture did not persist lifecycle ownership",
          result: downFailureUp,
        });
        await Bun.write(dockerLog, "");
        const failedDown = await ctx.cli({
          args: ["down", "--json"],
          cwd: downFailureFixture.root,
          env: cliEnv,
        });
        expect({
          that:
            failedDown.exitCode !== 0 &&
            failedDown.combined.includes("E_LIFECYCLE_FAILED"),
          message: "down.before failure should propagate",
          result: failedDown,
        });
        await expectSessionPresent({
          sessionName: downFailureSession,
          cwd: downFailureFixture.root,
          phase: "down.before failure",
        });
        expect({
          that:
            (await readState({ statePath: downFailureStatePath })).entries[0]
              ?.ownershipToken === downFailureToken,
          message: "down.before failure removed lifecycle ownership state",
          result: failedDown,
        });
        expect({
          that: !(await Bun.file(dockerLog).text()).includes(" down"),
          message: "down.before failure still invoked compose down",
          result: failedDown,
        });

        await Bun.write(dockerLog, "");
        const failedRestart = await ctx.cli({
          args: ["restart", "--json"],
          cwd: downFailureFixture.root,
          env: cliEnv,
        });
        expect({
          that:
            failedRestart.exitCode !== 0 &&
            failedRestart.combined.includes("Restart down phase failed"),
          message: "restart down.before failure should propagate",
          result: failedRestart,
        });
        await expectSessionPresent({
          sessionName: downFailureSession,
          cwd: downFailureFixture.root,
          phase: "restart down.before failure",
        });
        expect({
          that:
            (await readState({ statePath: downFailureStatePath })).entries[0]
              ?.ownershipToken === downFailureToken,
          message:
            "restart down.before failure removed lifecycle ownership state",
          result: failedRestart,
        });
        expect({
          that: !(await Bun.file(dockerLog).text()).includes(" down"),
          message: "restart down.before failure still invoked compose down",
          result: failedRestart,
        });
      } finally {
        await runCommand({
          argv: ["tmux", "kill-session", "-t", downFailureSession],
          cwd: downFailureFixture.root,
        });
      }

      const doctorFixture = await createMonorepoFixture({
        parentDir: ctx.tempRoot,
        withHackConfig: true,
        lifecycle: {
          persistentProcess: true,
          disableInternal: true,
        },
      });
      const doctorSession = `${doctorFixture.name}--lifecycle`;
      const doctorStatePath = join(
        doctorFixture.hackDir,
        ".internal",
        "lifecycle",
        "state.json"
      );
      try {
        const doctorUp = await ctx.cli({
          args: ["up", "--detach", "--json"],
          cwd: doctorFixture.root,
          env: cliEnv,
        });
        expectExit({
          result: doctorUp,
          codes: [0],
          message: "doctor orphan fixture should start its lifecycle session",
        });
        await ageLifecycleState({ statePath: doctorStatePath });
        const doctor = await ctx.cli({
          args: ["doctor"],
          cwd: doctorFixture.root,
          env: cliEnv,
          timeoutMs: 240_000,
        });
        expect({
          that:
            !doctor.timedOut &&
            doctor.combined.includes("owned lifecycle session") &&
            doctor.combined.includes("hack doctor --fix"),
          message: "doctor did not report the ownership-proven orphan session",
          result: doctor,
        });
        const doctorFix = await ctx.cli({
          args: ["doctor", "--fix"],
          cwd: doctorFixture.root,
          env: cliEnv,
          timeoutMs: 240_000,
        });
        expect({
          that:
            !doctorFix.timedOut &&
            (doctorFix.exitCode === 0 || doctorFix.exitCode === 1) &&
            doctorFix.combined.includes("lifecycle repair"),
          message: "doctor --fix did not run lifecycle repair",
          result: doctorFix,
        });
        await expectSessionAbsent({
          sessionName: doctorSession,
          cwd: doctorFixture.root,
          phase: "doctor --fix",
        });
        expect({
          that:
            (await readState({ statePath: doctorStatePath })).entries.length ===
            0,
          message: "doctor --fix left lifecycle ownership state behind",
          result: doctorFix,
        });
      } finally {
        await runCommand({
          argv: ["tmux", "kill-session", "-t", doctorSession],
          cwd: doctorFixture.root,
        });
      }
    } finally {
      await runCommand({
        argv: ["tmux", "kill-session", "-t", sessionName],
        cwd: fixture.root,
      });
    }
  },
};

async function writeFakeDocker(opts: {
  readonly fakeBin: string;
}): Promise<void> {
  await mkdir(opts.fakeBin, { recursive: true });
  const path = join(opts.fakeBin, "docker");
  await Bun.write(
    path,
    [
      "#!/bin/sh",
      'if [ -n "${E2E_DOCKER_LOG:-}" ]; then printf "%s\\n" "$*" >> "$E2E_DOCKER_LOG"; fi',
      'if [ "$1" = "compose" ]; then',
      '  case " $* " in',
      '    *" up "*)',
      '      if [ "${E2E_DOCKER_BLOCK_UP:-}" = "1" ]; then',
      '        parent_pid="$PPID"',
      '        while kill -0 "$parent_pid" 2>/dev/null; do sleep 0.1; done',
      "        exit 143",
      "      fi",
      '      if [ "${E2E_DOCKER_FAIL_UP:-}" = "1" ]; then exit 42; fi',
      "      exit 0",
      "      ;;",
      "    *) exit 0 ;;",
      "  esac",
      "fi",
      'if [ "$1" = "info" ]; then exit 0; fi',
      'if [ "$1" = "ps" ]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n")
  );
  await chmod(path, 0o755);
}

async function writeEnvOverlay(opts: {
  readonly hackDir: string;
  readonly envName: string;
  readonly value: string;
}): Promise<void> {
  await Bun.write(
    join(opts.hackDir, `hack.env.${opts.envName}.yaml`),
    [
      "version: 1",
      `environment: ${opts.envName}`,
      "secretsprovider: project_key",
      "values:",
      "  global:",
      `    E2E_PLAIN: ${opts.value}`,
      "",
    ].join("\n")
  );
}

async function expectSessionEnvironment(opts: {
  readonly sessionName: string;
  readonly cwd: string;
  readonly key: string;
  readonly value: string;
}): Promise<void> {
  const result = await runCommand({
    argv: ["tmux", "show-environment", "-t", opts.sessionName, opts.key],
    cwd: opts.cwd,
  });
  expect({
    that:
      result.exitCode === 0 &&
      result.stdout.trim() === `${opts.key}=${opts.value}`,
    message: `lifecycle session did not receive ${opts.key}=${opts.value}`,
    result,
  });
}

async function ageLifecycleState(opts: {
  readonly statePath: string;
}): Promise<void> {
  const state = await readState({ statePath: opts.statePath });
  await Bun.write(
    opts.statePath,
    `${JSON.stringify(
      {
        entries: state.entries.map((entry) => ({
          ...entry,
          updatedAt: "2020-01-01T00:00:00.000Z",
        })),
      },
      null,
      2
    )}\n`
  );
}

async function runSignalProbe(opts: {
  readonly cwd: string;
  readonly hackHome: string;
  readonly path: string;
  readonly sessionName: string;
}): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  const proc = Bun.spawn(resolveCliSpawnArgs(["up", "--detach", "--json"]), {
    cwd: opts.cwd,
    env: buildCliEnv({
      hackHome: opts.hackHome,
      extra: {
        PATH: opts.path,
        E2E_DOCKER_BLOCK_UP: "1",
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const sessionReady = await waitForSession({
    sessionName: opts.sessionName,
    cwd: opts.cwd,
  });
  if (!sessionReady) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error("timed out waiting for lifecycle session before SIGTERM");
  }
  proc.kill("SIGTERM");
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
}

async function waitForSession(opts: {
  readonly sessionName: string;
  readonly cwd: string;
}): Promise<boolean> {
  const deadline = Date.now() + SESSION_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const presence = await inspectSessionPresence(opts);
    if (presence.present) {
      return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

async function expectSessionAbsent(opts: {
  readonly sessionName: string;
  readonly cwd: string;
  readonly phase: string;
}): Promise<void> {
  const deadline = Date.now() + SESSION_WAIT_TIMEOUT_MS;
  let presence = await inspectSessionPresence(opts);
  while (presence.present && Date.now() < deadline) {
    await Bun.sleep(100);
    presence = await inspectSessionPresence(opts);
  }
  expect({
    that: !presence.present,
    message: `${opts.phase}: lifecycle session ${opts.sessionName} is still present`,
    result: presence.result,
  });
}

async function expectSessionPresent(opts: {
  readonly sessionName: string;
  readonly cwd: string;
  readonly phase: string;
}): Promise<void> {
  const presence = await inspectSessionPresence(opts);
  expect({
    that: presence.present,
    message: `${opts.phase}: lifecycle session ${opts.sessionName} is absent`,
    result: presence.result,
  });
}

async function inspectSessionPresence(opts: {
  readonly sessionName: string;
  readonly cwd: string;
}): Promise<{
  readonly present: boolean;
  readonly result: Awaited<ReturnType<typeof runCommand>>;
}> {
  const result = await runCommand({
    argv: ["tmux", "list-sessions", "-F", "#{session_name}"],
    cwd: opts.cwd,
  });
  return {
    present: result.stdout
      .split("\n")
      .some((name) => name.trim() === opts.sessionName),
    result,
  };
}

type LifecycleState = {
  readonly entries: ReadonlyArray<{
    readonly composeProject: string;
    readonly ownershipToken?: string;
  }>;
};

async function readState(opts: {
  readonly statePath: string;
}): Promise<LifecycleState> {
  const file = Bun.file(opts.statePath);
  if (!(await file.exists())) {
    return { entries: [] };
  }
  return (await file.json()) as LifecycleState;
}
