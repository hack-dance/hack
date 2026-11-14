import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { restoreEnv } from "../../helpers/env.ts";

import { resolveExecutableCapability } from "../capabilities.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  buildCliEnv,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";

const SESSION_WAIT_TIMEOUT_MS = 10_000;

export const lifecycleSessionRecoveryScenario: Scenario = {
  name: "lifecycle-session-recovery",
  tier: "local",
  summary: "owned lifecycle sessions reconcile and clean up without Docker",
  run: async (ctx) => {
    if (process.env.HACK_LIFECYCLE_RUNNER === "supervisor") {
      await runSupervisorRecovery({ ctx });
      return;
    }
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
    const previousTmuxRoot = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = ctx.tempRoot;
    const cliEnv = {
      PATH: path,
      E2E_DOCKER_LOG: dockerLog,
      TMUX_TMPDIR: ctx.tempRoot,
    };
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

      const branchName = "feat-sample-handoff";
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
          restartCalls.length >= 2 &&
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

      const hardKillResult = await runSignalProbe({
        cwd: fixture.root,
        hackHome: ctx.hackHome,
        path,
        sessionName,
        signal: "SIGKILL",
      });
      expect({
        that: hardKillResult.exitCode === 137,
        message: `SIGKILLed up should exit 137, got ${hardKillResult.exitCode}\n${hardKillResult.stderr}`,
      });
      expect({
        that: Boolean(
          (await readState({ statePath })).entries[0]?.ownershipToken
        ),
        message:
          "SIGKILL between lifecycle startup and Compose lost ownership state",
      });
      const recoveredAfterHardKill = await ctx.cli({
        args: ["up", "--detach", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: recoveredAfterHardKill,
        codes: [0],
        message:
          "up should adopt or replace an ownership-proven lifecycle session after SIGKILL",
      });
      const downAfterHardKill = await ctx.cli({
        args: ["down", "--json"],
        cwd: fixture.root,
        env: cliEnv,
      });
      expectExit({
        result: downAfterHardKill,
        codes: [0],
        message: "down should clean the recovered SIGKILL lifecycle session",
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

      await runNonUtf8LocaleCycle({ ctx, cliEnv });

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
      // This server is scoped to the scenario's private TMUX_TMPDIR; remove
      // branch sessions too if an earlier assertion interrupted their cleanup.
      await runCommand({ argv: ["tmux", "kill-server"], cwd: fixture.root });
      restoreEnv("TMUX_TMPDIR", previousTmuxRoot);
    }
  },
};

/** The supervisor path needs no mux. Exercise the same public CLI ownership,
 * overlays, branches, restart, rollback and doctor boundaries with native state. */
async function runSupervisorRecovery(opts: {
  readonly ctx: ScenarioContext;
}): Promise<void> {
  const { ctx } = opts;
  const binary =
    process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY ??
    resolve(
      ctx.repoRoot,
      ".hack-local/target/lifecycle-integration/debug/hack-lifecycle-supervisor"
    );
  expect({
    that: binary.startsWith("/") && (await Bun.file(binary).exists()),
    message:
      "supervisor recovery requires a built current-source supervisor executable",
  });
  const fakeBin = join(ctx.tempRoot, "fake-supervisor-bin");
  await writeFakeDocker({ fakeBin });
  const cliEnv = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    HACK_LIFECYCLE_RUNNER: "supervisor",
    HACK_LIFECYCLE_SUPERVISOR_BINARY: binary,
  };
  const fixture = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: true,
    lifecycle: {
      persistentUpBefore: true,
      persistentProcess: true,
      disableInternal: true,
      persistentUpBeforeCommand:
        'bun -e \'console.log("supervisor-ready " + process.env.E2E_PLAIN); let n=0; setInterval(() => console.log("supervisor-tick " + ++n), 100)\'',
    },
  });
  const statePath = join(fixture.hackDir, ".internal/lifecycle/state.json");
  const cli = (
    args: readonly string[],
    env: Readonly<Record<string, string>> = cliEnv
  ) => ctx.cli({ args, cwd: fixture.root, env });
  const assertOk = (result: Awaited<ReturnType<typeof cli>>, message: string) =>
    expectExit({ result, codes: [0], message });
  const readEntry = async (project = fixture.name) =>
    (await readState({ statePath })).entries.find(
      (entry) => entry.composeProject === project
    );
  const branches = ["feat-supervisor-handoff"];
  try {
    const originalCli = process.env.HACK_E2E_CLI_BIN;
    const missingBinary = join(ctx.tempRoot, "missing-supervisor");
    if (originalCli) {
      const isolatedInstall = join(ctx.tempRoot, "cli-without-companion");
      await mkdir(isolatedInstall);
      const isolatedCli = join(isolatedInstall, "hack");
      await copyFile(originalCli, isolatedCli);
      await chmod(isolatedCli, 0o700);
      process.env.HACK_E2E_CLI_BIN = isolatedCli;
    }
    try {
      expectExit({
        result: await cli(["up", "--detach", "--json"], {
          ...cliEnv,
          HACK_LIFECYCLE_SUPERVISOR_BINARY: originalCli
            ? binary
            : missingBinary,
        }),
        codes: [1],
        message:
          "missing companion must fail before ownership even with a production override",
      });
      expect({
        that: !(await readEntry()),
        message: "failed preflight published ownership",
      });
      assertOk(
        await cli(["down", "--json"]),
        "missing companion must not wedge down before any launch"
      );
    } finally {
      restoreEnv("HACK_E2E_CLI_BIN", originalCli);
    }
    assertOk(
      await cli(["up", "--detach", "--json"]),
      "supervisor up should start persistent hook and process"
    );
    const initial = await readEntry();
    expect({
      that:
        initial?.backend === "supervisor" &&
        Boolean(initial.ownershipToken) &&
        initial.processes?.length === 2,
      message:
        "supervisor state must persist both ordered commands and ownership",
    });
    assertOk(
      await cli(["up", "--detach", "--json"]),
      "supervisor repeated up should adopt"
    );
    expect({
      that: (await readEntry())?.ownershipToken === initial?.ownershipToken,
      message: "supervisor adoption replaced healthy ownership",
    });
    const logPath = join(
      fixture.hackDir,
      ".internal/lifecycle",
      `${fixture.name}.log`
    );
    await waitForText({ path: logPath, text: "supervisor-ready host-value" });
    const logs = await cli(["logs", "e2e-tunnel", "--no-follow"]);
    assertOk(logs, "supervisor logs should read the common private log");
    expect({
      that: logs.combined.includes("supervisor-ready host-value"),
      message: "supervisor output did not reach hack logs",
      result: logs,
    });
    await expectSupervisorLogFollow({
      ctx,
      cwd: fixture.root,
      env: cliEnv,
      logPath,
    });
    await writeEnvOverlay({
      hackDir: fixture.hackDir,
      envName: "qa",
      value: "qa-first",
    });
    assertOk(
      await cli(["up", "--detach", "--json", "--env", "qa"]),
      "supervisor overlay replacement should succeed"
    );
    expect({
      that: (await readEntry())?.ownershipToken !== initial?.ownershipToken,
      message: "supervisor overlay change reused old command environment",
    });
    await waitForText({ path: logPath, text: "supervisor-ready qa-first" });
    const branch = branches[0] ?? "feat-supervisor-handoff";
    assertOk(
      await cli(["up", "--detach", "--json", "--branch", branch]),
      "supervisor branch should start"
    );
    const branchProject = `${fixture.name}--${branch}`;
    const branchToken = (await readEntry(branchProject))?.ownershipToken;
    assertOk(
      await cli(["restart", "--json"]),
      "supervisor restart should succeed"
    );
    expect({
      that: (await readEntry(branchProject))?.ownershipToken === branchToken,
      message: "primary supervisor restart changed branch ownership",
    });
    const beforeKill = await readEntry();
    const owner = beforeKill?.supervisorPid;
    expect({
      that: Number.isInteger(owner) && (owner ?? 0) > 1,
      message: "supervisor owner PID was not recorded",
    });
    if (owner && owner > 1) {
      // This PID is read immediately from the fixture's own current launch receipt.
      process.kill(owner, "SIGKILL");
    }
    await Bun.sleep(150);
    assertOk(
      await cli(["down", "--json"]),
      "down must recover native groups after project supervisor SIGKILL"
    );
    expect({
      that: !(await readEntry()),
      message: "recovery down retained confirmed-stopped supervisor entry",
    });
    assertOk(
      await cli(["down", "--json", "--branch", branch]),
      "branch supervisor down should succeed"
    );
    const failedUp = await cli(["up", "--detach", "--json"], {
      ...cliEnv,
      E2E_DOCKER_FAIL_UP: "1",
    });
    expect({
      that: failedUp.exitCode !== 0 && !failedUp.timedOut,
      message: "compose failure must propagate under supervisor",
      result: failedUp,
    });
    expect({
      that: !(await readEntry()),
      message:
        "compose failure retained confirmed-stopped supervisor ownership",
    });
    assertOk(
      await cli(["up", "--detach", "--json"]),
      "supervisor doctor fixture should start"
    );
    await ageLifecycleState({ statePath });
    const doctor = await cli(["doctor"]);
    expect({
      that:
        doctor.combined.includes("owned lifecycle session") &&
        doctor.combined.includes("hack doctor --fix"),
      message: "doctor did not classify native ownership-proven orphan",
      result: doctor,
    });
    const fixed = await cli(["doctor", "--fix"]);
    expect({
      that: !fixed.timedOut && fixed.combined.includes("lifecycle repair"),
      message: "doctor fix did not inspect supervisor retirement",
      result: fixed,
    });
    expect({
      that: !(await readEntry()),
      message: "doctor repair did not retire native ownership",
    });
  } finally {
    const cleanup = [await cli(["down", "--json"])];
    for (const branch of branches) {
      cleanup.push(await cli(["down", "--json", "--branch", branch]));
    }
    if (
      cleanup.some((result) => result.exitCode !== 0 || result.timedOut) ||
      (await readState({ statePath })).entries.length > 0
    ) {
      ctx.retainFixtures(
        "Supervisor recovery cleanup was not confirmed; retained private ownership evidence."
      );
    }
  }
}

