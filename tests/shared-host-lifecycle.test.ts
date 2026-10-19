import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readProcessIdentities,
  selectProcessTree,
  signalVerifiedProcessTree,
} from "../src/lib/process-tree.ts";
import { withProjectsRegistryLock } from "../src/lib/projects-registry-lock.ts";
import {
  ensureSharedHostHelper,
  parseSharedHostClaim,
  releaseSharedHostHelper,
  type SharedHostEvent,
  type SharedHostHelperSpec,
} from "../src/lib/shared-host-lifecycle.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * Portable process fixtures for the shared host helper contract
 * (docs/reference/shared-host-lifecycle.md). Every fixture is a local Bun
 * process on a loopback port: no Docker, no real HOME, no privileged effect.
 * Foreign processes are started and stopped by the test through their own
 * handles; the library under test may only signal the helpers it claimed.
 */

const HELPER = resolve(import.meta.dir, "fixtures/shared-host-helper.ts");
const STARTER = resolve(import.meta.dir, "fixtures/shared-host-starter.ts");
const TIMEOUT = 30_000;

type Foreign = Bun.Subprocess<"ignore", "pipe", "ignore">;
const foreign: Foreign[] = [];
const starters: Bun.Subprocess<"pipe", "pipe", "ignore">[] = [];
const claimedHelpers: { pid: number; birth: string }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const proc of [...starters.splice(0), ...foreign.splice(0)]) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  // Reap every helper the library claimed, through the shared birth-verified
  // tree primitives rather than the code under test, so a failing or mutated
  // run cannot leak fixture processes onto a shared host.
  const owned = [...claimedHelpers.splice(0)];
  for (const root of roots) {
    const text = await readFile(
      join(root, "state", "issuer-bridge.claim.json"),
      "utf8"
    ).catch(() => null);
    const claim = text === null ? null : parseSharedHostClaim(text);
    if (claim?.ownership === "owned") {
      owned.push({ pid: claim.pid, birth: claim.birth });
    }
  }
  const census = await readProcessIdentities();
  for (const identity of owned) {
    if (
      census.some(
        (row) => row.pid === identity.pid && row.birth === identity.birth
      )
    ) {
      await signalVerifiedProcessTree(
        selectProcessTree(census, identity.pid),
        "SIGKILL"
      );
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function childEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-shared-host-"));
  roots.push(root);
  return root;
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

function specFor(opts: {
  readonly root: string;
  readonly port: number;
  readonly upstream?: string;
  readonly mode?:
    | "identity"
    | "placeholder"
    | "parent"
    | "stubborn"
    | "oversized"
    | "exit";
  readonly backoff?: SharedHostHelperSpec["backoff"];
  readonly probeTimeoutMs?: number;
  readonly deadlineMs?: number;
}): SharedHostHelperSpec {
  const upstream = opts.upstream ?? "https://issuer.branch-a.test";
  return {
    name: "issuer-bridge",
    enabled: true,
    stateDir: join(opts.root, "state"),
    port: opts.port,
    identityPath: "/__hack/identity",
    expected: { helper: "issuer-bridge", upstream },
    command: [
      process.execPath,
      HELPER,
      opts.mode ?? "identity",
      String(opts.port),
      "issuer-bridge",
      upstream,
    ],
    cwd: opts.root,
    env: childEnv(opts.root),
    deadlineMs: opts.deadlineMs ?? 10_000,
    backoff: opts.backoff ?? { initialMs: 25, maxMs: 200 },
    probeTimeoutMs: opts.probeTimeoutMs ?? 500,
  };
}

/**
 * Reads fixture stdout continuously, so `lines` is current even while the
 * test is not waiting (a negative check can inspect what was printed).
 */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";
  let closed = false;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        lines.push(...parts);
      }
    } catch {
      // The fixture was killed; keep what was read.
    } finally {
      closed = true;
    }
  })();
  return {
    lines,
    async waitFor(match: (line: string) => boolean): Promise<string> {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const found = lines.find(match);
        if (found !== undefined) {
          return found;
        }
        if (closed) {
          break;
        }
        await Promise.race([pump, Bun.sleep(10)]);
      }
      const found = lines.find(match);
      if (found === undefined) {
        throw new Error(`fixture line not observed; saw ${lines.join(" | ")}`);
      }
      return found;
    },
  };
}

