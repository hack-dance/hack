import { expect, test } from "bun:test";
import {
  parseGitSources,
  recentMergedPullRequests,
  replayAnnotations,
  replayFailures,
  replayJobAdmitted,
} from "../scripts/ci-selection-replay.ts";

test("structured annotations find runner failures and do not rely on stack frames", () => {
  const annotations = [
    {
      annotation_level: "failure",
      path: ".github",
      message: "tests/example.test.ts: fail after 17.3s",
    },
    {
      annotation_level: "warning",
      path: "tests/unrelated.test.ts",
      message: "warning",
    },
  ];
  expect(
    replayAnnotations({
      annotations,
      selection: { mode: "selected", reason: "fixture", files: [] },
    })
  ).toEqual({
    failed: ["tests/example.test.ts"],
    hidden: ["tests/example.test.ts"],
    unknown: false,
  });
  expect(
    replayAnnotations({
      annotations: [],
      selection: { mode: "full", reason: "fixture", files: [] },
    }).unknown
  ).toBe(true);
});

test("dedicated native job replay uses the same input and host gates", () => {
  expect(
    replayJobAdmitted({
      name: "Candidate core (macos-latest)",
      changed: ["packages/runtime-core/src/main.rs"],
    })
  ).toBe(true);
  expect(
    replayJobAdmitted({
      name: "Candidate core (macos-latest)",
      changed: ["src/lib/cli-result.ts"],
    })
  ).toBe(false);
  expect(
    replayJobAdmitted({
      name: "Config compiler (ubuntu-latest)",
      changed: ["src/lib/cli-result.ts"],
    })
  ).toBe(true);
  expect(
    replayJobAdmitted({
      name: "Config compiler (macos-15-intel)",
      changed: ["src/lib/cli-result.ts"],
    })
  ).toBe(false);
  expect(
    replayJobAdmitted({
      name: "Config compiler (macos-15-intel)",
      changed: ["packages/config-compiler/src/lib.rs"],
    })
  ).toBe(true);
  expect(
    replayJobAdmitted({
      name: "linux-process-lifetime",
      changed: ["src/lib/cli-result.ts"],
    })
  ).toBe(true);
});

test("merged history follows merge time and pages past recently edited older PRs", () => {
  const row = (number: number, merged: string | null, updated: string) => ({
    number,
    merged_at: merged,
    updated_at: updated,
    head: { ref: `topic-${number}` },
    merge_commit_sha: "a".repeat(40),
    created_at: "2026-01-01T00:00:00Z",
    labels: [],
  });
  const edited = Array.from({ length: 100 }, (_, index) =>
    row(index + 1, "2026-01-02T00:00:00Z", "2026-03-02T00:00:00Z")
  );
  const calls: string[] = [];
  const result = recentMergedPullRequests({
    repository: "owner/repo",
    count: 1,
    read: (path) => {
      calls.push(path);
      return calls.length === 1
        ? edited
        : [row(101, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")];
    },
  });
  expect(result[0]?.number).toBe(101);
  expect(calls).toHaveLength(2);
  expect(() =>
    recentMergedPullRequests({
      repository: "owner/repo",
      count: 1,
      read: () => [],
    })
  ).toThrow("insufficient");
});

test("replay detects a hidden failure rather than treating missing tests as a pass", () => {
  const log =
    "2026-01-01T00:00:00Z [test shard 1/8 macos 1/3] (1/2) FAIL tests/example.test.ts in 1s; shard elapsed 1s\n[test shard 1/8] (2/2) PASS tests/other.test.ts in 1s; shard elapsed 2s";
  const result = replayFailures({
    log,
    selection: {
      mode: "selected",
      reason: "fixture",
      files: ["tests/other.test.ts"],
    },
  });
  expect(result).toEqual({
    failed: ["tests/example.test.ts"],
    hidden: ["tests/example.test.ts"],
    unknown: false,
  });
  expect(
    replayFailures({
      log,
      selection: {
        mode: "full",
        reason: "fixture",
        files: ["tests/example.test.ts", "tests/other.test.ts"],
      },
    }).hidden
  ).toEqual([]);
});

test.each([
  "TIMEOUT",
  "FILE-COUNT",
  "DEADLINE",
  "INTERRUPTED",
])("replay treats %s as missing evidence if the file would be omitted", (outcome) => {
  expect(
    replayFailures({
      log: `[test shard 1/8] (1/1) ${outcome} packages/db/tests/example.test.ts in 12m`,
      selection: { mode: "selected", reason: "fixture", files: [] },
    }).hidden
  ).toEqual(["packages/db/tests/example.test.ts"]);
});

test("unattributable failed job output remains inconclusive", () => {
  expect(
    replayFailures({
      log: "job failed before a file result was printed",
      selection: { mode: "full", reason: "fixture", files: [] },
    })
  ).toEqual({ failed: [], hidden: [], unknown: true });
});

test("an assertion before cancellation is attributed to its running file", () => {
  const log =
    "[test shard 1/8] (1/1) start tests/example.test.ts\n(fail) assertion before runner cancellation\n";
  expect(
    replayFailures({
      log,
      selection: { mode: "selected", reason: "fixture", files: [] },
    }).hidden
  ).toEqual(["tests/example.test.ts"]);
  expect(
    replayFailures({
      log: `${log}[test shard 1/8] (1/1) PASS tests/example.test.ts in 1s\n`,
      selection: { mode: "selected", reason: "fixture", files: [] },
    }).failed
  ).toEqual([]);
});

test("git snapshot parser respects UTF-8 byte counts and embedded newlines", () => {
  const oid = "a".repeat(40);
  const source = 'export const message = "λ";\n';
  const output = Buffer.concat([
    Buffer.from(`${oid} blob ${Buffer.byteLength(source)}\n`),
    Buffer.from(source),
    Buffer.from("\n"),
  ]);
  expect(
    parseGitSources({ entries: [{ path: "src/a.ts", oid }], output })
  ).toEqual({ "src/a.ts": source });
  expect(() =>
    parseGitSources({
      entries: [{ path: "src/a.ts", oid }],
      output: output.subarray(0, output.length - 2),
    })
  ).toThrow("incomplete");
});
