import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSupervisorLifecycleEntry } from "../src/commands/host-ps.ts";
import {
  type LifecycleStateEntry,
  readLifecycleState,
  upsertLifecycleStateEntry,
} from "../src/lib/lifecycle-runtime.ts";
import {
  type LifecycleSupervisorReceipt,
  resolveLifecycleSupervisorRoot,
  withLifecycleSupervisorControllerLock,
} from "../src/lib/lifecycle-supervisor.ts";
import {
  classifySupervisorLifecycleHygiene,
  inspectLifecycleStateEntries,
  type LifecycleHygieneInspection,
  repairProjectLifecycleSessions,
} from "../src/lib/project-lifecycle-hygiene.ts";
import { readSupervisorLifecycleActivity } from "../src/lib/runtime-projects.ts";

function entry(
  overrides: Partial<LifecycleStateEntry> = {}
): LifecycleStateEntry {
  return {
    composeProject: "sample",
    projectName: "sample",
    branch: null,
    sessionName: "sample--lifecycle",
    backend: "supervisor",
    ownershipToken: "synthetic-owner",
    definitionHash: "synthetic-definition",
    updatedAt: "2026-01-01T00:00:00.000Z",
    processes: [
      {
        name: "worker",
        windowName: "worker-window",
        logPath: "/fixture/sample.log",
      },
    ],
    ...overrides,
  };
}

function receipt(
  overrides: Partial<LifecycleSupervisorReceipt> = {}
): LifecycleSupervisorReceipt {
  return {
    version: 1,
    supervisorPid: 500,
    outcome: "observed",
    processes: [
      {
        version: 1,
        name: "worker",
        ownerToken: "synthetic-owner",
        guardPid: 501,
        processGroupId: 501,
        guardStartTime: 123,
        bootId: "synthetic-boot",
        uid: 1000,
        commandPid: 502,
        phase: "running",
        exitCode: null,
        signal: null,
      },
    ],
    liveProcessNames: ["worker"],
    unknownProcessNames: [],
    ...overrides,
  };
}

function classify(
  observation: LifecycleSupervisorReceipt | null,
  options: {
    active?: ReadonlySet<string> | null;
    state?: LifecycleStateEntry;
  } = {}
) {
  const state = options.state ?? entry();
  return classifySupervisorLifecycleHygiene({
    entries: [state],
    receipts: new Map([[state.composeProject, observation]]),
    activeComposeProjects:
      options.active === undefined ? new Set<string>() : options.active,
    now: new Date("2026-02-01T00:00:00.000Z"),
  });
}

test("mux absence grants no stale-state authority over supervisor ownership", () => {
  const result = inspectLifecycleStateEntries({
    entries: [entry()],
    sessionsByBackend: new Map(),
    snapshot: [],
  });
  expect(result.staleEntries).toEqual([]);
  expect(result.orphanedProcessGroups).toEqual([]);
});

test("supervisor hygiene distinguishes native absence from missing and unknown evidence", () => {
  for (const observation of [
    null,
    receipt({ unknownProcessNames: ["worker"] }),
    receipt({ outcome: "refused" }),
  ]) {
    const result = classify(observation);
    expect(result.staleEntries).toEqual([]);
    expect(result.orphanedSessions).toEqual([]);
    expect(result.unverifiedSessions).toHaveLength(1);
  }
  expect(classify(receipt({ liveProcessNames: [] })).staleEntries).toHaveLength(
    1
  );
});

test("supervisor orphan repair admission requires absent runtime and elapsed startup grace", () => {
  expect(classify(receipt()).orphanedSessions).toHaveLength(1);
  expect(
    classify(receipt(), { active: new Set(["sample"]) }).orphanedSessions
  ).toEqual([]);
  expect(classify(receipt(), { active: null }).orphanedSessions).toEqual([]);
  const recent = classify(receipt(), {
    state: entry({ updatedAt: "2026-02-01T00:00:00.000Z" }),
  });
  expect(recent.orphanedSessions).toEqual([]);
  expect(recent.unverifiedSessions).toHaveLength(1);
});

test("runtime lifecycle service status preserves unknown without consulting mux", async () => {
  const state = entry();
  const active = await readSupervisorLifecycleActivity({
    entry: state,
    projectDir: "/fixture",
    inspect: () => Promise.resolve(receipt()),
  });
  expect(active.runningWindows?.has("worker-window")).toBe(true);
  const unknown = await readSupervisorLifecycleActivity({
    entry: state,
    projectDir: "/fixture",
    inspect: () => Promise.reject(new Error("native evidence unavailable")),
  });
  expect(unknown.runningWindows?.size).toBe(0);
  expect(unknown.unknownWindows?.has("worker-window")).toBe(true);
});

