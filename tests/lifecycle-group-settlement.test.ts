import { expect, test } from "bun:test";
import {
  createLifecycleSessionRetirement,
  selectLiveLifecycleGroups,
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
    liveGroups: (groups: readonly number[]) => Promise.resolve(groups),
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    signal: (group: number, signal: NodeJS.Signals | 0) => {
      signals.push({ group, signal, at: now });
      if (now >= exitAt) {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      }
      if (signal === 0 && opts.probeError) {
        throw Object.assign(new Error("unavailable"), {
          code: opts.probeError,
        });
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
  expect(os.now()).toBeGreaterThanOrEqual(75);
  expect(os.now()).toBeLessThan(200);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 42, signal: "SIGTERM", at: 0 },
  ]);
});

test("KILL delivery is not exit: await the final disappearance before returning", async () => {
  const os = runtime({ killExit: 100 });
  await terminateLifecycleProcessGroups({ processGroupIds: [42], runtime: os });
  expect(os.absent()).toBe(true);
  expect(os.now()).toBe(5100);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 42, signal: "SIGTERM", at: 0 },
    { group: 42, signal: "SIGKILL", at: 5000 },
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
    { group: 42, signal: "SIGKILL", at: 5000 },
  ]);
});

test("only groups outside the wrapper's forwarded signal get TERM", async () => {
  const os = runtime({ termExit: 1000 });
  const batches: number[][] = [];
  await terminateLifecycleProcessGroups({
    processGroupIds: [42, 43],
    alreadySignalledGroups: [42],
    runtime: os,
    beforeSignal: async (groups) => {
      batches.push([...groups]);
      return groups;
    },
  });
  expect(os.now()).toBe(1000);
  expect(batches).toEqual([[43]]);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 43, signal: "SIGTERM", at: 0 },
  ]);
});

test("a surviving group is reported after one escalation and a finite wait", async () => {
  const os = runtime({});
  await expect(
    terminateLifecycleProcessGroups({ processGroupIds: [42], runtime: os })
  ).rejects.toThrow(
    "Could not confirm lifecycle process groups stopped after SIGKILL: 42"
  );
  expect(os.now()).toBe(7000);
  expect(os.signals.filter((event) => event.signal === "SIGKILL")).toHaveLength(
    1
  );
});

test("a cooperative command gets its one-second TERM handler without KILL", async () => {
  const os = runtime({ termExit: 1000 });
  await terminateLifecycleProcessGroups({ processGroupIds: [42], runtime: os });
  expect(os.now()).toBe(1000);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([
    { group: 42, signal: "SIGTERM", at: 0 },
  ]);
});

