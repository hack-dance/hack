import { expect, test } from "bun:test";
import { __testOnlyUsage } from "../src/commands/usage.ts";
import type {
  HostCommandRecord,
  ObservedProcess,
} from "../src/lib/host-command-observation.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
} from "../src/lib/runtime-projects.ts";

function container(
  id: string,
  state: string,
  lifecycle = false
): RuntimeContainer {
  return {
    id,
    state,
    project: "fixture--branch",
    service: "web",
    name: id,
    status: state,
    ports: "",
    workingDir: "/fixture/.hack",
    image: "fixture",
    configuredMemoryLimitBytes: 8192,
    observation: {
      state,
      health: null,
      exitCode: null,
      startedAt: "2026-01-01T00:00:00Z",
    },
    labels: lifecycle ? { "hack.lifecycle.process": "true" } : {},
    mounts: [
      {
        type: "volume",
        source: "/volume",
        destination: "/app/node_modules",
        mode: "rw",
        rw: true,
      },
    ],
    networks: [],
  };
}

test("usage samples only running Docker containers and retains service/mount attribution", () => {
  const project: RuntimeProject = {
    project: "fixture--branch",
    workingDir: "/fixture/.hack",
    isGlobal: false,
    services: new Map([
      [
        "web",
        {
          service: "web",
          containers: [
            container("running", "running"),
            container("stopped", "exited"),
            container("created", "created"),
            container("host", "running", true),
          ],
        },
      ],
    ]),
  };
  const index = __testOnlyUsage.buildContainerIndex({ projects: [project] });
  expect(index.containerIds).toEqual(["running"]);
  const reportInput = {
    projects: [project],
    index,
    samples: [
      {
        containerId: "running",
        cpuPercent: 12,
        memUsedBytes: 1024,
        memLimitBytes: 4096,
        memPercent: 25,
        netInputBytes: 0,
        netOutputBytes: 0,
        blockInputBytes: 0,
        blockOutputBytes: 0,
        pids: 4,
      },
    ],
  };
  const report = __testOnlyUsage.buildUsageReport({
    ...reportInput,
    startsAfterSample: new Map([["running", "2026-01-01T00:00:00Z"]]),
  });
  expect(report.projects[0]?.containers).toBe(1);
  expect(report.containerDetails?.[0]).toMatchObject({
    project: "fixture--branch",
    service: "web",
    name: "running",
    memUsedBytes: 1024,
    memLimitBytes: 4096,
    configuredMemoryLimitBytes: 8192,
    startedAt: "2026-01-01T00:00:00Z",
    mounts: [{ type: "volume", destination: "/app/node_modules" }],
  });
  const restarted = __testOnlyUsage.buildUsageReport({
    ...reportInput,
    startsAfterSample: new Map([["running", "2026-01-01T00:00:10Z"]]),
  });
  expect(restarted.containerDetails?.[0]?.startedAt).toBeNull();
});

test("Docker usage retains the precision of printed network and disk counters", () => {
  const sample = __testOnlyUsage.parseDockerStatsSampleLine({
    line: JSON.stringify({
      ID: "running",
      NetIO: "1.23GB / 4.2kB",
      BlockIO: "0B / 2MiB",
    }),
  });
  expect(sample).toMatchObject({
    netInputBytes: 1_230_000_000,
    netOutputBytes: 4200,
    blockInputBytes: 0,
    blockOutputBytes: 2_097_152,
    ioCounterErrorBytes: {
      netInput: 5_000_000,
      netOutput: 50,
      blockInput: 0,
      blockOutput: 524_288,
    },
  });
});

test("post-sample inspection keeps complete rows for surviving requested containers", () => {
  const surviving = "0123456789ab";
  const gone = "111111111111";
  const startedAt = "2026-01-01T00:00:00Z";
  const starts = __testOnlyUsage.parseSampleStartTimes({
    ids: new Set([surviving, gone]),
    output: [
      JSON.stringify({ id: `${surviving}cdef`, startedAt }),
      '{"id":"111111111111',
      JSON.stringify({ id: "222222222222", startedAt }),
    ].join("\n"),
  });
  expect([...starts]).toEqual([[surviving, startedAt]]);
});