async function expectSupervisorLogFollow(opts: {
  readonly ctx: ScenarioContext;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logPath: string;
}): Promise<void> {
  const previous = Math.max(
    0,
    ...[
      ...(await Bun.file(opts.logPath).text()).matchAll(
        /supervisor-tick (\d+)/g
      ),
    ].map((match) => Number(match[1]))
  );
  const follower = Bun.spawn(
    resolveCliSpawnArgs(["logs", "-f", "e2e-tunnel"]),
    {
      cwd: opts.cwd,
      env: buildCliEnv({ hackHome: opts.ctx.hackHome, extra: opts.env }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stderr = new Response(follower.stderr).text();
  const reader = follower.stdout.getReader();
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (
          ![...text.matchAll(/supervisor-tick (\d+)/g)].some(
            (match) => Number(match[1]) > previous
          )
        ) {
          const result = await reader.read();
          if (result.done) {
            throw new Error("supervisor log follower ended before output");
          }
          text = (text + new TextDecoder().decode(result.value)).slice(-4096);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("supervisor log follower timed out")),
          SESSION_WAIT_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    follower.kill("SIGINT");
    await follower.exited;
    await reader.cancel();
    await stderr;
  }
}

async function waitForText(opts: {
  readonly path: string;
  readonly text: string;
}): Promise<void> {
  const deadline = Date.now() + SESSION_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const file = Bun.file(opts.path);
    if ((await file.exists()) && (await file.text()).includes(opts.text)) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    "native lifecycle output did not reach the private log before deadline"
  );
}

/**
 * HACK-1797: without a UTF-8 locale tmux rewrote the session listing's tab
 * separators, so `down` missed the owned session (leaving it and its tunnel
 * running) and the next `up` failed with "Failed to create lifecycle
 * session". Drive up -> up (live) -> down -> up -> down under LC_ALL=C.
 */
async function runNonUtf8LocaleCycle(opts: {
  readonly ctx: ScenarioContext;
  readonly cliEnv: Readonly<Record<string, string>>;
}): Promise<void> {
  const fixture = await createMonorepoFixture({
    parentDir: opts.ctx.tempRoot,
    withHackConfig: true,
    lifecycle: {
      persistentUpBefore: true,
      persistentProcess: true,
      disableInternal: true,
    },
  });
  const sessionName = `${fixture.name}--lifecycle`;
  const statePath = join(
    fixture.hackDir,
    ".internal",
    "lifecycle",
    "state.json"
  );
  const env = { ...opts.cliEnv, LC_ALL: "C", LANG: "C" };
  const up = async (phase: string) => {
    const result = await opts.ctx.cli({
      args: ["up", "--detach", "--json"],
      cwd: fixture.root,
      env,
    });
    expectExit({
      result,
      codes: [0],
      message: `non-UTF-8 locale: ${phase} should start or adopt the lifecycle session`,
    });
    await expectSessionPresent({ sessionName, cwd: fixture.root, phase });
    return result;
  };
  const down = async (phase: string) => {
    const groups = (await readState({ statePath })).entries.flatMap((entry) =>
      (entry.processes ?? []).flatMap((process) =>
        process.processGroupId ? [process.processGroupId] : []
      )
    );
    expect({
      that: groups.length === 2,
      message: `non-UTF-8 locale: ${phase} expected two recorded lifecycle process groups, got ${groups.length}`,
    });
    const result = await opts.ctx.cli({
      args: ["down", "--json"],
      cwd: fixture.root,
      env,
    });
    expectExit({
      result,
      codes: [0],
      message: `non-UTF-8 locale: ${phase} should stop the lifecycle session`,
    });
    await expectSessionAbsent({ sessionName, cwd: fixture.root, phase });
    expect({
      that: (await readState({ statePath })).entries.length === 0,
      message: `non-UTF-8 locale: ${phase} left lifecycle state behind`,
      result,
    });
    const survivors = groups.filter(isProcessGroupAlive);
    expect({
      that: survivors.length === 0,
      message: `non-UTF-8 locale: ${phase} left lifecycle process groups running: ${survivors.join(", ")}`,
      result,
    });
  };

  try {
    const first = await up("first up");
    const firstToken = (await readState({ statePath })).entries[0]
      ?.ownershipToken;
    expect({
      that: Boolean(firstToken),
      message: "non-UTF-8 locale: first up did not persist lifecycle ownership",
      result: first,
    });
    const live = await up("up over a live session");
    expect({
      that:
        (await readState({ statePath })).entries[0]?.ownershipToken ===
        firstToken,
      message:
        "non-UTF-8 locale: up over a live owned session did not adopt it",
      result: live,
    });
    await down("first down");
    await up("up after down");
    await down("second down");
  } finally {
    await runCommand({
      argv: ["tmux", "kill-session", "-t", `=${sessionName}`],
      cwd: fixture.root,
    });
  }
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeFakeDocker(opts: {
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
      '    *" ps "*)',
      // A failed up started nothing, unless it failed after starting some
      // services (E2E_DOCKER_FAIL_UP_PARTIAL).
      '      if [ "${E2E_DOCKER_FAIL_UP:-}" = "1" ]; then exit 0; fi',
      '      printf \'%s\\n\' \'{"ID":"fixture-api","Service":"api","State":"running","ExitCode":0}\'',
      "      exit 0",
      "      ;;",
      '    *" up "*)',
      // Optional gate: the image phase (`up --no-start`) records that it was
      // reached, then waits until the gate file exists.
      '      if [ -n "${E2E_DOCKER_GATE_UP:-}" ]; then',
      '        case " $* " in *" --no-start "*)',
      '          : > "${E2E_DOCKER_GATE_UP}.reached"',
      '          while [ ! -e "$E2E_DOCKER_GATE_UP" ]; do sleep 0.05; done',
      "          ;;",
      "        esac",
      "      fi",
      '      if [ "${E2E_DOCKER_BLOCK_UP:-}" = "1" ]; then',
      '        parent_pid="$PPID"',
      '        while kill -0 "$parent_pid" 2>/dev/null; do sleep 0.1; done',
      "        exit 143",
      "      fi",
      '      if [ "${E2E_DOCKER_FAIL_UP:-}" = "1" ]; then exit 42; fi',
      '      if [ "${E2E_DOCKER_FAIL_UP_PARTIAL:-}" = "1" ]; then exit 42; fi',
      "      exit 0",
      "      ;;",
      "    *) exit 0 ;;",
      "  esac",
      "fi",
      'if [ "$1" = "info" ]; then exit 0; fi',
      // Plain `docker ps` (the label listing behind hack down's helper
      // release): empty unless a surviving orphan or a failure is injected.
      'if [ "$1" = "ps" ]; then',
      '  if [ "${E2E_DOCKER_PS_FAIL:-}" = "1" ]; then exit 1; fi',
      '  if [ -n "${E2E_DOCKER_PS_ORPHAN:-}" ]; then printf \'{"name":"%s","state":"running"}\\n\' "$E2E_DOCKER_PS_ORPHAN"; fi',
      "  exit 0",
      "fi",
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
  readonly signal?: "SIGTERM" | "SIGKILL";
}): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  const proc = Bun.spawn(resolveCliSpawnArgs(["up", "--detach", "--json"]), {
    cwd: opts.cwd,
    env: buildCliEnv({
      hackHome: opts.hackHome,
      extra: {
        PATH: opts.path,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR ?? "",
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
  proc.kill(opts.signal ?? "SIGTERM");
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
    readonly backend?: string;
    readonly supervisorPid?: number;
    readonly ownershipToken?: string;
    readonly processes?: ReadonlyArray<{
      readonly processGroupId?: number;
    }>;
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
