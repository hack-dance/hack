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
  const report = __testOnlyUsage.buildUsageReport({
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
  });
  expect(report.projects[0]?.containers).toBe(1);
  expect(report.containerDetails?.[0]).toMatchObject({
    project: "fixture--branch",
    service: "web",
    name: "running",
    memUsedBytes: 1024,
    mounts: [{ type: "volume", destination: "/app/node_modules" }],
  });
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
});