test("project-scoped host usage includes branch descendants and excludes other projects from totals", () => {
  const records: HostCommandRecord[] = [
    "alpha",
    "alpha--branch",
    "beta",
    "alphabet",
    "alpha",
  ].map((project, index) => ({
    version: 1,
    id: String(index),
    project,
    projectRoot: `/${project}`,
    executable: "bun",
    wrapper: { pid: 100 * (index + 1), birth: "start" },
    child: { pid: 100 * (index + 1) + 1, birth: "start" },
    ownsProcessGroup: true,
    processGroupId: 100 * (index + 1) + 1,
    lifetime: "command",
    timeoutMs: null,
    startedAt: "2026-09-08T17:00:00.000Z",
    finishedAt: null,
    status: index === 4 ? "exited" : "running",
    exitCode: null,
    cpuTimeMs: null,
    maxRssBytes: null,
  }));
  const snapshot: ObservedProcess[] = records.flatMap((record) =>
    [0, 1].map((offset) => ({
      pid: record.child.pid + offset,
      ppid: offset === 0 ? record.wrapper.pid : record.child.pid,
      processGroupId: record.child.pid,
      birth: "start",
      elapsedMs: 1000,
      cpuTimeMs: 10,
      rssBytes: 100,
    }))
  );
  const tracked = __testOnlyUsage.collectTrackedHostPids({
    records,
    snapshot,
    filter: "alpha",
  });
  expect(
    [...tracked].filter(([, name]) => name !== null).map(([pid]) => pid)
  ).toEqual([101, 102, 201, 202]);
  expect(tracked.get(301)).toBeNull();
  const report = __testOnlyUsage.buildHostUsageReport({
    samples: [...tracked].flatMap(([pid, name]) =>
      name === null ? [] : [{ pid, name, cpuPercent: 1, memBytes: 100 }]
    ),
  });
  expect(report.rows.map((row) => row.name)).toEqual([
    "host:alpha--branch:bun",
    "host:alpha:bun",
  ]);
  expect(report.total).toMatchObject({
    cpuPercent: 4,
    memBytes: 400,
    processes: 4,
  });
  expect(
    __testOnlyUsage.collectTrackedHostPids({ records, snapshot, filter: null })
      .size
  ).toBe(8);
  const nestedSnapshot = snapshot.map((row) =>
    row.pid === 301 ? { ...row, ppid: 102 } : row
  );
  for (const filter of ["alpha", "beta", null]) {
    const nested = __testOnlyUsage.collectTrackedHostPids({
      records,
      snapshot: nestedSnapshot,
      filter,
    });
    expect(nested.get(301)).toBe(filter === "alpha" ? null : "host:beta:bun");
    expect(nested.get(302)).toBe(filter === "alpha" ? null : "host:beta:bun");
    expect(nested.get(101)).toBe(filter === "beta" ? null : "host:alpha:bun");
  }
});

test("by-service usage sums replicas per instance and service, sorted", () => {
  const sample = (containerId: string, cpu: number | null, mem: number) => ({
    containerId,
    cpuPercent: cpu,
    memUsedBytes: mem,
    memLimitBytes: 1000,
    memPercent: null,
    netInputBytes: null,
    netOutputBytes: null,
    blockInputBytes: null,
    blockOutputBytes: null,
    pids: null,
  });
  const at = (id: string, project: string, service: string) =>
    [id, { ...container(id, "running"), project, service }] as const;
  const rows = __testOnlyUsage.buildServiceUsageRows({
    index: {
      containerById: new Map([
        at("w1", "shop", "worker"),
        at("w2", "shop", "worker"),
        at("a1", "shop", "api"),
        at("b1", "shop--feature", "api"),
      ]),
    },
    samples: [
      sample("w1", 10, 100),
      sample("w2", null, 50),
      sample("a1", 5, 10),
      sample("b1", 1, 1),
      sample("unknown", 99, 99),
    ],
  });
  expect(rows).toEqual([
    {
      composeProject: "shop",
      service: "api",
      containers: 1,
      cpuPercent: 5,
      memUsedBytes: 10,
      memLimitBytes: 1000,
    },
    {
      composeProject: "shop",
      service: "worker",
      containers: 2,
      cpuPercent: 10,
      memUsedBytes: 150,
      memLimitBytes: 2000,
    },
    {
      composeProject: "shop--feature",
      service: "api",
      containers: 1,
      cpuPercent: 1,
      memUsedBytes: 1,
      memLimitBytes: 1000,
    },
  ]);
});
