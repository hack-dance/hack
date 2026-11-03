import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endLifecycleMuxFixtureGroups,
  writeLifecycleMuxFixture,
} from "./helpers/lifecycle-mux-fixture.ts";
import { createNativeFixtureCases } from "./helpers/native-fixture-cases.ts";

const cases = createNativeFixtureCases({
  label: "Fixture harness",
  defaultTimeoutMs: 10_000,
  settlementBudgetMs: 300,
});

const started: number[] = [];

/** A detached group this test owns; killed in `afterEach` whatever happens. */
function detachedGroup(): number {
  const child = Bun.spawn(["/bin/sleep", "300"], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  started.push(child.pid);
  return child.pid;
}

function groupPresent(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

async function groupEnded(group: number): Promise<boolean> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (!groupPresent(group)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

function endGroup(group: number): void {
  if (groupPresent(group)) {
    process.kill(-group, "SIGKILL");
  }
}

afterEach(() => {
  for (const group of started.splice(0)) {
    endGroup(group);
  }
});

test("a failed case runs its failure cleanup, then settles and keeps its own failure", async () => {
  const noise = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    let group = 0;
    await expect(
      cases.run(() => {
        group = detachedGroup();
        const owner = cases.current();
        owner.settlement.record({
          kind: "process",
          name: "held group",
          pid: group,
          group: true,
        });
        owner.onFailure(() => endGroup(group));
        throw new Error("deliberate case failure");
      })
    ).rejects.toThrow("deliberate case failure");
    // Settlement confirmed absence, so no "also unconfirmed" line was reported.
    expect(await groupEnded(group)).toBe(true);
    expect(
      noise.mock.calls.some((call) =>
        String(call[0]).includes("settlement also unconfirmed")
      )
    ).toBe(false);
  } finally {
    noise.mockRestore();
  }
});

test("a passing case that leaves a group still fails settlement, and only then is it ended", async () => {
  const noise = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    let group = 0;
    let presentAtCleanup = false;
    await expect(
      cases.run(() => {
        group = detachedGroup();
        const owner = cases.current();
        owner.settlement.record({
          kind: "process",
          name: "leaked group",
          pid: group,
          group: true,
        });
        owner.onFailure(() => {
          presentAtCleanup = groupPresent(group);
          endGroup(group);
        });
      })
    ).rejects.toThrow("settlement unconfirmed");
    expect(presentAtCleanup).toBe(true);
    expect(await groupEnded(group)).toBe(true);
  } finally {
    noise.mockRestore();
  }
});

test("a passing case that settles never runs its failure cleanup", async () => {
  let ran = false;
  await cases.run(() => {
    cases.current().onFailure(() => {
      ran = true;
    });
  });
  expect(ran).toBe(false);
});

test("a body that outlives its budget runs the failure cleanup again when it ends", async () => {
  const noise = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    let runs = 0;
    const release = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    await expect(
      cases.run(async () => {
        cases.current().onFailure(() => {
          runs += 1;
          if (runs === 2) {
            ended.resolve();
          }
        });
        await release.promise;
      }, 20)
    ).rejects.toThrow("exceeded its 20 ms budget");
    expect(runs).toBe(1);
    release.resolve();
    await ended.promise;
    expect(runs).toBe(2);
  } finally {
    noise.mockRestore();
  }
});

test("the stand-in mux cleanup ends recorded window groups and ignores a missing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-mux-cleanup-"));
  try {
    const mux = await writeLifecycleMuxFixture(root);
    const state = join(root, "mux.json");
    await endLifecycleMuxFixtureGroups(state);
    for (const args of [
      ["new-session", "-s", "cleanup", "-c", root],
      // Ignores SIGTERM, so only the SIGKILL escalation can end this group.
      ["new-window", "-n", "held", "-c", root, "trap '' TERM; sleep 300"],
    ]) {
      const child = Bun.spawn([mux, ...args], {
        env: { ...process.env, HACK_TEST_MUX_STATE: state },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(0);
    }
    const { windows } = JSON.parse(await readFile(state, "utf8")) as {
      readonly windows: { readonly held: { readonly pid: number } };
    };
    started.push(windows.held.pid);
    // Let the shell install its trap before the cleanup signals it.
    await Bun.sleep(200);
    expect(groupPresent(windows.held.pid)).toBe(true);
    await endLifecycleMuxFixtureGroups(state);
    expect(await groupEnded(windows.held.pid)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("the stand-in mux cleanup signals only its own groups and gets past one that exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-mux-reuse-"));
  try {
    const mux = await writeLifecycleMuxFixture(root);
    const state = join(root, "mux.json");
    for (const args of [
      ["new-session", "-s", "reuse", "-c", root],
      ["new-window", "-n", "live", "-c", root, "sleep 300"],
    ]) {
      const child = Bun.spawn([mux, ...args], {
        env: { ...process.env, HACK_TEST_MUX_STATE: state },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(0);
    }
    const saved = JSON.parse(await readFile(state, "utf8")) as {
      windows: Record<
        string,
        { readonly pid: number; readonly started?: string }
      >;
    };
    const live = saved.windows.live?.pid as number;
    started.push(live);
    const reused = detachedGroup();
    const unproven = detachedGroup();
    const exited = Bun.spawn(["/usr/bin/true"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await exited.exited;
    // `gone` comes first: stopping there would leave the live window running.
    saved.windows = {
      gone: { pid: exited.pid, started: "Thu Jan  1 00:00:00 1970" },
      reused: { pid: reused, started: "Thu Jan  1 00:00:00 1970" },
      unproven: { pid: unproven },
      ...saved.windows,
    };
    await writeFile(state, JSON.stringify(saved));
    await endLifecycleMuxFixtureGroups(state);
    expect(await groupEnded(live)).toBe(true);
    expect(groupPresent(reused)).toBe(true);
    expect(groupPresent(unproven)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