async function startForeign(opts: {
  readonly mode: "identity" | "tcp" | "reset" | "placeholder" | "oversized";
  readonly port: number;
  readonly helper?: string;
  readonly upstream?: string;
  readonly home: string;
}): Promise<Foreign> {
  const proc = Bun.spawn(
    [
      process.execPath,
      HELPER,
      opts.mode,
      String(opts.port),
      opts.helper ?? "issuer-bridge",
      opts.upstream ?? "https://issuer.branch-a.test",
    ],
    {
      env: childEnv(opts.home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  foreign.push(proc);
  await lineReader(proc.stdout).waitFor((line) => line === "listening");
  return proc;
}

function startStarter(opts: {
  readonly spec: SharedHostHelperSpec;
  readonly holder: string;
  readonly pauseAt?: SharedHostEvent;
  /** Resume a paused starter with {@link resumeStarter} instead of never. */
  readonly resumable?: boolean;
  /** Keep the starter process alive after it prints its result. */
  readonly linger?: boolean;
  /** The starter client's own time zone. */
  readonly tz?: string;
}) {
  const proc = Bun.spawn(
    [
      process.execPath,
      STARTER,
      JSON.stringify(opts.spec),
      opts.holder,
      JSON.stringify({
        pauseAt: opts.pauseAt,
        resume: opts.resumable ? "stdin" : "never",
        linger: opts.linger === true,
      }),
    ],
    {
      env: {
        ...childEnv(opts.spec.cwd),
        ...(opts.tz ? { TZ: opts.tz } : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  starters.push(proc);
  return { proc, output: lineReader(proc.stdout) };
}

async function resumeStarter(starter: ReturnType<typeof startStarter>) {
  starter.proc.stdin.write("resume\n");
  await starter.proc.stdin.flush();
}

async function starterResult(starter: ReturnType<typeof startStarter>) {
  const line = await starter.output.waitFor((entry) =>
    entry.startsWith("result ")
  );
  return JSON.parse(line.slice("result ".length)) as Record<string, unknown>;
}

async function identityOf(pid: number) {
  const row = (await readProcessIdentities()).find(
    (entry) => entry.pid === pid
  );
  return row ? { pid: row.pid, birth: row.birth } : null;
}

async function isAlive(identity: { pid: number; birth: string }) {
  return (await readProcessIdentities()).some(
    (row) => row.pid === identity.pid && row.birth === identity.birth
  );
}

async function waitGone(identity: { pid: number; birth: string }) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (!(await isAlive(identity))) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

async function readClaim(spec: SharedHostHelperSpec) {
  const text = await readFile(
    join(spec.stateDir, `${spec.name}.claim.json`),
    "utf8"
  ).catch(() => null);
  return text === null ? null : parseSharedHostClaim(text);
}

async function trackClaimedHelper(spec: SharedHostHelperSpec) {
  const claim = await readClaim(spec);
  if (claim?.ownership !== "owned") {
    throw new Error("expected an owned claim");
  }
  const identity = { pid: claim.pid, birth: claim.birth };
  claimedHelpers.push(identity);
  return identity;
}

function recorder() {
  const events: SharedHostEvent[] = [];
  return {
    events,
    observe: (event: SharedHostEvent) => {
      events.push(event);
    },
  };
}

test(
  "a disabled helper takes no lock, writes no claim and starts no child",
  async () => {
    const root = await scratch();
    const spec = { ...specFor({ root, port: freePort() }), enabled: false };
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: seen.observe,
    });
    expect(result).toEqual({ state: "disabled", ownership: "disabled" });
    expect(seen.events).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  },
  TIMEOUT
);

test(
  "an owned helper becomes ready by identity, serves its branch upstream and is stopped by its last holder",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: seen.observe,
    });
    const owned = await trackClaimedHelper(spec);
    expect(result).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: true,
      pid: owned.pid,
      endpoint: `http://127.0.0.1:${spec.port}`,
    });
    expect(seen.events).toContain("claimed");
    expect(seen.events.indexOf("claimed")).toBeLessThan(
      seen.events.indexOf("gate-opened")
    );
    expect(await (await fetch(`http://127.0.0.1:${spec.port}/`)).text()).toBe(
      "served:https://issuer.branch-a.test"
    );
    expect(await readClaim(spec)).toMatchObject({
      phase: "ready",
      holders: ["branch-a"],
    });

    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "stopped" }
    );
    expect(await isAlive(owned)).toBe(false);
    expect(await readClaim(spec)).toBeNull();
  },
  TIMEOUT
);

test(
  "a healthy shared helper started elsewhere is adopted and never signalled on release",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const existing = await startForeign({
      mode: "identity",
      port: spec.port,
      home: root,
    });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: seen.observe,
    });
    expect(result).toEqual({
      state: "ready",
      ownership: "adopted",
      endpoint: `http://127.0.0.1:${spec.port}`,
      spawned: false,
    });
    expect(seen.events).not.toContain("spawned");
    expect(await (await fetch(`http://127.0.0.1:${spec.port}/`)).text()).toBe(
      "served:https://issuer.branch-a.test"
    );
    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "released-adopted" }
    );
    await Bun.sleep(200);
    expect(existing.exitCode).toBeNull();
    expect(await readClaim(spec)).toBeNull();
  },
  TIMEOUT
);

