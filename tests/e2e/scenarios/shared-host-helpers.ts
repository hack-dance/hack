import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readProcessIdentities } from "../../../src/lib/process-tree.ts";
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
    }): Promise<void> => {
      const lifecycle = (baseConfig.lifecycle ?? {}) as Record<string, unknown>;
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            ...baseConfig,
            lifecycle: {
              ...lifecycle,
              sharedHelpers: [
                {
                  name: HELPER_NAME,
                  // HOME is the scenario temp root: the fixture exits once
                  // it is removed, so a failed run cannot leak a helper.
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
                },
              ],
            },
          },
          null,
          2
        )}\n`
      );
    };

    const cli = (opts: {
      readonly verb: "up" | "down";
      readonly branch: string;
      readonly upstream?: string;
      readonly failCompose?: boolean;
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
    } finally {
      await cleanupScenario({ foreign, readClaim });
    }
  },
};

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
