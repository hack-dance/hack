import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSharedHelperSessionMuxSupported,
  type LifecycleSharedHelpers,
  releaseAfterFailedProcessStart,
  retainHelpersUnlessContainersAbsent,
  runGuardedSharedHelperStart,
  stopSessionBeforeReleasingHelpers,
  withSharedHelperCleanup,
} from "../src/commands/project.ts";
import {
  LIFECYCLE_SESSION_RETAINED,
  LifecycleSessionRetainedError,
} from "../src/lib/project-lifecycle-controller.ts";
import {
  listSharedHelpersHeld,
  type ProcessCleanupOutcome,
  resolveSharedHelperHolder,
  withTerminationAbort,
} from "../src/lib/project-shared-helpers.ts";
import type { MuxBackend } from "../src/mux/mux-backend.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";

/**
 * The combined lifecycle cleanup keeps the session and the helper holders
 * together: when process cleanup is undecidable (the shared helper instance
 * lock was busy), the helper rollback is skipped as well, so a kept session is
 * never left without its helpers.
 */

afterEach(() => {
  setLoggerBackendOverride({ backend: null });
});

function combined(
  outcome: ProcessCleanupOutcome,
  processResult: undefined | "session-retained" = undefined
) {
  const events: string[] = [];
  const sharedHelpers: LifecycleSharedHelpers = {
    configured: true,
    rollback: () => {
      events.push("rollback");
      return Promise.resolve();
    },
    assertCurrent: () => Promise.resolve(),
  };
  const sessionOwnership = {
    runIfOwned: async (cleanup: () => Promise<void>) => {
      if (outcome === "ran") {
        await cleanup();
      }
      events.push(`processes:${outcome}`);
      return outcome;
    },
  };
  const result = withSharedHelperCleanup({
    cleanup: () => {
      events.push("kill-session");
      return Promise.resolve(processResult);
    },
    signalCleanup: null,
    sharedHelpers,
    sessionOwnership,
  });
  return { events, cleanup: result.cleanup };
}

test("an undecidable process cleanup keeps the helper holders too", async () => {
  const { events, cleanup } = combined("undecidable");
  await cleanup?.();
  expect(events).toEqual(["processes:undecidable"]);
});

test("a decided process cleanup is followed by the helper rollback", async () => {
  for (const outcome of ["ran", "adopted"] as const) {
    const { events, cleanup } = combined(outcome);
    await cleanup?.();
    expect(events).toEqual([
      ...(outcome === "ran" ? ["kill-session"] : []),
      `processes:${outcome}`,
      "rollback",
    ]);
  }
});

test("a session kept because its stop was unconfirmed keeps the helper holders too", async () => {
  const { events, cleanup } = combined("ran", "session-retained");
  await cleanup?.();
  expect(events).toEqual(["kill-session", "processes:ran"]);
});

test("a failed process start keeps the helper holders when its session was retained", async () => {
  const cases = [
    {
      name: "abort reports the retained session",
      error: new Error("second process failed"),
      aborted: LIFECYCLE_SESSION_RETAINED,
      rolledBack: false,
    },
    {
      name: "the start already aborted and retained it",
      error: new LifecycleSessionRetainedError(new Error("process failed")),
      aborted: undefined,
      rolledBack: false,
    },
    {
      name: "the session was stopped",
      error: new Error("second process failed"),
      aborted: undefined,
      rolledBack: true,
    },
  ] as const;
  for (const entry of cases) {
    let rolledBack = false;
    await releaseAfterFailedProcessStart({
      error: entry.error,
      abortProcesses: () => Promise.resolve(entry.aborted),
      rollbackHelpers: () => {
        rolledBack = true;
        return Promise.resolve();
      },
    });
    expect({ name: entry.name, rolledBack }).toEqual({
      name: entry.name,
      rolledBack: entry.rolledBack,
    });
  }
});