test(
  "a helper serving the wrong upstream is refused and left running",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const existing = await startForeign({
      mode: "identity",
      port: spec.port,
      upstream: "https://issuer.production.example",
      home: root,
    });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: seen.observe,
    });
    expect(result).toMatchObject({ state: "failed", reason: "wrong-upstream" });
    expect(JSON.stringify(result)).not.toContain("production");
    expect(seen.events).not.toContain("spawned");
    expect(await readClaim(spec)).toBeNull();
    await Bun.sleep(200);
    expect(existing.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "foreign listeners on the helper port are refused and preserved",
  async () => {
    for (const fixture of [
      { mode: "tcp" as const },
      { mode: "reset" as const },
      { mode: "identity" as const, helper: "unrelated-dev-server" },
    ]) {
      const root = await scratch();
      const spec = specFor({ root, port: freePort(), deadlineMs: 3000 });
      const existing = await startForeign({
        ...fixture,
        port: spec.port,
        home: root,
      });
      const seen = recorder();
      const result = await ensureSharedHostHelper({
        spec,
        holder: "branch-a",
        observe: seen.observe,
      });
      expect(result).toMatchObject({
        state: "failed",
        reason: "foreign-listener",
      });
      expect(seen.events).not.toContain("spawned");
      await Bun.sleep(200);
      expect(existing.exitCode).toBeNull();
    }
  },
  TIMEOUT
);

test(
  "independent concurrent starters are serialized onto one owned helper; sibling holders and branches are preserved",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    // Barrier: the first starter holds the lock until it is resumed, and the
    // second is already contending for it, so both runs overlap for certain.
    const first = startStarter({
      spec,
      holder: "branch-a",
      pauseAt: "lock-acquired",
      resumable: true,
    });
    await first.output.waitFor((line) => line === "event lock-acquired");
    const second = startStarter({ spec, holder: "branch-b" });
    await second.output.waitFor((line) => line === "event lock-waiting");
    await Bun.sleep(300);
    expect(second.output.lines).not.toContain("event lock-acquired");
    await resumeStarter(first);
    const results = await Promise.all([
      starterResult(first),
      starterResult(second),
    ]);
    const owned = await trackClaimedHelper(spec);
    expect(results.map((entry) => entry.state)).toEqual(["ready", "ready"]);
    expect(results.map((entry) => entry.ownership)).toEqual(["owned", "owned"]);
    expect(results.map((entry) => entry.pid)).toEqual([owned.pid, owned.pid]);
    expect(results.filter((entry) => entry.spawned === true)).toHaveLength(1);
    const spawnedEvents = [first, second].filter((starter) =>
      starter.output.lines.includes("event spawned")
    );
    expect(spawnedEvents).toHaveLength(1);
    expect([...((await readClaim(spec))?.holders ?? [])].sort()).toEqual([
      "branch-a",
      "branch-b",
    ]);

    // A sibling branch with a different upstream cannot take over the helper.
    const sibling = await ensureSharedHostHelper({
      spec: specFor({
        root,
        port: spec.port,
        upstream: "https://issuer.branch-c.test",
      }),
      holder: "branch-c",
    });
    expect(sibling).toMatchObject({
      state: "failed",
      reason: "wrong-upstream",
    });

    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "retained" }
    );
    expect(await isAlive(owned)).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${spec.port}/`)).text()).toBe(
      "served:https://issuer.branch-a.test"
    );
    expect(await releaseSharedHostHelper({ spec, holder: "branch-b" })).toEqual(
      { state: "stopped" }
    );
    expect(await isAlive(owned)).toBe(false);
  },
  TIMEOUT
);

test(
  "a stale claim whose PID was reused is discarded without signalling the live process",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const bystander = await startForeign({
      mode: "placeholder",
      port: 0,
      home: root,
    });
    const reused = await identityOf(bystander.pid);
    expect(reused).not.toBeNull();
    const staleClaim = {
      version: 1,
      helper: spec.name,
      port: spec.port,
      ownership: "owned",
      phase: "ready",
      pid: bystander.pid,
      birth: "Thu Jan 1 00:00:00 1970",
      holders: ["branch-old"],
    };
    await mkdir(spec.stateDir, { recursive: true, mode: 0o700 });
    const claimFile = join(spec.stateDir, `${spec.name}.claim.json`);
    await writeFile(claimFile, JSON.stringify(staleClaim), { mode: 0o600 });

    // Release by the last holder must not signal the reused PID.
    expect(
      await releaseSharedHostHelper({ spec, holder: "branch-old" })
    ).toEqual({ state: "stale-cleared" });
    await Bun.sleep(200);
    expect(bystander.exitCode).toBeNull();

    // A starter treats the same stale claim as no ownership and starts fresh.
    await writeFile(claimFile, JSON.stringify(staleClaim), { mode: 0o600 });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: seen.observe,
    });
    const owned = await trackClaimedHelper(spec);
    expect(seen.events).toContain("claim-stale");
    expect(result).toMatchObject({ state: "ready", ownership: "owned" });
    expect(owned.pid).not.toBe(bystander.pid);
    expect((await readClaim(spec))?.holders).toEqual([
      "branch-old",
      "branch-a",
    ]);
    await Bun.sleep(200);
    expect(bystander.exitCode).toBeNull();
    expect(await isAlive(reused ?? owned)).toBe(true);
  },
  TIMEOUT
);

test(
  "a crashed owned child is restarted under a fresh claim by the next starter",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const first = await ensureSharedHostHelper({ spec, holder: "branch-a" });
    const crashed = await trackClaimedHelper(spec);
    expect(first).toMatchObject({ state: "ready", spawned: true });
    process.kill(crashed.pid, "SIGKILL");
    expect(await waitGone(crashed)).toBe(true);

    const seen = recorder();
    const second = await ensureSharedHostHelper({
      spec,
      holder: "branch-b",
      observe: seen.observe,
    });
    const restarted = await trackClaimedHelper(spec);
    expect(seen.events).toContain("claim-stale");
    expect(second).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: true,
      pid: restarted.pid,
    });
    expect(restarted).not.toEqual(crashed);
    expect((await readClaim(spec))?.holders).toEqual(["branch-a", "branch-b"]);
    expect(await (await fetch(`http://127.0.0.1:${spec.port}/`)).text()).toBe(
      "served:https://issuer.branch-a.test"
    );
  },
  TIMEOUT
);

