import { expect, test } from "bun:test";
import {
  type HostCommandRecord,
  observeHostCommand,
  parseHostCommandRecord,
  parseObservedProcesses,
  parseProcessDuration,
} from "../src/lib/host-command-observation.ts";

const record: HostCommandRecord = {
  version: 1,
  id: "f7e49a0a-1355-4b60-8aba-b0a0467dc845",
  project: "fixture",
  projectRoot: "/fixture",
  executable: "bun",
  wrapper: { pid: 100, birth: "Tue Sep 8 13:00:00 2026" },
  child: { pid: 101, birth: "Tue Sep 8 13:00:01 2026" },
  ownsProcessGroup: true,
  processGroupId: 101,
  lifetime: "persistent",
  timeoutMs: null,
  startedAt: "2026-09-08T17:00:00.000Z",
  finishedAt: null,
  status: "running",
  exitCode: null,
  cpuTimeMs: null,
  maxRssBytes: null,
};

test("process durations cover macOS fractional CPU and Linux day/hour elapsed fields", () => {
  expect(parseProcessDuration("0:01.25")).toBe(1250);
  expect(parseProcessDuration("2-03:04:05")).toBe(183_845_000);
  expect(parseProcessDuration("bad")).toBeNull();
});

test("process rows contain elapsed, cumulative CPU, RSS and stable identity without argv", () => {
  const rows = parseObservedProcesses(
    "101 100 101 00:02 0:01.25 1024 Tue Sep  8 13:00:01 2026\ninvalid"
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    pid: 101,
    ppid: 100,
    processGroupId: 101,
    elapsedMs: 2000,
    cpuTimeMs: 1250,
    rssBytes: 1_048_576,
    birth: record.child.birth,
  });
  const observed = observeHostCommand(record, rows);
  expect(observed.status).toBe("orphaned");
  expect(observed.attention).toBe("persistent_wrapper_lost");
  expect(observed.liveCpuTimeMs).toBe(1250);
});

test("PID reuse and unavailable snapshots never establish live ownership", () => {
  const reused = parseObservedProcesses(
    "101 1 101 00:01 0:00.01 128 Tue Sep 8 14:00:01 2026"
  );
  expect(observeHostCommand(record, reused)).toMatchObject({
    status: "interrupted",
    ownership: "unverified",
    liveCpuTimeMs: null,
  });
  expect(observeHostCommand(record, null).status).toBe("unknown");
});

test("completed CPU accounting stays separate from live process snapshots", () => {
  const completed = {
    ...record,
    status: "cancelled" as const,
    finishedAt: "2026-09-08T17:00:03.000Z",
    cpuTimeMs: 25,
    exitCode: 143,
  };
  expect(observeHostCommand(completed, [])).toMatchObject({
    status: "cancelled",
    cpuTimeMs: 25,
    liveCpuTimeMs: null,
    elapsedMs: 3000,
    cpuAccounting: "reaped_child",
  });
});

test("stored observation schema strips payload fields and rejects invalid metrics", () => {
  expect(
    parseHostCommandRecord({
      ...record,
      argv: ["secret"],
      env: { TOKEN: "secret" },
    })
  ).toEqual(record);
  expect(parseHostCommandRecord({ ...record, cpuTimeMs: -1 })).toBeNull();
  expect(parseHostCommandRecord({ ...record, id: "../../outside" })).toBeNull();
});