test("host ps uses native ownership and does not invent process-group CPU totals", async () => {
  const opts = {
    entry: entry(),
    projectDir: "/fixture",
    projectRoot: "/fixture",
  };
  const active = await observeSupervisorLifecycleEntry({
    ...opts,
    inspect: () => Promise.resolve(receipt()),
  });
  expect(active.ownership).toBe("owned-healthy");
  expect(active.sessionIds).toEqual([501]);
  expect(active.liveCpuTimeMs).toBeNull();
  expect(active.processGroupIds).toEqual([]);
  const unknown = await observeSupervisorLifecycleEntry({
    ...opts,
    inspect: () =>
      Promise.resolve(receipt({ unknownProcessNames: ["worker"] })),
  });
  expect(unknown.ownership).toBe("unknown");
  expect(unknown.attention).toBe("ownership_unverified");
});

function repairInspection(
  state: LifecycleStateEntry
): LifecycleHygieneInspection {
  return {
    staleEntries: [],
    orphanedProcessGroups: [],
    orphanedSessions: [{ entry: state, classification: "owned-healthy" }],
    unverifiedSessions: [],
    runtimeAvailable: true,
  };
}

for (const outcome of ["stopped", "unknown"] as const) {
  test(`supervisor doctor repair retains state unless native stop is confirmed (${outcome})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-observer-"));
    const state = entry();
    let effects = 0;
    try {
      await upsertLifecycleStateEntry({ projectDir: root, entry: state });
      const result = await repairProjectLifecycleSessions({
        projectDir: root,
        projectRoot: root,
        boundary: {
          inspect: () => Promise.resolve(repairInspection(state)),
          backends: () => {
            throw new Error("Supervisor repair consulted mux");
          },
          inspectSupervisor: () => Promise.resolve(receipt()),
          stopSupervisor: ({ ownershipToken }) => {
            expect(ownershipToken).toBe("synthetic-owner");
            effects += 1;
            return Promise.resolve(
              receipt({
                outcome,
                liveProcessNames: outcome === "stopped" ? [] : ["worker"],
              })
            );
          },
        },
      });
      expect(effects).toBe(1);
      expect(result.failures.length).toBe(outcome === "stopped" ? 0 : 1);
      expect((await readLifecycleState({ projectDir: root })).length).toBe(
        outcome === "stopped" ? 0 : 1
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("doctor rechecks runtime absence after native inspection before stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-observer-"));
  const state = entry();
  let inspections = 0;
  let effects = 0;
  try {
    await upsertLifecycleStateEntry({ projectDir: root, entry: state });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        inspect: () => {
          inspections += 1;
          return Promise.resolve({
            ...repairInspection(state),
            orphanedSessions:
              inspections < 3
                ? [{ entry: state, classification: "owned-healthy" as const }]
                : [],
          });
        },
        inspectSupervisor: () => Promise.resolve(receipt()),
        stopSupervisor: () => {
          effects += 1;
          return Promise.resolve(
            receipt({ outcome: "stopped", liveProcessNames: [] })
          );
        },
      },
    });
    expect(inspections).toBe(3);
    expect(effects).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(await readLifecycleState({ projectDir: root })).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor cannot stop a newly adopted cleanup epoch with the same token and timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-observer-"));
  const state = entry({ cleanupEpoch: "synthetic-first-epoch" });
  const adopted = { ...state, cleanupEpoch: "synthetic-adopted-epoch" };
  let effects = 0;
  try {
    await upsertLifecycleStateEntry({ projectDir: root, entry: state });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        inspect: () => Promise.resolve(repairInspection(state)),
        inspectSupervisor: async () => {
          await upsertLifecycleStateEntry({ projectDir: root, entry: adopted });
          return receipt();
        },
        stopSupervisor: () => {
          effects += 1;
          return Promise.resolve(
            receipt({ outcome: "stopped", liveProcessNames: [] })
          );
        },
      },
    });
    expect(effects).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(
      (await readLifecycleState({ projectDir: root }))[0]?.cleanupEpoch
    ).toBe(adopted.cleanupEpoch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor rechecks exact persisted owner after native inspection and before stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-observer-"));
  const state = entry();
  const replacement = entry({
    ownershipToken: "synthetic-replacement",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  let effects = 0;
  try {
    await upsertLifecycleStateEntry({ projectDir: root, entry: state });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        inspect: () => Promise.resolve(repairInspection(state)),
        backends: () => {
          throw new Error("Supervisor repair consulted mux");
        },
        inspectSupervisor: async () => {
          await upsertLifecycleStateEntry({
            projectDir: root,
            entry: replacement,
          });
          return receipt();
        },
        stopSupervisor: () => {
          effects += 1;
          return Promise.resolve(
            receipt({ outcome: "stopped", liveProcessNames: [] })
          );
        },
      },
    });
    expect(effects).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(
      (await readLifecycleState({ projectDir: root }))[0]?.ownershipToken
    ).toBe(replacement.ownershipToken);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one malformed project stays unknown without aborting global observers", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { readLifecycleObservations } = await import(
    "../src/commands/host-ps.ts"
  );
  const { addLifecycleProcessServices } = await import(
    "../src/lib/runtime-projects.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "lifecycle-global-unreadable-"));
  const bad = join(root, "bad", ".hack");
  const good = join(root, "good", ".hack");
  try {
    await mkdir(join(bad, ".internal", "lifecycle"), { recursive: true });
    await mkdir(good, { recursive: true });
    await writeFile(
      join(bad, ".internal", "lifecycle", "state.json"),
      '{"entries":[{}]}'
    );
    const common = {
      projectDirName: ".hack" as const,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const registry = {
      version: 1 as const,
      projects: [
        {
          ...common,
          id: "bad",
          name: "bad",
          projectDir: bad,
          repoRoot: join(root, "bad"),
        },
        {
          ...common,
          id: "good",
          name: "good",
          projectDir: good,
          repoRoot: join(root, "good"),
        },
      ],
    };
    const host = await readLifecycleObservations({
      registry,
      filter: undefined,
      snapshot: [],
    });
    expect(host).toHaveLength(1);
    expect(host[0]?.reason).toBe("state_unreadable");
    expect(host[0]?.ownership).toBe("unknown");
    const runtime = await addLifecycleProcessServices({
      runtime: [
        {
          project: "bad",
          workingDir: bad,
          services: new Map(),
          isGlobal: false,
        },
        {
          project: "good",
          workingDir: good,
          services: new Map(),
          isGlobal: false,
        },
      ],
    });
    expect(runtime).toHaveLength(2);
    expect(
      runtime[0]?.services.get("lifecycle-state")?.containers[0]?.state
    ).toBe("unknown");
    expect(runtime[1]?.services.size).toBe(0);
    const { findOrphanRuntimeProjects } = await import(
      "../src/lib/project-runtime-hygiene.ts"
    );
    expect(await findOrphanRuntimeProjects({ runtime })).toEqual([]);
    const real = {
      id: "synthetic-real-container",
      project: "bad",
      service: "lifecycle-state",
      state: "running",
      status: "Up",
      name: "synthetic-real-container",
      ports: "",
      workingDir: bad,
      image: null,
      labels: {},
      mounts: [],
      networks: [],
    };
    const withExisting = await addLifecycleProcessServices({
      runtime: [
        {
          project: "bad",
          workingDir: bad,
          services: new Map([
            [
              "lifecycle-state",
              { service: "lifecycle-state", containers: [real] },
            ],
          ]),
          isGlobal: false,
        },
      ],
    });
    expect(
      withExisting[0]?.services.get("lifecycle-state")?.containers
    ).toHaveLength(2);
    expect(
      (await findOrphanRuntimeProjects({ runtime: withExisting }))[0]
        ?.containerIds
    ).toEqual([real.id]);
    await expect(readLifecycleState({ projectDir: bad })).rejects.toThrow(
      "state.json"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor control state is outside the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-root-"));
  try {
    const root = resolveLifecycleSupervisorRoot({
      projectDir: directory,
      composeProject: "sample",
    });
    expect(root.startsWith("/synthetic-checkout/")).toBe(false);
    expect(root).toContain("/lifecycle-supervisors/");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor holds the controller lock through native stop and state removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-observer-"));
  const state = entry();
  let acquired = false;
  let competitor: Promise<void> | undefined;
  try {
    await upsertLifecycleStateEntry({ projectDir: root, entry: state });
    const result = await repairProjectLifecycleSessions({
      projectDir: root,
      projectRoot: root,
      boundary: {
        inspect: () => Promise.resolve(repairInspection(state)),
        inspectSupervisor: () => Promise.resolve(receipt()),
        stopSupervisor: async () => {
          competitor = withLifecycleSupervisorControllerLock({
            projectDir: root,
            composeProject: state.composeProject,
            run: async () => {
              acquired = true;
              expect(
                await readLifecycleState({ projectDir: root })
              ).toHaveLength(0);
            },
          });
          await Bun.sleep(50);
          expect(acquired).toBe(false);
          return receipt({ outcome: "stopped", liveProcessNames: [] });
        },
      },
    });
    expect(result.failures).toHaveLength(0);
    await competitor;
    expect(acquired).toBe(true);
  } finally {
    await competitor;
    await rm(root, { recursive: true, force: true });
  }
});