test(
  "cancellation during bounded readiness retries stops the owned placeholder and keeps foreign processes",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort(), mode: "placeholder" });
    const bystander = await startForeign({
      mode: "tcp",
      port: freePort(),
      home: root,
    });
    const controller = new AbortController();
    let owned: { pid: number; birth: string } | null = null;
    let retries = 0;
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      signal: controller.signal,
      observe: async (event) => {
        if (event === "claimed") {
          owned = await trackClaimedHelper(spec);
        }
        if (event === "probe-retry") {
          retries += 1;
          if (retries === 3) {
            controller.abort();
          }
        }
      },
    });
    expect(result).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(retries).toBe(3);
    expect(owned).not.toBeNull();
    expect(await isAlive(owned ?? { pid: 0, birth: "" })).toBe(false);
    expect(await readClaim(spec)).toBeNull();
    expect(bystander.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a live placeholder is never readiness: the deadline bounds retries and stops the owned child",
  async () => {
    const root = await scratch();
    const spec = specFor({
      root,
      port: freePort(),
      mode: "placeholder",
      deadlineMs: 800,
    });
    let owned: { pid: number; birth: string } | null = null;
    const started = performance.now();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: async (event) => {
        if (event === "claimed") {
          owned = await trackClaimedHelper(spec);
        }
      },
    });
    expect(result).toMatchObject({ state: "failed", reason: "deadline" });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await isAlive(owned ?? { pid: 0, birth: "" })).toBe(false);
    expect(await readClaim(spec)).toBeNull();
  },
  TIMEOUT
);

test(
  "a reused ready claim is not ready when a different process answers its identity, and neither process is signalled",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort(), deadlineMs: 2000 });
    const claimedProcess = await startForeign({
      mode: "placeholder",
      port: 0,
      home: root,
    });
    const impostor = await startForeign({
      mode: "identity",
      port: spec.port,
      home: root,
    });
    const identity = await identityOf(claimedProcess.pid);
    await mkdir(spec.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(spec.stateDir, `${spec.name}.claim.json`),
      JSON.stringify({
        version: 1,
        helper: spec.name,
        port: spec.port,
        ownership: "owned",
        phase: "ready",
        pid: claimedProcess.pid,
        birth: identity?.birth ?? "",
        holders: ["branch-a"],
      }),
      { mode: 0o600 }
    );
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-b",
      observe: seen.observe,
    });
    expect(seen.events).toContain("claim-reused");
    expect(result).toMatchObject({
      state: "failed",
      reason: "foreign-listener",
    });
    expect((await readClaim(spec))?.holders).toEqual(["branch-a"]);
    await Bun.sleep(200);
    expect(claimedProcess.exitCode).toBeNull();
    expect(impostor.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a starter lost before its claim opens the gate leaves no helper running",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const starter = startStarter({
      spec,
      holder: "branch-a",
      pauseAt: "claimed",
    });
    await starter.output.waitFor((line) => line === "event claimed");
    const gated = await trackClaimedHelper(spec);
    starter.proc.kill("SIGKILL");
    await starter.proc.exited;
    expect(await waitGone(gated)).toBe(true);
    const port = await fetch(`http://127.0.0.1:${spec.port}/`).catch(
      () => null
    );
    expect(port).toBeNull();

    const seen = recorder();
    const next = await ensureSharedHostHelper({
      spec,
      holder: "branch-b",
      observe: seen.observe,
    });
    await trackClaimedHelper(spec);
    expect(seen.events).toContain("claim-stale");
    expect(next).toMatchObject({ state: "ready", spawned: true });
  },
  TIMEOUT
);

test(
  "a starter lost after readiness leaves a claimed helper that another client reuses and releases",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const starter = startStarter({
      spec,
      holder: "branch-a",
      pauseAt: "ready",
    });
    await starter.output.waitFor((line) => line === "event ready");
    const owned = await trackClaimedHelper(spec);
    starter.proc.kill("SIGKILL");
    await starter.proc.exited;
    await Bun.sleep(200);
    expect(await isAlive(owned)).toBe(true);

    const seen = recorder();
    const reused = await ensureSharedHostHelper({
      spec,
      holder: "branch-b",
      observe: seen.observe,
    });
    expect(seen.events).toContain("claim-reused");
    expect(reused).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: false,
      pid: owned.pid,
    });
    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "retained" }
    );
    expect(await releaseSharedHostHelper({ spec, holder: "branch-b" })).toEqual(
      { state: "stopped" }
    );
    expect(await isAlive(owned)).toBe(false);
  },
  TIMEOUT
);