test("an EPERM probe with a zombie-only census retires without TERM or KILL", async () => {
  const os = runtime({ probeError: "EPERM" });
  await terminateLifecycleProcessGroups({
    processGroupIds: [42],
    runtime: {
      ...os,
      liveGroups: async (groups) =>
        selectLiveLifecycleGroups({
          groups,
          identities: [
            {
              pid: 42,
              parentPid: 1,
              processGroupId: 42,
              birth: "exited",
              zombie: true,
            },
          ],
        }),
    },
  });
  expect(os.now()).toBe(0);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

test("EPERM and a zombie leader do not hide another live group member", async () => {
  const os = runtime({ killExit: 0, probeError: "EPERM" });
  await terminateLifecycleProcessGroups({
    processGroupIds: [42],
    runtime: {
      ...os,
      liveGroups: async (groups) =>
        selectLiveLifecycleGroups({
          groups,
          identities: [
            {
              pid: 42,
              parentPid: 1,
              processGroupId: 42,
              birth: "exited",
              zombie: true,
            },
            {
              pid: 43,
              parentPid: 1,
              processGroupId: 42,
              birth: "running",
              zombie: false,
            },
          ],
        }),
    },
  });
  expect(os.signals.filter((event) => event.signal === "SIGKILL")).toEqual([
    { group: 42, signal: "SIGKILL", at: 5000 },
  ]);
});

test("an EPERM probe followed by ESRCH retires after observing the live member", async () => {
  const os = runtime({});
  let probes = 0;
  let reads = 0;
  await terminateLifecycleProcessGroups({
    processGroupIds: [42],
    alreadySignalled: true,
    runtime: {
      ...os,
      signal: (_group, name) => {
        expect(name).toBe(0);
        probes += 1;
        throw Object.assign(new Error("probe"), {
          code: probes === 1 ? "EPERM" : "ESRCH",
        });
      },
      liveGroups: async (groups) => {
        reads += 1;
        return groups;
      },
    },
  });
  expect(probes).toBe(2);
  expect(reads).toBe(1);
});

test("an EPERM probe retries an unavailable census and accepts the next zombie census", async () => {
  const os = runtime({ probeError: "EPERM" });
  let reads = 0;
  await terminateLifecycleProcessGroups({
    processGroupIds: [42],
    runtime: {
      ...os,
      liveGroups: async () => {
        reads += 1;
        if (reads === 1) {
          await os.sleep(2000);
          throw new Error("ps timeout");
        }
        return [];
      },
    },
  });
  expect(reads).toBe(2);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

test("EPERM with no successful census remains unconfirmed at the deadline", async () => {
  const os = runtime({ probeError: "EPERM" });
  await expect(
    terminateLifecycleProcessGroups({
      processGroupIds: [42],
      alreadySignalled: true,
      runtime: {
        ...os,
        liveGroups: async () => {
          await os.sleep(2000);
          throw new Error("ps timeout");
        },
      },
    })
  ).rejects.toThrow("Could not inspect live lifecycle process-group members");
  expect(os.now()).toBeLessThanOrEqual(7000);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

for (const delivery of ["SIGTERM", "SIGKILL"] as const) {
  for (const state of ["zombie", "live", "unavailable"] as const) {
    test(`${delivery} EPERM is benign only after retirement is proved (${state})`, async () => {
      const os = runtime({});
      let denied = false;
      const stopping = terminateLifecycleProcessGroups({
        processGroupIds: [42],
        alreadySignalled: delivery === "SIGKILL",
        runtime: {
          ...os,
          signal: (group, name) => {
            os.signal(group, name);
            if (name === delivery) {
              denied = true;
              throw Object.assign(new Error("denied"), { code: "EPERM" });
            }
          },
          liveGroups: async (groups) => {
            if (!denied || state === "live") {
              return groups;
            }
            if (state === "unavailable") {
              await os.sleep(2000);
              throw new Error("ps timeout");
            }
            return [];
          },
        },
      });
      if (state === "zombie") {
        await stopping;
      } else {
        await expect(stopping).rejects.toThrow(
          state === "live"
            ? "Could not confirm lifecycle process group 42 stopped"
            : "Could not inspect live lifecycle process-group members"
        );
      }
      expect(denied).toBe(true);
      expect(os.now()).toBeLessThanOrEqual(9000);
      expect(
        os.signals.filter((event) => event.signal === delivery)
      ).toHaveLength(1);
      if (delivery === "SIGTERM") {
        expect(
          os.signals.filter((event) => event.signal === "SIGKILL")
        ).toEqual([]);
      }
    });
  }
}

test("unexpected probe errors still fail without signalling", async () => {
  const os = runtime({ probeError: "EINVAL" });
  await expect(
    terminateLifecycleProcessGroups({ processGroupIds: [42], runtime: os })
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

for (const failedRead of [1, 2, 52]) {
  test(`a timed-out census at read ${failedRead} is retried inside the observation deadline`, async () => {
    const os = runtime({ killExit: 100 });
    let reads = 0;
    await terminateLifecycleProcessGroups({
      processGroupIds: [42],
      alreadySignalled: true,
      runtime: {
        ...os,
        liveGroups: async (groups) => {
          reads += 1;
          if (reads === failedRead) {
            await os.sleep(2000);
            throw new Error("ps timeout");
          }
          return groups;
        },
      },
    });
    expect(os.absent()).toBe(true);
    expect(reads).toBeGreaterThan(failedRead);
    expect(
      os.signals.filter((event) => event.signal === "SIGKILL")
    ).toHaveLength(1);
  });
}

test("continuous census failures are bounded and never authorize KILL", async () => {
  const os = runtime({});
  await expect(
    terminateLifecycleProcessGroups({
      processGroupIds: [42],
      alreadySignalled: true,
      runtime: {
        ...os,
        liveGroups: async () => {
          await os.sleep(2000);
          throw new Error("ps timeout");
        },
      },
    })
  ).rejects.toThrow("Could not inspect live lifecycle process-group members");
  expect(os.now()).toBeLessThanOrEqual(7000);
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

test("a repeated interrupt skips TERM grace but still confirms one KILL", async () => {
  const force = new AbortController();
  const os = runtime({ killExit: 100 });
  await terminateLifecycleProcessGroups({
    processGroupIds: [42],
    alreadySignalled: true,
    force: force.signal,
    runtime: {
      ...os,
      sleep: async (ms) => {
        await os.sleep(ms);
        if (os.now() >= 300) {
          force.abort();
        }
      },
    },
  });
  expect(os.signals.filter((event) => event.signal === "SIGKILL")).toEqual([
    { group: 42, signal: "SIGKILL", at: 300 },
  ]);
  expect(os.now()).toBe(400);
});

test("a force request cannot bypass the ownership fence", async () => {
  const force = new AbortController();
  force.abort();
  const os = runtime({ killExit: 0 });
  await expect(
    terminateLifecycleProcessGroups({
      processGroupIds: [42],
      alreadySignalled: true,
      force: force.signal,
      runtime: os,
      assertFresh: async () => {
        throw new Error("owner replaced");
      },
    })
  ).rejects.toThrow("owner replaced");
  expect(os.signals.filter((event) => event.signal !== 0)).toEqual([]);
});

test("unknown confirmation after KILL is not mistaken for retirement", async () => {
  const os = runtime({});
  let killed = false;
  await expect(
    terminateLifecycleProcessGroups({
      processGroupIds: [42],
      runtime: {
        ...os,
        signal: (group, signal) => {
          os.signal(group, signal);
          if (signal === "SIGKILL") {
            killed = true;
          }
        },
        liveGroups: async (groups) => {
          if (killed) {
            await os.sleep(2000);
            throw new Error("ps timeout");
          }
          return groups;
        },
      },
    })
  ).rejects.toThrow("Could not inspect live lifecycle process-group members");
  expect(os.signals.filter((event) => event.signal === "SIGKILL")).toHaveLength(
    1
  );
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

test("missing pane identity is reported separately from failed process inspection", async () => {
  let stops = 0;
  const retire = createLifecycleSessionRetirement({
    readSnapshot: () =>
      Promise.resolve([{ pid: 42, ppid: 1, processGroupId: 42 }]),
    readIdentities: () =>
      Promise.resolve([
        { pid: 42, parentPid: 1, birth: "live-pane", zombie: false },
      ]),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      retire({
        processes: [{ panePid: 42 }],
        stopSession: () => {
          stops += 1;
          return Promise.resolve(true);
        },
      })
    ).rejects.toThrow("because pane identity is unavailable");
  }
  expect(stops).toBe(2);
});
