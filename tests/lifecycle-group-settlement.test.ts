import { expect, test } from "bun:test";
import {
  createLifecycleSessionRetirement,
  terminateLifecycleProcessGroups,
} from "../src/lib/project-lifecycle-processes.ts";

function runtime(opts: {
  readonly termExit?: number;
  readonly killExit?: number;
  readonly probeError?: string;
}) {
  let now = 0;
  let exitAt = Number.POSITIVE_INFINITY;
  const signals: Array<{
    group: number;
    signal: NodeJS.Signals | 0;
    at: number;
  }> = [];
  return {
    signals,
    absent: () => now >= exitAt,
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    signal: (group: number, signal: NodeJS.Signals | 0) => {
      signals.push({ group, signal, at: now });
      if (signal === 0 && opts.probeError) {
        throw Object.assign(new Error("unavailable"), {
          code: opts.probeError,
        });
      }
      if (now >= exitAt) {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM" && opts.termExit !== undefined) {
        exitAt = now + opts.termExit;
      }
      if (signal === "SIGKILL" && opts.killExit !== undefined) {
        exitAt = now + opts.killExit;
      }
    },
  };
}

test("TERM delivery does not release cleanup until absence is observed", async () => {
  const os = runtime({ termExit: 75 });
  await terminateLifecycleProcessGroups({
    processGroupIds: [42, 42, 1],
    runtime: os,
  });
  expect(os.absent()).toBe(true);
  expect(os.now()).toBe(75);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 42, signal: "SIGTERM", at: 0 },
  ]);
});

test("KILL delivery is not exit: await the final disappearance before returning", async () => {
  const os = runtime({ killExit: 100 });
  await terminateLifecycleProcessGroups({ processGroupIds: [42], runtime: os });
  expect(os.absent()).toBe(true);
  expect(os.now()).toBe(600);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 42, signal: "SIGTERM", at: 0 },
    { group: 42, signal: "SIGKILL", at: 500 },
  ]);
});

test("mux-signalled groups get a reap grace without another TERM", async () => {
  const os = runtime({ killExit: 25 });
  await terminateLifecycleProcessGroups({
    processGroupIds: [42],
    alreadySignalled: true,
    runtime: os,
  });
  expect(os.absent()).toBe(true);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 42, signal: "SIGKILL", at: 500 },
  ]);
});

test("a surviving group is reported after one escalation and a finite wait", async () => {
  const os = runtime({});
  await expect(
    terminateLifecycleProcessGroups({ processGroupIds: [42], runtime: os })
  ).rejects.toThrow(
    "Could not confirm lifecycle process groups stopped after SIGKILL: 42"
  );
  expect(os.now()).toBe(2500);
  expect(os.signals.filter((event) => event.signal === "SIGKILL")).toHaveLength(
    1
  );
});

test("permission errors cannot become absence or grant a kill", async () => {
  const os = runtime({ probeError: "EPERM" });
  await expect(
    terminateLifecycleProcessGroups({
      processGroupIds: [42],
      alreadySignalled: true,
      runtime: os,
    })
  ).rejects.toThrow("Could not confirm lifecycle process group 42 stopped");
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

test("a lost freshness fence prevents escalation", async () => {
  const os = runtime({});
  await expect(
    terminateLifecycleProcessGroups({
      processGroupIds: [42],
      alreadySignalled: true,
      runtime: os,
      assertFresh: () => Promise.reject(new Error("owner changed")),
    })
  ).rejects.toThrow("owner changed");
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

test("one failed foreground snapshot is retried before the owned mux stop", async () => {
  let reads = 0;
  let stopped = false;
  const retire = createLifecycleSessionRetirement({
    readIdentities: () =>
      Promise.resolve([
        {
          pid: 7,
          parentPid: 0,
          birth: "synthetic-other-process",
          zombie: false,
        },
      ]),
    readSnapshot: () => {
      reads++;
      if (reads === 1) {
        return Promise.reject(new Error("slow ps"));
      }
      return Promise.resolve([{ pid: 7, ppid: 0, processGroupId: 7 }]);
    },
  });
  expect(
    await retire({
      processes: [{ panePid: 42 }],
      stopSession: () => {
        stopped = true;
        return Promise.resolve(true);
      },
    })
  ).toBe(true);
  expect(reads).toBe(2);
  expect(stopped).toBe(true);
});

test("failed process inspection still stops the owned mux and retains uncertainty on retries", async () => {
  let reads = 0;
  let stops = 0;
  const retire = createLifecycleSessionRetirement({
    readIdentities: () =>
      Promise.resolve([
        {
          pid: 7,
          parentPid: 0,
          birth: "synthetic-other-process",
          zombie: false,
        },
      ]),
    readSnapshot: () => {
      reads++;
      return Promise.resolve([]);
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      retire({
        processes: [{ panePid: 42 }],
        stopSession: () => {
          stops++;
          return Promise.resolve(true);
        },
      })
    ).rejects.toThrow(
      "Lifecycle mux stopped, but descendant retirement could not be confirmed"
    );
  }
  expect(reads).toBe(2);
  expect(stops).toBe(2);
});