test(
  "release stops the owned helper's own descendants and nothing else",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort(), mode: "parent" });
    const bystander = await startForeign({
      mode: "placeholder",
      port: 0,
      home: root,
    });
    const result = await ensureSharedHostHelper({ spec, holder: "branch-a" });
    expect(result).toMatchObject({ state: "ready", ownership: "owned" });
    const owned = await trackClaimedHelper(spec);
    const grandchildRow = (await readProcessIdentities()).find(
      (row) => row.parentPid === owned.pid
    );
    expect(grandchildRow).toBeDefined();
    const grandchild = {
      pid: grandchildRow?.pid ?? 0,
      birth: grandchildRow?.birth ?? "",
    };
    claimedHelpers.push(grandchild);
    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "stopped" }
    );
    expect(await isAlive(owned)).toBe(false);
    expect(await waitGone(grandchild)).toBe(true);
    expect(bystander.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "an unreadable claim fails closed for start and release",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    await mkdir(spec.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(spec.stateDir, `${spec.name}.claim.json`),
      '{"version":1,"helper":"issuer-bridge","ownership":"owned"}',
      { mode: 0o600 }
    );
    const seen = recorder();
    expect(
      await ensureSharedHostHelper({
        spec,
        holder: "branch-a",
        observe: seen.observe,
      })
    ).toMatchObject({ state: "failed", reason: "claim-invalid" });
    expect(seen.events).not.toContain("spawned");
    expect(
      await releaseSharedHostHelper({ spec, holder: "branch-a" })
    ).toMatchObject({ state: "failed", reason: "claim-invalid" });
  },
  TIMEOUT
);

