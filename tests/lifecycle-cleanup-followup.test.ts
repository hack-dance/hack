import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signalCleanupKeepingStartedHelpers,
  withSharedHelperCleanup,
} from "../src/commands/project.ts";
import { installForegroundTerminationGuard } from "../src/lib/foreground-termination-guard.ts";
import { refreshMissingLifecyclePaneBirths } from "../src/lib/project-lifecycle-controller.ts";
import { withOwnedProcessListeners } from "./helpers/owned-process-listeners.ts";

test("foreground guard requests force only on the second Ctrl-C", async () => {
  await withOwnedProcessListeners("SIGINT", () =>
    withOwnedProcessListeners("SIGTERM", () => {
      const guard = installForegroundTerminationGuard();
      try {
        process.emit("SIGINT");
        expect(guard.exitCode()).toBe(130);
        expect(guard.force.aborted).toBe(false);
        process.emit("SIGINT");
        expect(guard.force.aborted).toBe(true);
      } finally {
        guard.dispose();
      }
    })
  );
});

test("shared-helper wrappers preserve the operation's force signal", async () => {
  const force = new AbortController();
  const seen: AbortSignal[] = [];
  let kept = false;
  let rolledBack = false;
  const combined = withSharedHelperCleanup({
    cleanup: (opts) => {
      if (opts?.force) {
        seen.push(opts.force);
      }
      return Promise.resolve();
    },
    signalCleanup: null,
    sharedHelpers: {
      configured: true,
      rollback: () => {
        rolledBack = true;
        return Promise.resolve();
      },
      assertCurrent: () => Promise.resolve(),
    },
    sessionOwnership: undefined,
  });
  const cleanup = signalCleanupKeepingStartedHelpers({
    cleanup: combined.cleanup,
    containerStartBegun: () => true,
    keepSharedHelpers: () => () => {
      kept = true;
      combined.keepSharedHelpers?.();
    },
  });
  await cleanup?.({ force: force.signal });
  expect(seen).toEqual([force.signal]);
  expect(kept).toBe(true);
  expect(rolledBack).toBe(false);
});

const processRecord = {
  name: "worker",
  windowName: "worker",
  logPath: "synthetic.log",
  panePid: 42,
};
const pane = {
  pid: 42,
  parentPid: 1,
  processGroupId: 42,
  birth: "fresh-pane-birth",
  zombie: false,
};

test("cleanup refreshes a missing birth from an owned live pane, retrying one empty read", async () => {
  let checks = 0;
  let reads = 0;
  const refreshed = await refreshMissingLifecyclePaneBirths({
    processes: [processRecord],
    readPanes: async () => [42],
    readIdentities: async () => (++reads === 1 ? [] : [pane]),
    assertOwned: async () => {
      checks += 1;
    },
  });
  expect(refreshed).toEqual([{ ...processRecord, paneBirth: pane.birth }]);
  expect(checks).toBe(2);
  expect(reads).toBe(2);
});

test("missing birth is never filled from a PID outside the current owned window", async () => {
  const refreshed = await refreshMissingLifecyclePaneBirths({
    processes: [processRecord],
    readPanes: async () => [43],
    readIdentities: async () => [pane],
    assertOwned: async () => {},
  });
  expect(refreshed).toEqual([processRecord]);
});

test("failed pane refresh preserves the unknown record for owned mux cleanup", async () => {
  let checks = 0;
  const refreshed = await refreshMissingLifecyclePaneBirths({
    processes: [processRecord],
    readPanes: async () => {
      throw new Error("window is gone");
    },
    readIdentities: async () => [pane],
    assertOwned: async () => {
      checks += 1;
    },
  });
  expect(refreshed).toEqual([processRecord]);
  expect(checks).toBe(2);
});

test("identity refresh refuses a replacement owner after reading the pane", async () => {
  let checks = 0;
  await expect(
    refreshMissingLifecyclePaneBirths({
      processes: [processRecord],
      readPanes: async () => [42],
      readIdentities: async () => [pane],
      assertOwned: async () => {
        if (++checks === 2) {
          throw new Error("owner replaced");
        }
      },
    })
  ).rejects.toThrow("owner replaced");
});

test("a stored birth is never replaced by cleanup's newer observation", async () => {
  const recorded = { ...processRecord, paneBirth: "original-birth" };
  const refreshed = await refreshMissingLifecyclePaneBirths({
    processes: [recorded],
    readPanes: async () => {
      throw new Error("must not refresh");
    },
    readIdentities: async () => [pane],
    assertOwned: async () => {},
  });
  expect(refreshed).toEqual([recorded]);
});

test("startup signal cleanup forwards the second interrupt before re-raising", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-cleanup-interrupt-"));
  const source = `import { installLifecycleSignalCleanup } from ${JSON.stringify(join(import.meta.dir, "../src/lib/project-lifecycle-controller.ts"))};
installLifecycleSignalCleanup({ cleanup: async (opts) => {
  await Bun.write(${JSON.stringify(join(root, "entered"))}, "yes");
  await new Promise(resolve => opts.force.addEventListener("abort", async () => {
    await Bun.write(${JSON.stringify(join(root, "forced"))}, "yes"); resolve();
  }, { once: true }));
}});
await Bun.write(${JSON.stringify(join(root, "ready"))}, "yes");
setInterval(() => {}, 1000);`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
  const wait = async (name: string) => {
    const deadline = performance.now() + 3000;
    while (
      !(await Bun.file(join(root, name)).exists()) &&
      performance.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    expect(await Bun.file(join(root, name)).exists()).toBe(true);
  };
  try {
    await wait("ready");
    child.kill("SIGINT");
    await wait("entered");
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(await Bun.file(join(root, "forced")).exists()).toBe(true);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