test("down keeps every helper holder and reports them when the session stop failed or is unknown", async () => {
  const released: string[] = [];
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () =>
      Promise.reject(new Error("Failed to stop owned lifecycle session")),
    containers: "stopped",
    releaseHelpers: () => {
      released.push("release");
      return Promise.resolve([]);
    },
    heldHelperNames: () => Promise.resolve(["chrome-bridge", "mail"]),
  });
  expect(released).toEqual([]);
  expect(outcome.sessionStopFailed?.error).toBeInstanceOf(Error);
  // Callers (down, restart, native retirement) fail on a non-empty list.
  expect(outcome.notReleased).toEqual(["chrome-bridge", "mail"]);
});

test("down releases the helper holders once the session stop succeeded", async () => {
  const events: string[] = [];
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () => {
      events.push("stop");
      return Promise.resolve();
    },
    containers: "stopped",
    releaseHelpers: () => {
      events.push("release");
      return Promise.resolve(["mail"]);
    },
    heldHelperNames: () => Promise.resolve(["chrome-bridge", "mail"]),
  });
  expect(events).toEqual(["stop", "release"]);
  expect(outcome.sessionStopFailed).toBeNull();
  expect(outcome.notReleased).toEqual(["mail"]);
});

test("a signal during a startup whose session was retained never rolls the helpers back afterwards", async () => {
  const events: string[] = [];
  // Absorbs the SIGTERM withTerminationAbort re-raises once it settles.
  const absorb = (): void => undefined;
  process.on("SIGTERM", absorb);
  let onSignalled: () => Promise<void> = () => Promise.resolve();
  let signalled = false;
  try {
    const outcome = await withTerminationAbort(
      () =>
        runGuardedSharedHelperStart({
          startHelpers: () =>
            Promise.resolve({
              configured: true,
              rollback: () => {
                events.push("rollback");
                return Promise.resolve();
              },
              assertCurrent: () => Promise.resolve(),
            }),
          startProcesses: async () => {
            // SIGTERM arrives (and is caught) while processes start; the
            // start then fails and its session stop cannot be confirmed.
            process.kill(process.pid, "SIGTERM");
            await Bun.sleep(50);
            throw new LifecycleSessionRetainedError(new Error("second failed"));
          },
          abortProcesses: () => Promise.resolve(),
          sessionOwnership: undefined,
          setSignalCleanup: (cleanup) => {
            onSignalled = cleanup;
          },
        }),
      {
        onSignalled: () => {
          signalled = true;
          return onSignalled();
        },
      }
    ).then(
      () => "started",
      (error: unknown) => error
    );
    expect(outcome).toBeInstanceOf(LifecycleSessionRetainedError);
    expect(signalled).toBe(true);
    await Bun.sleep(20);
    expect(events).toEqual([]);
  } finally {
    process.off("SIGTERM", absorb);
  }
});

test("helpers recorded as acquired but removed from config are still reported as held", async () => {
  const hackDir = await mkdtemp(join(tmpdir(), "hack-held-helpers-"));
  try {
    const composeProject = "demo--branch-a";
    const dir = join(hackDir, "shared-helpers", ".instances");
    await mkdir(dir, { recursive: true });
    const acquired = join(
      dir,
      `${resolveSharedHelperHolder(composeProject)}.acquired.json`
    );
    // No helper is configured any more; the instance still holds `mail`.
    expect(
      await listSharedHelpersHeld({ helpers: [], composeProject, hackDir })
    ).toEqual([]);
    await writeFile(
      acquired,
      `${JSON.stringify([{ name: "mail", port: 1025 }])}\n`
    );
    expect(
      await listSharedHelpersHeld({ helpers: [], composeProject, hackDir })
    ).toEqual(["mail"]);
    // An unreadable record still reports something kept.
    await writeFile(acquired, "not json");
    expect(
      (await listSharedHelpersHeld({ helpers: [], composeProject, hackDir }))
        .length
    ).toBe(1);
  } finally {
    await rm(hackDir, { recursive: true, force: true });
  }
});