test(
  "an unavailable process census fails closed: no spawn, no signal, claim kept",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const bystander = await startForeign({
      mode: "placeholder",
      port: 0,
      home: root,
    });
    const identity = await identityOf(bystander.pid);
    await mkdir(spec.stateDir, { recursive: true, mode: 0o700 });
    const claimFile = join(spec.stateDir, `${spec.name}.claim.json`);
    const claim = JSON.stringify({
      version: 1,
      helper: spec.name,
      port: spec.port,
      ownership: "owned",
      phase: "ready",
      pid: bystander.pid,
      birth: identity?.birth ?? "",
      holders: ["branch-a"],
    });
    await writeFile(claimFile, claim, { mode: 0o600 });
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? "/usr/bin:/bin"}`;
    try {
      const seen = recorder();
      expect(
        await ensureSharedHostHelper({
          spec,
          holder: "branch-b",
          observe: seen.observe,
        })
      ).toMatchObject({ state: "failed", reason: "census-unavailable" });
      expect(seen.events).not.toContain("spawned");
      expect(
        await releaseSharedHostHelper({ spec, holder: "branch-a" })
      ).toMatchObject({ state: "failed", reason: "census-unavailable" });
    } finally {
      restoreEnv("PATH", savedPath);
    }
    expect(await readFile(claimFile, "utf8")).toBe(claim);
    await Bun.sleep(200);
    expect(bystander.exitCode).toBeNull();
  },
  TIMEOUT
);

test("claim parser accepts only the exact v1 shapes", () => {
  const owned = {
    version: 1,
    helper: "issuer-bridge",
    port: 4100,
    ownership: "owned",
    phase: "ready",
    pid: 4242,
    birth: "Mon Oct 19 10:00:00 2026",
    holders: ["branch-a"],
  };
  const adopted = {
    version: 1,
    helper: "issuer-bridge",
    port: 4100,
    ownership: "adopted",
    holders: ["branch-a"],
  };
  expect(parseSharedHostClaim(JSON.stringify(owned))).toEqual(owned as never);
  expect(parseSharedHostClaim(JSON.stringify(adopted))).toEqual(
    adopted as never
  );
  for (const invalid of [
    { ...owned, pid: 1 },
    { ...owned, birth: "" },
    { ...owned, phase: "failed" },
    { ...owned, extra: true },
    { ...owned, holders: ["branch-a", "branch-a"] },
    { ...owned, holders: ["../escape"] },
    { ...adopted, pid: 4242 },
    { ...adopted, version: 2 },
    { ...adopted, port: 70_000 },
  ]) {
    expect(parseSharedHostClaim(JSON.stringify(invalid))).toBeNull();
  }
  expect(parseSharedHostClaim("not json")).toBeNull();
});

async function writeClaimFile(
  spec: SharedHostHelperSpec,
  value: unknown,
  opts: { readonly mode?: number; readonly padding?: number } = {}
) {
  await mkdir(spec.stateDir, { recursive: true, mode: 0o700 });
  const path = join(spec.stateDir, `${spec.name}.claim.json`);
  const text = `${JSON.stringify(value)}${" ".repeat(opts.padding ?? 0)}`;
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, opts.mode ?? 0o600);
  return { path, text };
}

async function processGroupOf(pid: number): Promise<number> {
  const proc = Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(text.trim());
}

test(
  "clients in different time zones agree on an owned helper's birth: it is reused, stays owned and is stopped by its last holder",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    // POSIX zone strings need no zoneinfo, so the zones differ on minimal hosts too.
    const first = startStarter({ spec, holder: "branch-a", tz: "UTC0" });
    expect(await starterResult(first)).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: true,
    });
    const owned = await trackClaimedHelper(spec);
    const second = startStarter({ spec, holder: "branch-b", tz: "HST10" });
    expect(await starterResult(second)).toMatchObject({
      state: "ready",
      ownership: "owned",
      spawned: false,
      pid: owned.pid,
    });
    expect(second.output.lines).toContain("event claim-reused");
    expect(second.output.lines).not.toContain("event claim-stale");
    expect(second.output.lines).not.toContain("event adopted");
    expect(await readClaim(spec)).toMatchObject({
      ownership: "owned",
      pid: owned.pid,
      birth: owned.birth,
      holders: ["branch-a", "branch-b"],
    });
    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "retained" }
    );
    expect(await releaseSharedHostHelper({ spec, holder: "branch-b" })).toEqual(
      { state: "stopped" }
    );
    expect(await isAlive(owned)).toBe(false);
  },
  TIMEOUT
);

test(
  "a starter lost after opening the gate leaves a starting helper that the next starter stops when it never becomes ready",
  async () => {
    const root = await scratch();
    const spec = specFor({
      root,
      port: freePort(),
      mode: "placeholder",
      deadlineMs: 1500,
    });
    const starter = startStarter({
      spec,
      holder: "branch-a",
      pauseAt: "gate-opened",
    });
    await starter.output.waitFor((line) => line === "event gate-opened");
    const abandoned = await trackClaimedHelper(spec);
    starter.proc.kill("SIGKILL");
    await starter.proc.exited;
    expect(await readClaim(spec)).toMatchObject({ phase: "starting" });
    expect(await isAlive(abandoned)).toBe(true);

    const seen = recorder();
    const next = await ensureSharedHostHelper({
      spec,
      holder: "branch-b",
      observe: seen.observe,
    });
    expect(next).toMatchObject({ state: "failed", reason: "deadline" });
    expect(seen.events).toContain("claim-reused");
    expect(seen.events).toContain("stopped-after-failure");
    expect(await waitGone(abandoned)).toBe(true);
    expect(await readClaim(spec)).toBeNull();

    // The helper port is free again for a fresh, working start.
    const fresh = await ensureSharedHostHelper({
      spec: specFor({ root, port: spec.port }),
      holder: "branch-c",
    });
    await trackClaimedHelper(spec);
    expect(fresh).toMatchObject({ state: "ready", spawned: true });
  },
  TIMEOUT
);

test(
  "a lock wait that uses up the deadline reports deadline, never a foreign listener, and adopts nothing",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort(), deadlineMs: 600 });
    const healthy = await startForeign({
      mode: "identity",
      port: spec.port,
      home: root,
    });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: async (event) => {
        seen.observe(event);
        if (event === "lock-acquired") {
          // Stands in for lock contention that consumed the whole deadline.
          await Bun.sleep(700);
        }
      },
    });
    expect(result).toMatchObject({ state: "failed", reason: "deadline" });
    expect(seen.events).not.toContain("adopted");
    expect(await readClaim(spec)).toBeNull();
    expect(healthy.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a port probe cut short by the deadline reports deadline; a full-length silent probe is a foreign listener",
  async () => {
    const root = await scratch();
    const port = freePort();
    const silent = await startForeign({ mode: "tcp", port, home: root });
    const cut = await ensureSharedHostHelper({
      spec: specFor({ root, port, deadlineMs: 600, probeTimeoutMs: 5000 }),
      holder: "branch-a",
    });
    expect(cut).toMatchObject({ state: "failed", reason: "deadline" });
    const full = await ensureSharedHostHelper({
      spec: specFor({ root, port, deadlineMs: 5000, probeTimeoutMs: 300 }),
      holder: "branch-a",
    });
    expect(full).toMatchObject({ state: "failed", reason: "foreign-listener" });
    expect(silent.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a stale owned claim whose PID still answers as the helper is kept, not adopted, and nothing is signalled",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const answering = await startForeign({
      mode: "identity",
      port: spec.port,
      home: root,
    });
    const { path, text } = await writeClaimFile(spec, {
      version: 1,
      helper: spec.name,
      port: spec.port,
      ownership: "owned",
      phase: "ready",
      pid: answering.pid,
      birth: "Thu Jan 1 00:00:00 1970",
      holders: ["branch-a"],
    });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-b",
      observe: seen.observe,
    });
    expect(result).toMatchObject({ state: "failed", reason: "claim-invalid" });
    expect(seen.events).toContain("claim-stale");
    expect(seen.events).not.toContain("adopted");
    expect(await readFile(path, "utf8")).toBe(text);
    await Bun.sleep(200);
    expect(answering.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a claim for another port, a group-readable claim and an oversized claim fail closed",
  async () => {
    const root = await scratch();
    const bystander = await startForeign({
      mode: "placeholder",
      port: 0,
      home: root,
    });
    const identity = await identityOf(bystander.pid);
    const cases = [
      { label: "other port", portOffset: 1, ownership: "owned" },
      { label: "group-readable", mode: 0o640, ownership: "owned" },
      { label: "oversized", padding: 9000, ownership: "adopted" },
    ] as const;
    for (const entry of cases) {
      const spec = specFor({ root: await scratch(), port: freePort() });
      const portOffset = "portOffset" in entry ? entry.portOffset : 0;
      const claim =
        entry.ownership === "owned"
          ? {
              version: 1,
              helper: spec.name,
              port: spec.port + portOffset,
              ownership: "owned",
              phase: "ready",
              pid: bystander.pid,
              birth: identity?.birth ?? "",
              holders: ["branch-a"],
            }
          : {
              version: 1,
              helper: spec.name,
              port: spec.port,
              ownership: "adopted",
              holders: ["branch-a"],
            };
      const { path, text } = await writeClaimFile(spec, claim, {
        mode: "mode" in entry ? entry.mode : undefined,
        padding: "padding" in entry ? entry.padding : undefined,
      });
      const seen = recorder();
      expect({
        label: entry.label,
        result: await ensureSharedHostHelper({
          spec,
          holder: "branch-b",
          observe: seen.observe,
        }),
      }).toMatchObject({
        label: entry.label,
        result: { state: "failed", reason: "claim-invalid" },
      });
      expect(seen.events).not.toContain("spawned");
      expect(seen.events).not.toContain("claim-reused");
      if (portOffset === 0) {
        expect(
          await releaseSharedHostHelper({ spec, holder: "branch-a" })
        ).toMatchObject({ state: "failed", reason: "claim-invalid" });
      }
      expect(await readFile(path, "utf8")).toBe(text);
    }
    await Bun.sleep(200);
    expect(bystander.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a helper that exits during startup reports child-exited and leaves no claim",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort(), mode: "exit" });
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      observe: seen.observe,
    });
    expect(result).toMatchObject({ state: "failed", reason: "child-exited" });
    expect(seen.events).toContain("gate-opened");
    expect(seen.events).toContain("stopped-after-failure");
    expect(await readClaim(spec)).toBeNull();
  },
  TIMEOUT
);

test(
  "cancellation after the claim and before the gate never runs the helper",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const controller = new AbortController();
    let gated: { pid: number; birth: string } | null = null;
    const seen = recorder();
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      signal: controller.signal,
      observe: async (event) => {
        seen.observe(event);
        if (event === "claimed") {
          gated = await trackClaimedHelper(spec);
          controller.abort();
        }
      },
    });
    expect(result).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(seen.events).not.toContain("gate-opened");
    expect(await waitGone(gated ?? { pid: 0, birth: "" })).toBe(true);
    expect(await readClaim(spec)).toBeNull();
    expect(
      await fetch(`http://127.0.0.1:${spec.port}/`).catch(() => null)
    ).toBeNull();
  },
  TIMEOUT
);

