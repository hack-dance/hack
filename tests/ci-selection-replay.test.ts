import { expect, test } from "bun:test";
import {
  parseGitSources,
  recentMergedPullRequests,
  replayAnnotations,
  replayCheckoutRevision,
  replayFailures,
  replayJobAdmitted,
  replayPlantedFailure,
  replayPlantOutcome,
  replayReadCommand,
} from "../scripts/ci-selection-replay.ts";
import { selectTests } from "../scripts/ci-test-selection.ts";

test.each([
  "HTTP 502: Bad Gateway",
  "HTTP 503",
  "HTTP 504",
  "TLS handshake timeout",
  "i/o timeout",
])("transient historical reads retry within a fixed bound: %s", (error) => {
  let attempts = 0;
  expect(
    replayReadCommand({
      args: ["gh", "api", "fixture"],
      run: () => {
        attempts++;
        return {
          exitCode: attempts === 2 ? 0 : 1,
          stdout: Buffer.from("evidence"),
          stderr: Buffer.from(error),
        };
      },
    })
  ).toBe("evidence");
  expect(attempts).toBe(2);
});
test.each([
  "HTTP 401",
  "HTTP 403 rate limit",
  "HTTP 404",
  "refusing terminal escape sequences; use --allow-escape-sequences",
  "HTTP 403: timed out",
  "refusing command after timed out read",
])("auth, quota, missing evidence and output guards are never retried: %s", (error) => {
  let attempts = 0;
  expect(() =>
    replayReadCommand({
      args: ["gh", "api", "fixture"],
      run: () => {
        attempts++;
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(error),
        };
      },
    })
  ).toThrow("non-transient read failure; 1 attempt(s)");
  expect(attempts).toBe(1);
});
test("timed-out reads exhaust three attempts and preserve a failure verdict", () => {
  let attempts = 0;
  expect(() =>
    replayReadCommand({
      args: ["gh", "api", "fixture"],
      run: () => {
        attempts++;
        return {
          exitCode: 1,
          signalCode: "SIGTERM",
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
        };
      },
    })
  ).toThrow("transient read exhausted; 3 attempt(s)");
  expect(attempts).toBe(3);
});
test("local Git errors are not retried as network reads", () => {
  let attempts = 0;
  expect(() =>
    replayReadCommand({
      args: ["git", "show", "fixture"],
      run: () => {
        attempts++;
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("timed out"),
        };
      },
    })
  ).toThrow("1 attempt(s)");
  expect(attempts).toBe(1);
});

test("planted failures edit a transitive source dependency, and direct-test-only selection is rejected", () => {
  const inputs = {
    repoRoot: "/snapshot",
    sources: {
      "src/leaf.ts": "export const value = 1;",
      "src/barrel.ts": 'export * from "./leaf.ts";',
      "tests/a.test.ts": 'import {value} from "../src/barrel.ts";',
      "tests/b.test.ts": "export {};",
    },
    tests: ["tests/a.test.ts", "tests/b.test.ts"],
    changed: ["docs/a.md"],
  };
  const selection = selectTests(inputs);
  expect(replayPlantedFailure({ inputs, selection })).toMatchObject({
    file: "tests/a.test.ts",
    edited: "src/leaf.ts",
    depth: 2,
    kind: "dependency",
    previouslySelected: false,
    covered: true,
    mode: "selected",
  });
  expect(
    replayPlantedFailure({
      inputs,
      selection,
      select: (counterfactual) => {
        expect(counterfactual.changed).toEqual(["docs/a.md", "src/leaf.ts"]);
        expect(counterfactual.sources?.["tests/a.test.ts"]).toBe(
          inputs.sources["tests/a.test.ts"]
        );
        return {
          mode: "selected",
          reason:
            "broken selector keeps direct test changes but drops import edges",
          files: inputs.tests.filter((file) =>
            counterfactual.changed?.includes(file)
          ),
        };
      },
    })
  ).toMatchObject({ covered: false, hidden: ["tests/a.test.ts"] });
  const full = selectTests({ ...inputs, full: true });
  expect(
    replayPlantedFailure({ inputs: { ...inputs, full: true }, selection: full })
  ).toMatchObject({
    previouslySelected: true,
    kind: "full-fallback",
    mode: "full",
    covered: true,
  });
});
test("planted dependency evidence refuses a subset with no runtime source witness", () => {
  const inputs = {
    repoRoot: "/snapshot",
    sources: {
      "src/types.ts": "export type Value = number;",
      "tests/a.test.ts": 'import type {Value} from "../src/types.ts";',
    },
    tests: ["tests/a.test.ts"],
    changed: ["docs/a.md"],
  };
  expect(() =>
    replayPlantedFailure({ inputs, selection: selectTests(inputs) })
  ).toThrow("subset has no omitted test with a source dependency witness");
  expect(
    replayPlantOutcome({ inputs, selection: selectTests(inputs) })
  ).toEqual({
    planted: undefined,
    unknown: ["no usable planted-failure source witness"],
  });
});
test("the package replay entry point preserves flags and the pinned runtime gate", async () => {
  const manifest = await Bun.file(
    new URL("../package.json", import.meta.url)
  ).json();
  expect(manifest.scripts["ci:selection-replay"]).toBe(
    "bun run check:bun-version && bun scripts/ci-selection-replay.ts"
  );
});

