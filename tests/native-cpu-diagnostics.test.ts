import { expect, spyOn, test } from "bun:test";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { chmod, link, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import {
  createNativeCpuCollector,
  nativeCpuCommandCategory,
} from "../src/lib/native-cpu-diagnostics.ts";

const USAGE = {
  cpuTime: { user: 3000, system: 2000, total: 5000 },
  maxRSS: 1024,
};

async function reportFixture(
  run: (input: { readonly fd: number; readonly path: string }) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-cpu-report-"))
  );
  const path = join(root, "report.json");
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await run({ fd, path });
  } finally {
    closeSync(fd);
    await rm(root, { recursive: true, force: true });
  }
}
function readReport(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error("Expected a diagnostic report");
  }
  return value;
}
function child(...input: [] | [unknown]) {
  const usage = input.length === 0 ? USAGE : input[0];
  let reads = 0;
  return {
    resourceUsage() {
      reads += 1;
      return usage as Bun.ResourceUsage | undefined;
    },
    reads: () => reads,
    privateArguments: "synthetic-argv-canary",
    privateEnvironment: "synthetic-env-canary",
  };
}

test("one report has one usage read per unique child and cumulative process-birth self CPU", async () => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    expect(collector).not.toBeNull();
    const self = spyOn(process, "cpuUsage").mockReturnValue({
      user: 123_000,
      system: 456_000,
    });
    try {
      const observed = child();
      const finish = collector?.begin(observed, "compiler");
      expect(finish?.(0)).toEqual({ cpuTimeMs: 5, maxRssBytes: 1024 });
      expect(observed.reads()).toBe(1);
      expect(collector?.finish(0)).toBe(true);
      expect(collector?.finish(0)).toBe(false);
      const report = readReport(path);
      expect(report).toMatchObject({
        version: 1,
        recordsComplete: true,
        exitCode: 0,
        selfUserMs: 123,
        selfSystemMs: 456,
        started: 1,
        ended: 1,
        duplicates: 0,
        unclassified: 0,
        missing: 0,
        overflow: false,
        records: [
          {
            sequence: 1,
            category: "compiler",
            exitCode: 0,
            cpuTimeMs: 5,
            maxRssBytes: 1024,
          },
        ],
      });
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("synthetic-argv-canary");
      expect(text).not.toContain("synthetic-env-canary");
      expect(self).toHaveBeenCalledTimes(1);
    } finally {
      self.mockRestore();
    }
  });
});

test.each([
  "duplicate begin",
  "duplicate end",
  "pending",
  "unclassified",
])("%s cannot complete accounting", async (kind) => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    const observed = child();
    const finish = collector?.begin(
      observed,
      kind === "unclassified" ? null : "docker"
    );
    if (kind !== "pending") {
      finish?.(0);
    }
    if (kind === "duplicate begin") {
      collector?.begin(observed, "docker")(0);
    } else if (kind === "duplicate end") {
      finish?.(0);
    }
    expect(collector?.finish(0)).toBe(true);
    expect(readReport(path).recordsComplete).toBe(false);
    // A completion arriving after finalization cannot rewrite the final report.
    const before = readFileSync(path, "utf8");
    finish?.(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(observed.reads()).toBe(kind === "pending" ? 0 : 1);
  });
});

test.each([
  undefined,
  { ...USAGE, cpuTime: { ...USAGE.cpuTime, total: Number.NaN } },
  { ...USAGE, cpuTime: { ...USAGE.cpuTime, total: -1 } },
  { ...USAGE, maxRSS: Number.POSITIVE_INFINITY },
])("missing or invalid usage cannot be silently counted as zero", async (usage) => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    const observed = child(usage);
    collector?.begin(observed, "other")(0);
    expect(collector?.finish(0)).toBe(true);
    expect(readReport(path)).toMatchObject({
      recordsComplete: false,
      missing: 1,
    });
    expect(observed.reads()).toBe(1);
  });
});

test.each([
  undefined,
  -1,
  Number.NaN,
  0.5,
])("unknown child exit remains incomplete even with valid usage", async (exitCode) => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    const observed = child();
    collector?.begin(observed, "other")(exitCode);
    expect(collector?.finish(0)).toBe(true);
    expect(readReport(path)).toMatchObject({
      recordsComplete: false,
      missing: 1,
    });
    expect(observed.reads()).toBe(1);
  });
});

test("known nonzero child and CLI exits are preserved, without inventing a successful command", async () => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    collector?.begin(child(), "compose")(17);
    expect(collector?.finish(17)).toBe(true);
    expect(readReport(path)).toMatchObject({
      recordsComplete: true,
      exitCode: 17,
      records: [{ exitCode: 17, category: "compose" }],
    });
  });
});

test("a resource observation exception is incomplete and never serializes private error text", async () => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    collector?.begin(
      {
        resourceUsage() {
          throw new Error("synthetic-error-canary");
        },
      },
      "other"
    )(0);
    expect(collector?.finish(0)).toBe(true);
    expect(readReport(path)).toMatchObject({
      recordsComplete: false,
      missing: 1,
    });
    expect(readFileSync(path, "utf8")).not.toContain("synthetic-error-canary");
  });
});

test("record overflow is bounded and cannot be qualified", async () => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    for (let index = 0; index < 2049; index += 1) {
      collector?.begin(child(), "other")(0);
    }
    expect(collector?.finish(0)).toBe(true);
    const report = readReport(path);
    expect(report).toMatchObject({ recordsComplete: false, overflow: true });
    expect(report.records).toHaveLength(2048);
    expect(readFileSync(path).byteLength).toBeLessThanOrEqual(512 * 1024);
  });
});

test("report publication never overwrites changed, nonprivate or multiply linked data", async () => {
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    writeSync(fd, "synthetic-retained-data", 0, "utf8");
    expect(collector?.finish(0)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("synthetic-retained-data");
  });
  await reportFixture(async ({ fd, path }) => {
    await chmod(path, 0o644);
    expect(createNativeCpuCollector(fd)).toBeNull();
    expect(readFileSync(path)).toHaveLength(0);
  });
  await reportFixture(async ({ fd, path }) => {
    await link(path, `${path}.other`);
    expect(createNativeCpuCollector(fd)).toBeNull();
    expect(readFileSync(path)).toHaveLength(0);
  });
  await reportFixture(async ({ fd, path }) => {
    const collector = createNativeCpuCollector(fd);
    await chmod(path, 0o644);
    expect(collector?.finish(0)).toBe(false);
    expect(readFileSync(path)).toHaveLength(0);
  });
});

test("command categories never retain an argument or invent coverage for unknown commands", () => {
  expect(nativeCpuCommandCategory(["docker", "compose", "private-argv"])).toBe(
    "compose"
  );
  expect(
    nativeCpuCommandCategory(["/owned/docker", "inspect", "private-argv"])
  ).toBe("docker");
  expect(nativeCpuCommandCategory(["git", "private-argv"])).toBe("other");
  expect(nativeCpuCommandCategory(["synthetic-private-executable"])).toBeNull();
  expect(createNativeCpuCollector(0)).toBeNull();
  expect(createNativeCpuCollector(256)).toBeNull();
});