test(
  "a helper that ignores SIGTERM is stopped by SIGKILL after the grace period",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort(), mode: "stubborn" });
    expect(
      await ensureSharedHostHelper({ spec, holder: "branch-a" })
    ).toMatchObject({ state: "ready", ownership: "owned" });
    const owned = await trackClaimedHelper(spec);
    expect(
      await releaseSharedHostHelper({ spec, holder: "branch-a", graceMs: 200 })
    ).toEqual({ state: "stopped" });
    expect(await isAlive(owned)).toBe(false);
    expect(await readClaim(spec)).toBeNull();
  },
  TIMEOUT
);

test(
  "an owned helper runs in its own session with only the caller's environment",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const saved = process.env.HACK_SHARED_HOST_RUNNER_ONLY;
    process.env.HACK_SHARED_HOST_RUNNER_ONLY = "runner-value";
    try {
      expect(
        await ensureSharedHostHelper({ spec, holder: "branch-a" })
      ).toMatchObject({ state: "ready", ownership: "owned" });
    } finally {
      restoreEnv("HACK_SHARED_HOST_RUNNER_ONLY", saved);
    }
    const owned = await trackClaimedHelper(spec);
    const keys = (await (
      await fetch(`http://127.0.0.1:${spec.port}/__fixture/env`)
    ).json()) as string[];
    expect(keys).toContain("HOME");
    expect(keys).not.toContain("HACK_SHARED_HOST_RUNNER_ONLY");
    const helperGroup = await processGroupOf(owned.pid);
    expect(helperGroup).toBe(owned.pid);
    expect(helperGroup).not.toBe(await processGroupOf(process.pid));
  },
  TIMEOUT
);

