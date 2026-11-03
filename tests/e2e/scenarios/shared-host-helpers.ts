import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readProcessIdentities } from "../../../src/lib/process-tree.ts";
import { withProjectsRegistryLock } from "../../../src/lib/projects-registry-lock.ts";
import {
  isSharedHostProcessRunning,
  parseSharedHostClaim,
} from "../../../src/lib/shared-host-lifecycle.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  buildCliEnv,
  CLI_ENTRYPOINT,
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  type Scenario,
} from "../harness.ts";
import { writeFakeDocker } from "./lifecycle-session-recovery.ts";

/**
 * Two branches of one project share one `lifecycle.sharedHelpers` entry
 * through the real CLI (`hack up`/`down --branch`), with a fake Docker and
 * the portable helper fixture from tests/fixtures/shared-host-helper.ts.
 *
 * Every phase asserts actual endpoint behavior, that no foreign process is
 * signalled, and that no owned helper outlives its last holder. Foreign
 * processes are started and stopped by this scenario through its own handles.
 */

const HELPER = resolve(import.meta.dir, "../../fixtures/shared-host-helper.ts");
const HELPER_NAME = "issuer-bridge";
const UPSTREAM = "https://issuer.shared.test";
const OTHER_UPSTREAM = "https://issuer.sibling.test";
const WAIT_MS = 15_000;
const SIGNAL_EXIT_BOUND_MS = 5000;

type Identity = { readonly pid: number; readonly birth: string };
type HelperMode = "identity" | "placeholder";