test("historical failure selection uses the tested merge tree, including tests added on the base", () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  const log = [
    `2026-01-01T00:00:00Z fetching PR head ${head}`,
    "2026-01-01T00:00:01Z [command]/usr/bin/git log -1 --format=%H",
    `2026-01-01T00:00:01Z ${merge}`,
    "2026-01-01T00:00:02Z tests/provider.test.ts:",
    "2026-01-01T00:00:02Z (fail) provider source contract",
  ].join("\n");
  const sources = {
    "tests/provider.test.ts": 'Bun.file("packages/runtime/source.rs");',
  };
  expect(replayCheckoutRevision({ log })).toBe(merge);
  const snapshots = { [head]: {}, [merge]: sources };
  const revision = replayCheckoutRevision({ log });
  if (!revision) {
    throw new Error("missing tested checkout");
  }
  const selection = selectTests({
    repoRoot: "/snapshot",
    sources: snapshots[revision] ?? {},
    tests: Object.keys(snapshots[revision] ?? {}),
    changed: ["docs/example.md"],
  });
  expect(replayFailures({ log, selection }).hidden).toEqual([]);
  expect(
    replayFailures({
      log,
      selection: {
        mode: "selected",
        reason: "PR head omits base tests",
        files: [],
      },
    }).hidden
  ).toEqual(["tests/provider.test.ts"]);
});

test("missing, truncated or ambiguous checkout revision evidence is not inferred from a PR head", () => {
  const command = "[command]/usr/bin/git log -1 --format=%H";
  for (const log of [
    "no checkout log",
    command,
    `${command}\nnot a revision`,
    `${command}\n${"a".repeat(40)}\n${command}\n${"b".repeat(40)}`,
  ]) {
    expect(replayCheckoutRevision({ log })).toBeNull();
  }
});

test("Bun focused output attributes each file, while runner frames retain workspace paths", () => {
  const selection = { mode: "selected" as const, reason: "fixture", files: [] };
  expect(
    replayFailures({
      selection,
      log: "tests/first.test.ts:\n(fail) first\ntests/second.test.ts:\n(fail) second",
    }).failed
  ).toEqual(["tests/first.test.ts", "tests/second.test.ts"]);
  expect(
    replayFailures({
      selection,
      log: "[test shard 1/8] (1/1) start packages/db/tests/example.test.ts\ntests/example.test.ts:\n(fail) assertion",
    }).failed
  ).toEqual(["packages/db/tests/example.test.ts"]);
});

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
  for (const name of [
    "Candidate core (macos-latest)",
    "Config compiler (macos-15-intel)",
  ]) {
    expect(
      replayJobAdmitted({ name, changed: ["src/lib/cli-result.ts"] })
    ).toBe(true);
  }
  expect(
    replayJobAdmitted({
      name: "Candidate core (macos-latest)",
      changed: ["packages/runtime-core/src/main.rs"],
    })
  ).toBe(true);
  expect(
    replayJobAdmitted({
      name: "Candidate core (macos-latest)",
      changed: ["src/lib/value.ts"],
    })
  ).toBe(false);
  expect(
    replayJobAdmitted({
      name: "Config compiler (ubuntu-latest)",
      changed: ["src/lib/value.ts"],
    })
  ).toBe(true);
  expect(
    replayJobAdmitted({
      name: "Config compiler (macos-15-intel)",
      changed: ["src/lib/value.ts"],
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
      changed: ["src/lib/value.ts"],
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
test("unattributed assertions stay inconclusive rather than becoming absent failures", () => {
  const result = replayFailures({
    log: "(fail) assertion with no running-file marker",
    selection: { mode: "selected", reason: "fixture", files: [] },
  });
  expect(result.unknown).toBe(true);
  expect(result.unattributedFailure).toBe(true);
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