function resolvedMux(available: readonly ("tmux" | "zellij")[]) {
  const backend = (name: "tmux" | "zellij") =>
    ({
      name,
      available: available.includes(name),
      createsWithOwnerToken: name === "tmux",
    }) as unknown as MuxBackend;
  return () =>
    Promise.resolve({
      mode: "auto" as const,
      backends: new Map([
        ["tmux" as const, backend("tmux")],
        ["zellij" as const, backend("zellij")],
      ]),
    });
}

test("shared helpers with a lifecycle session refuse zellij before anything starts", async () => {
  await expect(
    assertSharedHelperSessionMuxSupported({
      sharedHelpersConfigured: true,
      needsSession: true,
      mux: resolvedMux(["zellij"]),
    })
  ).rejects.toThrow("need tmux");
  // tmux records the token with the session: allowed.
  await assertSharedHelperSessionMuxSupported({
    sharedHelpersConfigured: true,
    needsSession: true,
    mux: resolvedMux(["tmux", "zellij"]),
  });
  // No session, or no shared helpers: zellij is unaffected.
  await assertSharedHelperSessionMuxSupported({
    sharedHelpersConfigured: true,
    needsSession: false,
    mux: resolvedMux(["zellij"]),
  });
  await assertSharedHelperSessionMuxSupported({
    sharedHelpersConfigured: false,
    needsSession: true,
    mux: resolvedMux(["zellij"]),
  });
});

test("down keeps every helper holder when the containers were not confirmed stopped", async () => {
  const events: string[] = [];
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () => {
      events.push("stop");
      return Promise.resolve();
    },
    // Compose down failed or timed out (exit 124), or was interrupted.
    containers: "unconfirmed",
    releaseHelpers: () => {
      events.push("release");
      return Promise.resolve([]);
    },
    heldHelperNames: () => Promise.resolve(["mail"]),
  });
  // The lifecycle session still stops; the helpers stay with the containers.
  expect(events).toEqual(["stop"]);
  expect(outcome.sessionStopFailed).toBeNull();
  expect(outcome.notReleased).toEqual(["mail"]);
});

test("containers kept on purpose (restart preserves the runtime) keep the holders without a failure", async () => {
  const events: string[] = [];
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () => {
      events.push("stop");
      return Promise.resolve();
    },
    containers: "kept",
    releaseHelpers: () => {
      events.push("release");
      return Promise.resolve([]);
    },
    heldHelperNames: () => Promise.resolve(["mail"]),
  });
  expect(events).toEqual(["stop"]);
  expect(outcome).toEqual({ sessionStopFailed: null, notReleased: [] });
});

test("once the containers run, the combined cleanup stops the processes but keeps the helpers", async () => {
  const events: string[] = [];
  const combinedCleanup = withSharedHelperCleanup({
    cleanup: () => {
      events.push("processes");
      return Promise.resolve(undefined);
    },
    signalCleanup: null,
    sharedHelpers: {
      configured: true,
      rollback: () => {
        events.push("rollback");
        return Promise.resolve();
      },
      assertCurrent: () => Promise.resolve(),
    },
    sessionOwnership: undefined,
  });
  // A detached Compose up succeeded; then an up.after hook fails.
  combinedCleanup.keepSharedHelpers?.();
  await combinedCleanup.cleanup?.();
  expect(events).toEqual(["processes"]);
});

test("after an unsuccessful container start, helpers are kept unless Compose confirms no container may run", async () => {
  const outcomes = [
    ["absent", false],
    ["present", true],
    ["unknown", true],
    ["throws", true],
  ] as const;
  for (const [probe, kept] of outcomes) {
    let keptHelpers = false;
    await retainHelpersUnlessContainersAbsent({
      probe: () =>
        probe === "throws"
          ? Promise.reject(new Error("docker unavailable"))
          : Promise.resolve(probe),
      keepSharedHelpers: () => {
        keptHelpers = true;
      },
    });
    expect([probe, keptHelpers]).toEqual([probe, kept]);
  }
});