test(
  "cancellation interrupts the readiness backoff sleep",
  async () => {
    const root = await scratch();
    const spec = specFor({
      root,
      port: freePort(),
      mode: "placeholder",
      deadlineMs: 20_000,
      backoff: { initialMs: 5000, maxMs: 5000 },
    });
    const controller = new AbortController();
    let abortedAt = 0;
    let owned: { pid: number; birth: string } | null = null;
    const result = await ensureSharedHostHelper({
      spec,
      holder: "branch-a",
      signal: controller.signal,
      observe: async (event) => {
        if (event === "claimed") {
          owned = await trackClaimedHelper(spec);
        }
        if (event === "probe-retry") {
          setTimeout(() => {
            abortedAt = performance.now();
            controller.abort();
          }, 50);
        }
      },
    });
    expect(result).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(abortedAt).toBeGreaterThan(0);
    expect(performance.now() - abortedAt).toBeLessThan(2500);
    expect(await isAlive(owned ?? { pid: 0, birth: "" })).toBe(false);
  },
  TIMEOUT
);

test(
  "release waits for the helper lock and fails closed when it is held past the timeout",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    expect(
      await ensureSharedHostHelper({ spec, holder: "branch-a" })
    ).toMatchObject({ state: "ready", ownership: "owned" });
    const owned = await trackClaimedHelper(spec);
    const claimFile = join(spec.stateDir, `${spec.name}.claim.json`);
    const before = await readFile(claimFile, "utf8");
    const blocked = await withProjectsRegistryLock({
      lockPath: join(spec.stateDir, `${spec.name}.lock`),
      label: "test holder",
      run: () =>
        releaseSharedHostHelper({ spec, holder: "branch-a", timeoutMs: 300 }),
    });
    expect(blocked).toMatchObject({
      state: "failed",
      reason: "lock-unavailable",
    });
    expect(await isAlive(owned)).toBe(true);
    expect(await readFile(claimFile, "utf8")).toBe(before);
    expect(await releaseSharedHostHelper({ spec, holder: "branch-a" })).toEqual(
      { state: "stopped" }
    );
  },
  TIMEOUT
);

test(
  "an identity answer larger than 4 KiB is not identity: the listener is refused and preserved",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const oversized = await startForeign({
      mode: "oversized",
      port: spec.port,
      home: root,
    });
    const seen = recorder();
    expect(
      await ensureSharedHostHelper({
        spec,
        holder: "branch-a",
        observe: seen.observe,
      })
    ).toMatchObject({ state: "failed", reason: "foreign-listener" });
    expect(seen.events).not.toContain("adopted");
    expect(await readClaim(spec)).toBeNull();
    await Bun.sleep(200);
    expect(oversized.exitCode).toBeNull();
  },
  TIMEOUT
);

test(
  "a stop that cannot be confirmed keeps the claim so the process stays recorded",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    // The starter stays alive and is then frozen, so the helper it spawned
    // cannot be reaped: after SIGKILL it remains a zombie in the census.
    const starter = startStarter({ spec, holder: "branch-a", linger: true });
    expect(await starterResult(starter)).toMatchObject({
      state: "ready",
      ownership: "owned",
    });
    const owned = await trackClaimedHelper(spec);
    starter.proc.kill("SIGSTOP");
    try {
      expect(
        await releaseSharedHostHelper({
          spec,
          holder: "branch-a",
          graceMs: 100,
        })
      ).toEqual({ state: "stop-unconfirmed" });
      expect(await readClaim(spec)).toMatchObject({
        ownership: "owned",
        pid: owned.pid,
        birth: owned.birth,
        holders: [],
      });
    } finally {
      starter.proc.kill("SIGCONT");
    }
  },
  TIMEOUT
);

test(
  "an observer error is rethrown after the waiting gate is closed and its claim removed",
  async () => {
    const root = await scratch();
    const spec = specFor({ root, port: freePort() });
    const children = async () =>
      (await readProcessIdentities())
        .filter((row) => row.parentPid === process.pid)
        .map((row) => ({ pid: row.pid, birth: row.birth }));
    const before = new Set((await children()).map((row) => row.pid));
    let gates: { pid: number; birth: string }[] = [];
    const failure = new Error("observer failed on purpose");
    await expect(
      ensureSharedHostHelper({
        spec,
        holder: "branch-a",
        observe: async (event) => {
          if (event === "spawned") {
            // Each census sees its own short-lived `ps` child; the gate is
            // the new child present in two consecutive censuses.
            const first = await children();
            const second = await children();
            gates = first.filter(
              (row) =>
                !before.has(row.pid) &&
                second.some(
                  (entry) => entry.pid === row.pid && entry.birth === row.birth
                )
            );
            claimedHelpers.push(...gates);
            throw failure;
          }
        },
      })
    ).rejects.toBe(failure);
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) {
      expect(await waitGone(gate)).toBe(true);
    }
    expect(await readClaim(spec)).toBeNull();
  },
  TIMEOUT
);