export const sharedHostHelpersScenario: Scenario = {
  name: "shared-host-helpers",
  tier: "local",
  summary:
    "two branches share an identity-verified host helper through up/down without Docker",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const fakeBin = join(ctx.tempRoot, "fake-bin");
    await writeFakeDocker({ fakeBin });
    const path = `${fakeBin}:${process.env.PATH ?? ""}`;
    const port = freePort();
    const configPath = join(fixture.hackDir, "hack.config.json");
    const baseConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const claimPath = join(
      ctx.hackHome,
      "shared-helpers",
      `${HELPER_NAME}-${port}`,
      `${HELPER_NAME}.claim.json`
    );
    const branchA = "feat-a";
    const branchB = "feat-b";
    const holderA = `${fixture.name}--${branchA}`;
    const holderB = `${fixture.name}--${branchB}`;
    const foreign: Bun.Subprocess[] = [];

    const writeConfig = async (opts: {
      readonly mode: HelperMode;
      readonly readyTimeoutMs?: number;
      /** Write the config with no sharedHelpers entry at all. */
      readonly withoutHelpers?: boolean;
      /** Add a long-running lifecycle process (needs tmux). */
      readonly withProcess?: boolean;
      /** Add a second entry with a shell-string command (invalid). */
      readonly withInvalidEntry?: boolean;
      /** Write the helper entry with `enabled: false`. */
      readonly disabled?: boolean;
      /** Add an up.before hook that waits for this gate file. */
      readonly beforeGate?: string;
      /** Add an up.after hook that fails. */
      readonly failUpAfter?: boolean;
    }): Promise<void> => {
      const lifecycle = {
        ...((baseConfig.lifecycle ?? {}) as Record<string, unknown>),
        ...(opts.beforeGate
          ? {
              up: {
                before: [
                  {
                    name: "e2e-before-gate",
                    command: `: > "${opts.beforeGate}.reached"; while [ ! -e "${opts.beforeGate}" ]; do sleep 0.05; done`,
                  },
                ],
              },
            }
          : {}),
        ...(opts.failUpAfter
          ? { up: { after: [{ name: "e2e-after-fails", command: "exit 3" }] } }
          : {}),
        ...(opts.withProcess
          ? {
              processes: [
                {
                  name: "e2e-helper-client",
                  command: `${process.execPath} -e "setInterval(() => undefined, 60000)"`,
                },
              ],
            }
          : {}),
      };
      const helper = {
        name: HELPER_NAME,
        // HOME is the scenario temp root: the fixture exits once it is
        // removed, so a failed run cannot leak a helper.
        command: [
          "/usr/bin/env",
          `HOME=${ctx.tempRoot}`,
          process.execPath,
          HELPER,
          opts.mode,
          String(port),
          HELPER_NAME,
          UPSTREAM,
        ],
        port,
        upstreamEnv: "E2E_ISSUER_UPSTREAM",
        readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
        ...(opts.disabled ? { enabled: false } : {}),
      };
      const sharedHelpers = opts.withInvalidEntry
        ? [helper, { ...helper, name: "second-bridge", command: "bun bridge" }]
        : [helper];
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            ...baseConfig,
            lifecycle: opts.withoutHelpers
              ? lifecycle
              : { ...lifecycle, sharedHelpers },
          },
          null,
          2
        )}\n`
      );
    };

    const cli = (opts: {
      readonly verb: "up" | "down" | "restart";
      readonly branch: string;
      readonly upstream?: string;
      readonly failCompose?: boolean;
      /** Compose fails after starting some services. */
      readonly failComposePartial?: boolean;
    }): Promise<CliResult> =>
      ctx.cli({
        args: [
          opts.verb,
          ...(opts.verb === "up" ? ["--detach"] : []),
          "--json",
          "--branch",
          opts.branch,
        ],
        cwd: fixture.root,
        env: {
          PATH: path,
          E2E_ISSUER_UPSTREAM: opts.upstream ?? UPSTREAM,
          ...(opts.failCompose ? { E2E_DOCKER_FAIL_UP: "1" } : {}),
          ...(opts.failComposePartial
            ? { E2E_DOCKER_FAIL_UP_PARTIAL: "1" }
            : {}),
        },
      });

    const readClaim = async () => {
      const text = await readFile(claimPath, "utf8").catch(() => null);
      return text === null ? null : parseSharedHostClaim(text);
    };
    const ownedHelper = async (): Promise<Identity> => {
      const claim = await readClaim();
      if (claim?.ownership !== "owned") {
        throw new Error(
          `expected an owned claim, got ${JSON.stringify(claim)}`
        );
      }
      return { pid: claim.pid, birth: claim.birth };
    };
    const startForeign = async (
      mode: "identity" | "tcp" | "placeholder"
    ): Promise<{ readonly proc: Bun.Subprocess; readonly id: Identity }> => {
      const proc = Bun.spawn(
        [process.execPath, HELPER, mode, String(port), HELPER_NAME, UPSTREAM],
        {
          env: { PATH: process.env.PATH ?? "", HOME: ctx.tempRoot },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }
      );
      foreign.push(proc);
      await waitForLine(proc.stdout, "listening");
      const id = await identityOf(proc.pid);
      if (!id) {
        throw new Error("foreign fixture missing from the census");
      }
      return { proc, id };
    };
    const stopForeign = async (proc: Bun.Subprocess): Promise<void> => {
      proc.kill("SIGKILL");
      await proc.exited;
    };

    try {
      await writeConfig({ mode: "identity" });

      ctx.log("concurrent startup: two branches, one spawn");
      const [upA, upB] = await Promise.all([
        cli({ verb: "up", branch: branchA }),
        cli({ verb: "up", branch: branchB }),
      ]);
      expectExit({ result: upA, codes: [0], message: "branch A up" });
      expectExit({ result: upB, codes: [0], message: "branch B up" });
      const shared = await ownedHelper();
      const claim = await readClaim();
      expect({
        that:
          claim?.ownership === "owned" &&
          claim.phase === "ready" &&
          [...claim.holders].sort().join(",") ===
            [holderA, holderB].sort().join(","),
        message: `both branches should hold one owned helper: ${JSON.stringify(claim)}`,
      });
      expect({
        that: (await served(port)) === `served:${UPSTREAM}`,
        message: "the shared helper endpoint should serve the upstream",
      });

      ctx.log("sibling branch with another upstream is refused");
      const sibling = await cli({
        verb: "up",
        branch: "feat-c",
        upstream: OTHER_UPSTREAM,
      });
      expect({
        that:
          sibling.exitCode !== 0 &&
          sibling.stdout.includes("E_LIFECYCLE_FAILED") &&
          sibling.combined.includes("wrong-upstream") &&
          !sibling.combined.includes(OTHER_UPSTREAM),
        message: "a wrong-upstream sibling must fail closed without the value",
        result: sibling,
      });
      expect({
        that:
          (await isRunning(shared)) &&
          (await readClaim())?.holders.length === 2,
        message: "the refused sibling changed the shared helper",
        result: sibling,
      });

      ctx.log("first down retains, last down stops");
      expectExit({
        result: await cli({ verb: "down", branch: branchA }),
        codes: [0],
        message: "branch A down",
      });
      expect({
        that:
          (await isRunning(shared)) &&
          (await served(port)) === `served:${UPSTREAM}` &&
          (await readClaim())?.holders.join(",") === holderB,
        message: "branch A down must leave the helper for branch B",
      });
      expectExit({
        result: await cli({ verb: "down", branch: branchB }),
        codes: [0],
        message: "branch B down",
      });
      expect({
        that: !(await isRunning(shared)) && (await readClaim()) === null,
        message: "the last down must stop the owned helper and drop its claim",
      });

      ctx.log("a failed up releases only the holder it added");
      expectExit({
        result: await cli({ verb: "up", branch: branchB }),
        codes: [0],
        message: "branch B up before A's failed up",
      });
      const held = await ownedHelper();
      const failedUp = await cli({
        verb: "up",
        branch: branchA,
        failCompose: true,
      });
      expect({
        that:
          failedUp.exitCode !== 0 &&
          (await isRunning(held)) &&
          (await readClaim())?.holders.join(",") === holderB,
        message: "a compose failure must roll back A's new holder, not B's",
        result: failedUp,
      });
      expectExit({
        result: await cli({ verb: "down", branch: branchB }),
        codes: [0],
        message: "branch B down after A's failed up",
      });
      expect({
        that: !(await isRunning(held)) && (await readClaim()) === null,
        message: "the last down after a failed up left the helper running",
      });

      ctx.log("child restart: a crashed owned helper is replaced");
      expectExit({
        result: await cli({ verb: "up", branch: branchA }),
        codes: [0],
        message: "branch A up before crash",
      });
      const crashed = await ownedHelper();
      process.kill(crashed.pid, "SIGKILL");
      await waitUntil(async () => !(await isRunning(crashed)));
      expectExit({
        result: await cli({ verb: "up", branch: branchA }),
        codes: [0],
        message: "branch A up after crash",
      });
      const replaced = await ownedHelper();
      expect({
        that:
          replaced.pid !== crashed.pid &&
          (await served(port)) === `served:${UPSTREAM}` &&
          (await readClaim())?.holders.join(",") === holderA,
        message: "the crashed helper should be replaced under a fresh claim",
      });
      expectExit({
        result: await cli({ verb: "down", branch: branchA }),
        codes: [0],
        message: "branch A down after restart",
      });
      expect({
        that: !(await isRunning(replaced)),
        message: "down left the replaced helper running",
      });

      ctx.log("stale PID: a reused PID is discarded and never signalled");
      const bystander = Bun.spawn(
        [process.execPath, HELPER, "placeholder", "0", "-", "-"],
        {
          env: { PATH: process.env.PATH ?? "", HOME: ctx.tempRoot },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      foreign.push(bystander);
      await waitUntil(async () => (await identityOf(bystander.pid)) !== null);
      await writeFile(
        claimPath,
        `${JSON.stringify({
          version: 1,
          helper: HELPER_NAME,
          port,
          ownership: "owned",
          phase: "ready",
          pid: bystander.pid,
          birth: "Thu Jan  1 00:00:00 1970",
          holders: [holderB],
        })}\n`,
        { mode: 0o600 }
      );
      const bystanderId = await identityOf(bystander.pid);
      expectExit({
        result: await cli({ verb: "up", branch: branchA }),
        codes: [0],
        message: "up over a stale claim",
      });
      const fresh = await ownedHelper();
      expect({
        that:
          fresh.pid !== bystander.pid &&
          bystanderId !== null &&
          (await isRunning(bystanderId)) &&
          (await readClaim())?.holders.includes(holderA) === true,
        message: "a stale claim must be discarded without signalling its PID",
      });
      // Drop the carried stale holder, then A's release stops the helper.
      expectExit({
        result: await cli({ verb: "down", branch: branchB }),
        codes: [0],
        message: "branch B down (carried holder)",
      });
      expectExit({
        result: await cli({ verb: "down", branch: branchA }),
        codes: [0],
        message: "branch A down after stale claim",
      });
      expect({
        that:
          !(await isRunning(fresh)) &&
          bystanderId !== null &&
          (await isRunning(bystanderId)),
        message: "down must stop only the owned helper",
      });
      await stopForeign(bystander);

      ctx.log("healthy helper started elsewhere is adopted, never stopped");
      const external = await startForeign("identity");
      expectExit({
        result: await cli({ verb: "up", branch: branchA }),
        codes: [0],
        message: "branch A adopts an external helper",
      });
      expect({
        that: (await readClaim())?.ownership === "adopted",
        message: "the external helper should be recorded as adopted",
      });
      expectExit({
        result: await cli({ verb: "down", branch: branchA }),
        codes: [0],
        message: "branch A down after adoption",
      });
      expect({
        that:
          (await isRunning(external.id)) &&
          (await served(port)) === `served:${UPSTREAM}` &&
          (await readClaim()) === null,
        message: "down must release, not stop, an adopted helper",
      });
      await stopForeign(external.proc);

      ctx.log("foreign port owner is refused and survives");
      const tcp = await startForeign("tcp");
      const refused = await cli({ verb: "up", branch: branchA });
      expect({
        that:
          refused.exitCode !== 0 &&
          refused.combined.includes("foreign-listener") &&
          (await isRunning(tcp.id)) &&
          (await readClaim()) === null,
        message: "a foreign listener must fail closed and keep running",
        result: refused,
      });
      await stopForeign(tcp.proc);
      await waitUntil(async () => !(await portBusy(port)));

      ctx.log("shutdown during readiness retry leaves no owned orphan");
      await writeConfig({ mode: "placeholder", readyTimeoutMs: 30_000 });
      const term = await signalDuringRetry({
        signal: "SIGTERM",
        cwd: fixture.root,
        hackHome: ctx.hackHome,
        path,
        branch: branchA,
        readClaim,
      });
      expect({
        that:
          term.exitCode === 143 &&
          // Promptly: a start that ignored the signal would only clean up at
          // its 30 s readiness deadline.
          term.exitMs < SIGNAL_EXIT_BOUND_MS &&
          !(await isRunning(term.helper)) &&
          (await readClaim()) === null,
        message: `SIGTERM during retry must promptly stop the owned child and drop its claim (exit ${term.exitCode} after ${term.exitMs} ms)`,
      });

      ctx.log("lost parent: the next starter stops the abandoned helper");
      const lost = await signalDuringRetry({
        signal: "SIGKILL",
        cwd: fixture.root,
        hackHome: ctx.hackHome,
        path,
        branch: branchA,
        readClaim,
      });
      expect({
        that:
          (await isRunning(lost.helper)) &&
          (await readClaim())?.ownership === "owned",
        message: "a killed starter leaves its helper recorded, not unclaimed",
      });
      await writeConfig({ mode: "placeholder", readyTimeoutMs: 1500 });
      const recovered = await cli({ verb: "up", branch: branchB });
      expect({
        that:
          recovered.exitCode !== 0 &&
          recovered.combined.includes("deadline") &&
          !(await isRunning(lost.helper)) &&
          (await readClaim()) === null,
        message: "the next starter must stop the abandoned helper",
        result: recovered,
      });
      await writeConfig({ mode: "identity" });
      expectExit({
        result: await cli({ verb: "up", branch: branchB }),
        codes: [0],
        message: "a later up starts fresh",
      });
      const last = await ownedHelper();
      expectExit({
        result: await cli({ verb: "down", branch: branchB }),
        codes: [0],
        message: "final down",
      });
      expect({
        that: !((await isRunning(last)) || (await portBusy(port))),
        message: "the final down left an owned helper or listener behind",
      });

      await runReviewRegressionPhases({
        ctx,
        cwd: fixture.root,
        path,
        branch: branchA,
        claimPath,
        writeConfig,
        cli,
        readClaim,
        ownedHelper,
      });
      await runSecondReviewPhases({
        ctx,
        cwd: fixture.root,
        hackDir: fixture.hackDir,
        fixtureName: fixture.name,
        path,
        port,
        branch: branchA,
        writeConfig,
        cli,
        readClaim,
        ownedHelper,
      });
      await runRetainedHelperPhases({
        ctx,
        port,
        holder: holderA,
        branch: branchA,
        writeConfig,
        cli,
        readClaim,
        ownedHelper,
      });
    } finally {
      await cleanupScenario({ foreign, readClaim });
    }
  },
};

/**
 * Helpers stay held while their containers run: a restart that preserves
 * the Compose runtime keeps them, and so does an up whose up.after hook
 * fails after its detached containers started.
 */
async function runRetainedHelperPhases(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly port: number;
  readonly holder: string;
  readonly branch: string;
  readonly writeConfig: (opts: ConfigOptions) => Promise<void>;
  readonly cli: (opts: {
    readonly verb: "up" | "down" | "restart";
    readonly branch: string;
    readonly failComposePartial?: boolean;
  }) => Promise<CliResult>;
  readonly readClaim: () => Promise<ReturnType<
    typeof parseSharedHostClaim
  > | null>;
  readonly ownedHelper: () => Promise<Identity>;
}): Promise<void> {
  const { ctx, branch } = opts;
  const keptFor = async (helper: Identity): Promise<boolean> =>
    (await isRunning(helper)) &&
    (await served(opts.port)) === `served:${UPSTREAM}` &&
    (await opts.readClaim())?.holders.join(",") === opts.holder;
  const downStops = async (helper: Identity, phase: string): Promise<void> => {
    expectExit({
      result: await opts.cli({ verb: "down", branch }),
      codes: [0],
      message: `down after ${phase}`,
    });
    expect({
      that: !(await isRunning(helper)) && (await opts.readClaim()) === null,
      message: `down after ${phase} left the helper running`,
    });
  };

  ctx.log("restart keeps the helper of the containers it preserves");
  await opts.writeConfig({ mode: "identity" });
  expectExit({
    result: await opts.cli({ verb: "up", branch }),
    codes: [0],
    message: "up before restart",
  });
  const beforeRestart = await opts.ownedHelper();
  // Restart preserves the Compose runtime, so the containers keep running:
  // their sole holder must not stop the helper underneath them.
  const restarted = await opts.cli({ verb: "restart", branch });
  expectExit({ result: restarted, codes: [0], message: "restart" });
  const afterRestart = await opts.ownedHelper();
  expect({
    that:
      afterRestart.pid === beforeRestart.pid &&
      afterRestart.birth === beforeRestart.birth &&
      (await keptFor(afterRestart)),
    message:
      "restart stopped or replaced the helper of its preserved containers",
    result: restarted,
  });
  await downStops(afterRestart, "restart");

  ctx.log("a failing up.after hook keeps the helper of the started containers");
  await opts.writeConfig({ mode: "identity", failUpAfter: true });
  const failedAfter = await opts.cli({ verb: "up", branch });
  const claimAfter = await opts.readClaim();
  expect({
    that:
      failedAfter.exitCode !== 0 &&
      claimAfter?.ownership === "owned" &&
      (await keptFor({ pid: claimAfter.pid, birth: claimAfter.birth })),
    message:
      "a failing up.after hook released the helper under running containers",
    result: failedAfter,
  });
  const started = await opts.ownedHelper();
  await opts.writeConfig({ mode: "identity" });
  await downStops(started, "a failed up.after hook");

  ctx.log("a Compose failure after a partial start keeps the helper");
  // Compose exits non-zero (as on a dependency failure or a timeout) after
  // starting some services, which `ps` still reports as running.
  const partial = await opts.cli({
    verb: "up",
    branch,
    failComposePartial: true,
  });
  const claimAfterPartial = await opts.readClaim();
  expect({
    that:
      partial.exitCode !== 0 &&
      claimAfterPartial?.ownership === "owned" &&
      (await keptFor({
        pid: claimAfterPartial.pid,
        birth: claimAfterPartial.birth,
      })),
    message:
      "a Compose failure after a partial start released the helper under running services",
    result: partial,
  });
  await downStops(await opts.ownedHelper(), "a partial start");
}

/**
 * Regressions from the independent review of #565: a down that completes
 * while an up is paused after helper preparation; a helper entry removed
 * from config after start; and a down whose helper release fails.
 */
async function runReviewRegressionPhases(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly cwd: string;
  readonly path: string;
  readonly branch: string;
  readonly claimPath: string;
  readonly writeConfig: (opts: ConfigOptions) => Promise<void>;
  readonly cli: (opts: {
    readonly verb: "up" | "down";
    readonly branch: string;
  }) => Promise<CliResult>;
  readonly readClaim: () => Promise<ReturnType<
    typeof parseSharedHostClaim
  > | null>;
  readonly ownedHelper: () => Promise<Identity>;
}): Promise<void> {
  const { ctx, branch } = opts;
  await opts.writeConfig({ mode: "identity" });

  ctx.log("down during a paused up: the up refuses to start services");
  const gate = join(ctx.tempRoot, "compose-up-gate");
  const dockerLog = join(ctx.tempRoot, "gated-docker.log");
  const pausedUp = Bun.spawn(
    resolveCliSpawnArgs(["up", "--detach", "--json", "--branch", branch]),
    {
      cwd: opts.cwd,
      env: buildCliEnv({
        hackHome: ctx.hackHome,
        extra: {
          PATH: opts.path,
          E2E_ISSUER_UPSTREAM: UPSTREAM,
          E2E_DOCKER_GATE_UP: gate,
          E2E_DOCKER_LOG: dockerLog,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  let reached = false;
  await waitUntil(async () => {
    reached = await Bun.file(`${gate}.reached`).exists();
    return reached;
  });
  if (!reached) {
    pausedUp.kill("SIGKILL");
    await pausedUp.exited;
    throw new Error("the gated up never reached compose image preparation");
  }
  // Helper preparation is done: the up holds a ready helper.
  const pausedHelper = await opts.ownedHelper();
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down while the up is paused",
  });
  expect({
    that: !(await isRunning(pausedHelper)) && (await opts.readClaim()) === null,
    message: "down must release the paused up's helper",
  });
  await writeFile(gate, "open\n");
  const [pausedExit, pausedStdout] = await Promise.all([
    pausedUp.exited,
    new Response(pausedUp.stdout).text(),
  ]);
  const pausedResult = parseEnvelope(pausedStdout);
  const startCalls = (await Bun.file(dockerLog).text())
    .split("\n")
    .filter((line) => line.includes(" up -d "));
  expect({
    that:
      pausedExit !== 0 &&
      pausedResult?.error?.code === "E_LIFECYCLE_FAILED" &&
      (pausedResult.error.message ?? "").includes(
        "before launching services"
      ) &&
      startCalls.length === 0 &&
      (await opts.readClaim()) === null,
    message: `a superseded up must fail before starting containers (exit ${pausedExit}, stdout ${pausedStdout.trim()}, start calls ${startCalls.length})`,
  });

  ctx.log("a helper entry removed after start is still released by down");
  expectExit({
    result: await opts.cli({ verb: "up", branch }),
    codes: [0],
    message: "up before removing the helper entry",
  });
  const removedHelper = await opts.ownedHelper();
  await opts.writeConfig({ mode: "identity", withoutHelpers: true });
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down after removing the helper entry",
  });
  expect({
    that:
      !(await isRunning(removedHelper)) && (await opts.readClaim()) === null,
    message: "down must release a helper whose config entry was removed",
  });
  await opts.writeConfig({ mode: "identity" });

  ctx.log("an unreleased helper fails down and keeps its claim");
  expectExit({
    result: await opts.cli({ verb: "up", branch }),
    codes: [0],
    message: "up before corrupting the claim",
  });
  const keptHelper = await opts.ownedHelper();
  const claimText = await readFile(opts.claimPath, "utf8");
  await writeFile(opts.claimPath, "{not json\n", { mode: 0o600 });
  const failedDown = await opts.cli({ verb: "down", branch });
  const failedResult = parseEnvelope(failedDown.stdout);
  expect({
    that:
      failedDown.exitCode !== 0 &&
      failedResult?.ok === false &&
      failedResult.error?.code === "E_LIFECYCLE_FAILED" &&
      JSON.stringify(failedResult.error.detail ?? {}).includes(HELPER_NAME) &&
      (await readFile(opts.claimPath, "utf8")) === "{not json\n" &&
      (await isRunning(keptHelper)),
    message: "a failed helper release must fail down and keep the claim",
    result: failedDown,
  });
  await writeFile(opts.claimPath, claimText, { mode: 0o600 });
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down after restoring the claim",
  });
  expect({
    that: !(await isRunning(keptHelper)) && (await opts.readClaim()) === null,
    message: "the retried down must stop the helper",
  });
}

type ConfigOptions = {
  readonly mode: HelperMode;
  readonly withoutHelpers?: boolean;
  readonly withProcess?: boolean;
  readonly withInvalidEntry?: boolean;
  readonly disabled?: boolean;
  readonly beforeGate?: string;
  readonly failUpAfter?: boolean;
};

/**
 * Regressions from the second independent review of #565: an invalid entry
 * is refused before any effect; a release failure with no helper configured
 * still fails down; and a newer up of the same instance never makes an
 * earlier, slower up tear down the lifecycle session it adopted.
 */
async function runSecondReviewPhases(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly cwd: string;
  readonly hackDir: string;
  readonly fixtureName: string;
  readonly path: string;
  readonly port: number;
  readonly branch: string;
  readonly writeConfig: (opts: ConfigOptions) => Promise<void>;
  readonly cli: (opts: {
    readonly verb: "up" | "down";
    readonly branch: string;
  }) => Promise<CliResult>;
  readonly readClaim: () => Promise<ReturnType<
    typeof parseSharedHostClaim
  > | null>;
  readonly ownedHelper: () => Promise<Identity>;
}): Promise<void> {
  const { ctx, branch } = opts;
  const holder = `${opts.fixtureName}--${branch}`;

  ctx.log("an invalid sharedHelpers entry is refused before any effect");
  await opts.writeConfig({ mode: "identity", withInvalidEntry: true });
  const refusalLog = join(ctx.tempRoot, "refusal-docker.log");
  for (const verb of ["up", "down", "restart"] as const) {
    const refused = await ctx.cli({
      args: [
        verb,
        ...(verb === "up" ? ["--detach"] : []),
        "--json",
        "--branch",
        branch,
      ],
      cwd: opts.cwd,
      env: {
        PATH: opts.path,
        E2E_ISSUER_UPSTREAM: UPSTREAM,
        E2E_DOCKER_LOG: refusalLog,
      },
    });
    const envelope = parseEnvelope(refused.stdout);
    expect({
      that:
        refused.exitCode !== 0 &&
        envelope?.error?.code === "E_LIFECYCLE_FAILED" &&
        (envelope.error.message ?? "").includes(
          "Invalid lifecycle.sharedHelpers"
        ),
      message: `hack ${verb} must refuse an invalid sharedHelpers entry`,
      result: refused,
    });
  }
  expect({
    that:
      !(await Bun.file(refusalLog).exists()) &&
      (await opts.readClaim()) === null &&
      !(await portBusy(opts.port)),
    message:
      "a refused command must run no Compose command and start no helper",
  });
  await opts.writeConfig({ mode: "identity" });

  ctx.log("a release failure with no helper configured still fails down");
  expectExit({
    result: await opts.cli({ verb: "up", branch }),
    codes: [0],
    message: "up before removing the entry and corrupting the record",
  });
  const recordedHelper = await opts.ownedHelper();
  const acquiredPath = join(
    ctx.hackHome,
    "shared-helpers",
    ".instances",
    `${holder}.acquired.json`
  );
  const acquiredText = await readFile(acquiredPath, "utf8");
  await opts.writeConfig({ mode: "identity", withoutHelpers: true });
  await writeFile(acquiredPath, "{not json\n", { mode: 0o600 });
  const unlistedDown = await opts.cli({ verb: "down", branch });
  const unlisted = parseEnvelope(unlistedDown.stdout);
  expect({
    that:
      unlistedDown.exitCode !== 0 &&
      unlisted?.error?.code === "E_LIFECYCLE_FAILED" &&
      JSON.stringify(unlisted.error.detail ?? {}).includes(
        "recorded-helpers"
      ) &&
      (await isRunning(recordedHelper)),
    message:
      "an unreadable acquired record must fail down even with no helper configured",
    result: unlistedDown,
  });
  await writeFile(acquiredPath, acquiredText, { mode: 0o600 });
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down after restoring the acquired record",
  });
  expect({
    that: !(await isRunning(recordedHelper)),
    message: "the retried down must stop the recorded helper",
  });

  await runOverlappingUpPhase(opts);
  await runDisabledAfterDownPhase(opts);
  await runDownDuringBeforeHookPhase(opts);
  await opts.writeConfig({ mode: "identity" });
}

type OverlapOptions = {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly port: number;
  readonly cwd: string;
  readonly hackDir: string;
  readonly fixtureName: string;
  readonly path: string;
  readonly branch: string;
  readonly writeConfig: (opts: ConfigOptions) => Promise<void>;
  readonly cli: (opts: {
    readonly verb: "up" | "down";
    readonly branch: string;
  }) => Promise<CliResult>;
  readonly ownedHelper: () => Promise<Identity>;
};

/**
 * Start `hack up` for the branch, paused at Compose image preparation by the
 * fake Docker gate. The CLI process itself is spawned (not a `bun` wrapper)
 * so a signal reaches Hack's own handlers.
 */
async function startGatedUp(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly cwd: string;
  readonly path: string;
  readonly branch: string;
  readonly gate: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<Bun.Subprocess<"ignore", "pipe", "ignore">> {
  const args = ["up", "--detach", "--json", "--branch", opts.branch];
  const proc = Bun.spawn(
    process.env.HACK_E2E_CLI_BIN?.trim()
      ? resolveCliSpawnArgs(args)
      : [process.execPath, CLI_ENTRYPOINT, ...args],
    {
      cwd: opts.cwd,
      env: buildCliEnv({
        hackHome: opts.ctx.hackHome,
        extra: {
          PATH: opts.path,
          E2E_ISSUER_UPSTREAM: UPSTREAM,
          E2E_DOCKER_GATE_UP: opts.gate,
          ...opts.extraEnv,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  let reached = false;
  await waitUntil(async () => {
    reached = await Bun.file(`${opts.gate}.reached`).exists();
    return reached;
  });
  if (!reached) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error("the gated up never reached compose image preparation");
  }
  return proc;
}

type EarlierOutcome =
  | "succeeds"
  | "compose-fails"
  | "sigterm"
  /** SIGTERM while another start holds the instance lock past the cleanup timeout. */
  | "sigterm-lock-held";

/**
 * A newer up of the same instance adopts the lifecycle session and helpers
 * of an earlier up that is paused at image preparation. Whatever the earlier
 * up then does (succeeds, fails in Compose, or is terminated), it must not
 * tear down the session or helpers the newer up now relies on.
 */
async function runOverlappingUpPhase(opts: OverlapOptions): Promise<void> {
  const { ctx } = opts;
  const tmux = Bun.which("tmux");
  if (!tmux) {
    if (process.env.HACK_E2E_REQUIRE_TMUX === "1") {
      throw new Error("tmux is required for the overlapping-up phase");
    }
    ctx.log("overlapping up phase skipped: tmux is not installed");
    return;
  }
  await opts.writeConfig({ mode: "identity", withProcess: true });
  for (const outcome of [
    "succeeds",
    "compose-fails",
    "sigterm",
    "sigterm-lock-held",
  ] as const satisfies readonly EarlierOutcome[]) {
    await runOverlap({ ...opts, tmux, outcome });
  }
}

async function runOverlap(
  opts: OverlapOptions & {
    readonly tmux: string;
    readonly outcome: EarlierOutcome;
  }
): Promise<void> {
  const { ctx, branch, outcome } = opts;
  ctx.log(
    `a newer up never makes an earlier up tear down its session (earlier up ${outcome})`
  );
  const sessionName = `${opts.fixtureName}--lifecycle-${branch}`;
  const composeProject = `${opts.fixtureName}--${branch}`;
  const statePath = join(opts.hackDir, ".internal", "lifecycle", "state.json");
  const readToken = async (): Promise<string | null> => {
    const text = await readFile(statePath, "utf8").catch(() => null);
    if (text === null) {
      return null;
    }
    const state = JSON.parse(text) as {
      readonly entries?: readonly {
        readonly composeProject?: string;
        readonly ownershipToken?: string;
      }[];
    };
    return (
      state.entries?.find((entry) => entry.composeProject === composeProject)
        ?.ownershipToken ?? null
    );
  };
  const sessionAlive = async (): Promise<boolean> =>
    (await Bun.spawn([opts.tmux, "has-session", "-t", sessionName], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited) === 0;

  const gate = join(ctx.tempRoot, `overlap-gate-${outcome}`);
  const earlier = await startGatedUp({
    ctx,
    cwd: opts.cwd,
    path: opts.path,
    branch,
    gate,
    ...(outcome === "compose-fails"
      ? { extraEnv: { E2E_DOCKER_FAIL_UP: "1" } }
      : {}),
  });
  const helper = await opts.ownedHelper();
  const token = await readToken();
  expect({
    that: token !== null && (await sessionAlive()),
    message: "the earlier up should own a lifecycle session before pausing",
  });
  expectExit({
    result: await opts.cli({ verb: "up", branch }),
    codes: [0],
    message: "the newer up should adopt the session and helpers",
  });
  // For sigterm-lock-held, hold the shared helper instance lock (as a third
  // start ensuring a slow helper would) until the earlier up has exited.
  const lock =
    outcome === "sigterm-lock-held"
      ? await holdInstanceLock(
          join(
            ctx.hackHome,
            "shared-helpers",
            ".instances",
            `${composeProject}.lock`
          )
        )
      : null;
  if (outcome === "sigterm" || outcome === "sigterm-lock-held") {
    earlier.kill("SIGTERM");
  }
  await writeFile(gate, "open\n");
  const [earlierExit, earlierStdout] = await Promise.all([
    earlier.exited,
    new Response(earlier.stdout).text(),
  ]);
  await lock?.release();
  const expectedExit =
    outcome === "succeeds" ? earlierExit === 0 : earlierExit !== 0;
  expect({
    that:
      expectedExit &&
      (await sessionAlive()) &&
      (await readToken()) === token &&
      (await isRunning(helper)),
    message: `the earlier up (${outcome}) must not tear down the adopted session or helpers (exit ${earlierExit}, stdout ${earlierStdout.trim().slice(0, 300)})`,
  });
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down after the overlapping ups",
  });
  expect({
    that: !((await sessionAlive()) || (await isRunning(helper))),
    message: "down must stop the session and the helper",
  });
}

/** Hold a Hack lock file until `release` is called. */
async function holdInstanceLock(
  lockPath: string
): Promise<{ readonly release: () => Promise<void> }> {
  let releaseLock = (): void => undefined;
  const held = new Promise<void>((resolveHeld) => {
    releaseLock = resolveHeld;
  });
  let acquired = (): void => undefined;
  const isHeld = new Promise<void>((resolveAcquired) => {
    acquired = resolveAcquired;
  });
  const holder = withProjectsRegistryLock({
    lockPath,
    run: async () => {
      acquired();
      await held;
    },
  });
  await isHeld;
  return {
    release: async () => {
      releaseLock();
      await holder;
    },
  };
}

/**
 * A down while an up waits in an up.before hook: the shutdown generation is
 * captured before the hooks, so that up must refuse to start helpers or
 * services once the hook finishes.
 */
async function runDownDuringBeforeHookPhase(
  opts: OverlapOptions
): Promise<void> {
  const { ctx, branch } = opts;
  ctx.log("a down while an up waits in up.before supersedes that up");
  const gate = join(ctx.tempRoot, "before-hook-gate");
  const dockerLog = join(ctx.tempRoot, "before-hook-docker.log");
  await opts.writeConfig({ mode: "identity", beforeGate: gate });
  const args = ["up", "--detach", "--json", "--branch", branch];
  const earlier = Bun.spawn(
    process.env.HACK_E2E_CLI_BIN?.trim()
      ? resolveCliSpawnArgs(args)
      : [process.execPath, CLI_ENTRYPOINT, ...args],
    {
      cwd: opts.cwd,
      env: buildCliEnv({
        hackHome: ctx.hackHome,
        extra: {
          PATH: opts.path,
          E2E_ISSUER_UPSTREAM: UPSTREAM,
          E2E_DOCKER_LOG: dockerLog,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  let reached = false;
  await waitUntil(async () => {
    reached = await Bun.file(`${gate}.reached`).exists();
    return reached;
  });
  if (!reached) {
    earlier.kill("SIGKILL");
    await earlier.exited;
    throw new Error("the up never reached its up.before gate");
  }
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down while the up waits in up.before",
  });
  await writeFile(gate, "open\n");
  const [earlierExit, earlierStdout] = await Promise.all([
    earlier.exited,
    new Response(earlier.stdout).text(),
  ]);
  const envelope = parseEnvelope(earlierStdout);
  const upCalls = (await Bun.file(dockerLog).exists())
    ? (await Bun.file(dockerLog).text())
        .split("\n")
        .filter((line) => line.includes(" up "))
    : [];
  expect({
    that:
      earlierExit !== 0 &&
      envelope?.error?.code === "E_LIFECYCLE_FAILED" &&
      upCalls.length === 0 &&
      !(await portBusy(opts.port)),
    message: `an up superseded during up.before must start no helper or service (exit ${earlierExit}, compose up calls ${upCalls.length}, stdout ${earlierStdout.trim().slice(0, 300)})`,
  });
  await opts.writeConfig({ mode: "identity" });
}

/**
 * A down while an up is paused, then a newer up that succeeds with the helper
 * disabled: the newer start does not restore the earlier start's helper, so
 * the earlier up must still refuse to start services.
 */
async function runDisabledAfterDownPhase(opts: OverlapOptions): Promise<void> {
  const { ctx, branch } = opts;
  ctx.log(
    "a newer up with the helper disabled does not restore an earlier up after down"
  );
  await opts.writeConfig({ mode: "identity" });
  const gate = join(ctx.tempRoot, "disabled-gate");
  const dockerLog = join(ctx.tempRoot, "disabled-docker.log");
  const earlier = await startGatedUp({
    ctx,
    cwd: opts.cwd,
    path: opts.path,
    branch,
    gate,
    extraEnv: { E2E_DOCKER_LOG: dockerLog },
  });
  const helper = await opts.ownedHelper();
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down while the earlier up is paused",
  });
  await opts.writeConfig({ mode: "identity", disabled: true });
  expectExit({
    result: await opts.cli({ verb: "up", branch }),
    codes: [0],
    message: "the newer up with the helper disabled",
  });
  await writeFile(gate, "open\n");
  const [earlierExit, earlierStdout] = await Promise.all([
    earlier.exited,
    new Response(earlier.stdout).text(),
  ]);
  const envelope = parseEnvelope(earlierStdout);
  const startCalls = (await Bun.file(dockerLog).text())
    .split("\n")
    .filter((line) => line.includes(" up -d "));
  expect({
    that:
      earlierExit !== 0 &&
      envelope?.error?.code === "E_LIFECYCLE_FAILED" &&
      startCalls.length === 0 &&
      !(await isRunning(helper)),
    message: `the earlier up must stay superseded after a later up with the helper disabled (exit ${earlierExit}, start calls ${startCalls.length})`,
  });
  expectExit({
    result: await opts.cli({ verb: "down", branch }),
    codes: [0],
    message: "down after the disabled-helper up",
  });
  await opts.writeConfig({ mode: "identity" });
}

type Envelope = {
  readonly ok?: boolean;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly detail?: unknown;
  };
};

function parseEnvelope(stdout: string): Envelope | null {
  // The CLI prints one (pretty-printed) JSON envelope on stdout.
  const start = stdout.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    return JSON.parse(stdout.slice(start)) as Envelope;
  } catch {
    return null;
  }
}

/** Kill this scenario's foreign fixtures and any helper still claimed as owned. */
async function cleanupScenario(opts: {
  readonly foreign: readonly Bun.Subprocess[];
  readonly readClaim: () => Promise<ReturnType<
    typeof parseSharedHostClaim
  > | null>;
}): Promise<void> {
  for (const proc of opts.foreign) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  const claim = await opts.readClaim();
  if (claim?.ownership === "owned") {
    const id = { pid: claim.pid, birth: claim.birth };
    if (await isRunning(id)) {
      process.kill(id.pid, "SIGKILL");
    }
  }
}

async function signalDuringRetry(opts: {
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly cwd: string;
  readonly hackHome: string;
  readonly path: string;
  readonly branch: string;
  readonly readClaim: () => Promise<ReturnType<
    typeof parseSharedHostClaim
  > | null>;
}): Promise<{
  readonly exitCode: number;
  readonly helper: Identity;
  /** Time from the signal to the CLI's exit. */
  readonly exitMs: number;
}> {
  // Signal the CLI process itself: a `bun` on PATH may be a wrapper that
  // forwards or widens the signal (for example by stopping its whole process
  // scope), which would hide whether Hack's own handler cleaned up.
  const args = ["up", "--detach", "--json", "--branch", opts.branch];
  const argv = process.env.HACK_E2E_CLI_BIN?.trim()
    ? resolveCliSpawnArgs(args)
    : [process.execPath, CLI_ENTRYPOINT, ...args];
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: buildCliEnv({
      hackHome: opts.hackHome,
      extra: { PATH: opts.path, E2E_ISSUER_UPSTREAM: UPSTREAM },
    }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let helper: Identity | null = null;
  const deadline = Date.now() + WAIT_MS;
  while (helper === null && Date.now() < deadline) {
    const claim = await opts.readClaim();
    if (claim?.ownership === "owned" && claim.phase === "starting") {
      helper = { pid: claim.pid, birth: claim.birth };
    }
    await Bun.sleep(50);
  }
  if (helper === null) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error("the placeholder helper was never claimed");
  }
  // Let readiness retries begin after the gate opened.
  await Bun.sleep(500);
  const signalledAt = Date.now();
  proc.kill(opts.signal);
  const exitCode = await proc.exited;
  return { exitCode, helper, exitMs: Date.now() - signalledAt };
}

function freePort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {
        // Bind probe only.
      },
    },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function portBusy(port: number): Promise<boolean> {
  try {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {
          // Bind probe only.
        },
      },
    });
    probe.stop(true);
    return Promise.resolve(false);
  } catch {
    return Promise.resolve(true);
  }
}

async function served(port: number): Promise<string> {
  try {
    return await (
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      })
    ).text();
  } catch {
    return "";
  }
}

async function identityOf(pid: number): Promise<Identity | null> {
  const row = (await readProcessIdentities()).find(
    (entry) => entry.pid === pid
  );
  return row ? { pid: row.pid, birth: row.birth } : null;
}

async function isRunning(identity: Identity): Promise<boolean> {
  return isSharedHostProcessRunning(await readProcessIdentities(), identity);
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await Bun.sleep(50);
  }
}

async function waitForLine(
  stream: ReadableStream<Uint8Array> | number | undefined,
  line: string
): Promise<void> {
  if (!(stream && typeof stream !== "number")) {
    throw new Error("fixture stdout is not piped");
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.split("\n").includes(line)) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`fixture exited before printing ${line}`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
