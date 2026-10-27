import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  runTlaSequence,
  validateTlaChecks,
} from "../scripts/check-tla-models.ts";
import type { TlaCheck } from "../scripts/lib/tla-checks.ts";
import {
  type TlaExpectation,
  verifyTlaResult,
} from "../scripts/lib/tla-result.ts";
import {
  resolveTlaJar,
  runTlaProcess,
  verifyTlaChecksum,
  withTlaScratch,
} from "../scripts/lib/tla-toolchain.ts";

function message(code: number, severity: number, body: string): string {
  return `@!@!@STARTMSG ${code}:${severity} @!@!@\n${body}\n@!@!@ENDMSG ${code} @!@!@\n`;
}

const finished = message(2186, 0, "Finished in 00s");
const completed =
  message(2193, 0, "Model checking completed. No error has been found.") +
  message(
    2199,
    0,
    "7 states generated, 5 distinct states found, 0 states left on queue."
  ) +
  finished;
const invariant =
  message(2110, 1, "Invariant Guarded is violated.") +
  message(2121, 1, "The behavior up to this point is:") +
  finished;
const temporal =
  "Temporal property Progress was violated.\n" +
  message(2116, 1, "Temporal properties were violated.") +
  message(2264, 1, "The following behavior constitutes a counter-example:") +
  finished;

describe("strict TLC results", () => {
  test("accepts a complete nonempty baseline with exit zero", () => {
    expect(
      verifyTlaResult({
        exitCode: 0,
        output: completed,
        expected: { kind: "pass" },
      })
    ).toBe(true);
    expect(
      verifyTlaResult({
        exitCode: 0,
        output: completed.replaceAll("5 distinct", "0 distinct"),
        expected: { kind: "pass" },
      })
    ).toBe(false);
  });

  test("requires completion, an empty queue, and a successful exit", () => {
    for (const output of [
      "",
      completed.replace(finished, ""),
      completed.replace("0 states left", "1 states left"),
    ]) {
      expect(
        verifyTlaResult({ exitCode: 0, output, expected: { kind: "pass" } })
      ).toBe(false);
    }
    expect(
      verifyTlaResult({
        exitCode: 12,
        output: completed,
        expected: { kind: "pass" },
      })
    ).toBe(false);
  });

  test("accepts only exit 12 and the exact named invariant", () => {
    const expected: TlaExpectation = { kind: "invariant", property: "Guarded" };
    expect(verifyTlaResult({ exitCode: 12, output: invariant, expected })).toBe(
      true
    );
    for (const exitCode of [0, 1, 11, 13, 124, null]) {
      expect(verifyTlaResult({ exitCode, output: invariant, expected })).toBe(
        false
      );
    }
    expect(
      verifyTlaResult({
        exitCode: 12,
        output: invariant.replace("Guarded", "GuardedExtra"),
        expected,
      })
    ).toBe(false);
  });

  test("accepts only exit 13 and an instrumented exact temporal violation", () => {
    const expected: TlaExpectation = { kind: "temporal", property: "Progress" };
    expect(verifyTlaResult({ exitCode: 13, output: temporal, expected })).toBe(
      true
    );
    for (const output of [
      temporal.replace("Temporal property Progress was violated.\n", ""),
      temporal.replace("Progress", "OtherProgress"),
      `Temporal property Progress was violated.\n${finished}`,
      `${temporal}Temporal property Other was violated.\n`,
    ]) {
      expect(verifyTlaResult({ exitCode: 13, output, expected })).toBe(false);
    }
    expect(verifyTlaResult({ exitCode: 12, output: temporal, expected })).toBe(
      false
    );
  });

  test("rejects extra violations, parse failures, tool bugs, and interrupted processes", () => {
    const expected: TlaExpectation = { kind: "invariant", property: "Guarded" };
    for (const extra of [
      message(2110, 1, "Invariant Other is violated."),
      message(3000, 1, "Parse failure"),
      message(3001, 2, "Internal TLC bug"),
      "*** Errors: 1\n",
      "Exception in thread main\n",
      "Parsing or semantic analysis failed.\n",
      "@!@!@STARTMSG 3000:1 @!@!@\nUnterminated error\n",
    ]) {
      expect(
        verifyTlaResult({ exitCode: 12, output: invariant + extra, expected })
      ).toBe(false);
    }
    expect(
      verifyTlaResult({
        exitCode: 12,
        output: invariant,
        failed: true,
        expected,
      })
    ).toBe(false);
    expect(
      verifyTlaResult({
        exitCode: 0,
        output: completed + message(3000, 1, "Parse failure"),
        expected: { kind: "pass" },
      })
    ).toBe(false);
  });

  test("rejects unexpected passes and diagnostic text embedded in a state", () => {
    expect(
      verifyTlaResult({
        exitCode: 0,
        output: completed,
        expected: { kind: "invariant", property: "Guarded" },
      })
    ).toBe(false);
    expect(
      verifyTlaResult({
        exitCode: 12,
        output:
          message(2217, 4, 'message = "Invariant Guarded is violated."') +
          finished,
        expected: { kind: "invariant", property: "Guarded" },
      })
    ).toBe(false);
  });

  test("accepts CRLF output", () => {
    expect(
      verifyTlaResult({
        exitCode: 12,
        output: invariant.replaceAll("\n", "\r\n"),
        expected: { kind: "invariant", property: "Guarded" },
      })
    ).toBe(true);
  });
});

const passingCheck: TlaCheck = {
  id: "guarded",
  module: "specs/tla/Example.tla",
  baseline: { config: "specs/tla/Guarded.cfg", expected: { kind: "pass" } },
  mutation: {
    config: "specs/tla/mutations/Guarded.cfg",
    expected: { kind: "invariant", property: "Guarded" },
  },
};

describe("TLC orchestration", () => {
  test("rejects empty manifests, duplicate ids, and unsafe or missing mutation paths", () => {
    expect(() => validateTlaChecks([])).toThrow("empty");
    expect(() => validateTlaChecks([passingCheck, passingCheck])).toThrow(
      "duplicate"
    );
    expect(() =>
      validateTlaChecks([{ ...passingCheck, module: "../Example.tla" }])
    ).toThrow("repository-relative");
    expect(() =>
      validateTlaChecks([
        {
          ...passingCheck,
          mutation: {
            ...passingCheck.mutation,
            config: passingCheck.baseline.config,
          },
        },
      ])
    ).toThrow("mutation config");
  });

  test("known findings require a passing reference for the same property", () => {
    const finding = {
      ...passingCheck,
      baseline: {
        ...passingCheck.baseline,
        expected: passingCheck.mutation.expected,
      },
    };
    expect(() => validateTlaChecks([finding])).toThrow("passing reference");
    expect(() =>
      validateTlaChecks([
        {
          ...finding,
          reference: {
            config: "specs/tla/Reference.cfg",
            expected: { kind: "pass" },
          },
          baseline: {
            ...finding.baseline,
            expected: { kind: "invariant", property: "Other" },
          },
        },
      ])
    ).toThrow("same property");
  });

  test("runs actual, reference, extra control, mutation, replays, then restored controls", async () => {
    const events: string[] = [];
    const check: TlaCheck = {
      ...passingCheck,
      baseline: {
        ...passingCheck.baseline,
        expected: passingCheck.mutation.expected,
      },
      reference: {
        config: "specs/tla/Reference.cfg",
        expected: { kind: "pass" },
      },
      controls: [
        { config: "specs/tla/Control.cfg", expected: { kind: "pass" } },
      ],
    };
    await runTlaSequence({
      checks: [check],
      runCheck: async (run) => {
        events.push(`${run.phase}:${run.config}`);
      },
      runReplays: async () => {
        events.push("replays");
      },
    });
    expect(events).toEqual([
      "baseline:specs/tla/Guarded.cfg",
      "baseline control:specs/tla/Reference.cfg",
      "baseline control:specs/tla/Control.cfg",
      "mutation:specs/tla/mutations/Guarded.cfg",
      "replays",
      "restored baseline:specs/tla/Guarded.cfg",
      "restored baseline control:specs/tla/Reference.cfg",
      "restored baseline control:specs/tla/Control.cfg",
    ]);
  });

  test("a rejected mutation prevents a successful combined result", async () => {
    let replayed = false;
    await expect(
      runTlaSequence({
        checks: [passingCheck],
        runCheck: async (run) => {
          if (run.phase === "mutation") {
            throw new Error("wrong violation");
          }
        },
        runReplays: async () => {
          replayed = true;
        },
      })
    ).rejects.toThrow("wrong violation");
    expect(replayed).toBe(false);
  });
});

describe("TLC toolchain", () => {
  test("rejects unknown bytes and preserves a mismatched override", async () => {
    expect(() => verifyTlaChecksum(new ArrayBuffer(0))).toThrow(
      "checksum mismatch"
    );
    await withTlaScratch(async (root) => {
      const jar = resolve(root, "bad.jar");
      await Bun.write(jar, "not the pinned jar");
      await expect(
        resolveTlaJar({ root, override: jar, download: true })
      ).rejects.toThrow("checksum mismatch");
      expect(await Bun.file(jar).text()).toBe("not the pinned jar");
      await expect(resolveTlaJar({ root, download: false })).rejects.toThrow(
        "Missing pinned"
      );
    });
  });

  test("removes scratch directories on both success and rejection", async () => {
    let directory = "";
    await withTlaScratch(async (scratch) => {
      directory = scratch;
      await Bun.write(resolve(scratch, "evidence"), "ok");
    });
    expect(existsSync(directory)).toBe(false);
    await expect(
      withTlaScratch(async (scratch) => {
        directory = scratch;
        throw new Error("rejected");
      })
    ).rejects.toThrow("rejected");
    expect(existsSync(directory)).toBe(false);
  });

  test("subprocess failures and timeouts cannot satisfy a TLC expectation", async () => {
    const result = await runTlaProcess({
      command: [process.execPath, "-e", "process.exit(12)"],
      cwd: import.meta.dir,
    });
    expect(result.exitCode).toBe(12);
    expect(
      verifyTlaResult({
        ...result,
        expected: { kind: "invariant", property: "Guarded" },
      })
    ).toBe(false);
    const timeout = await runTlaProcess({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: import.meta.dir,
      timeoutMs: 100,
    });
    expect(timeout.failed).toBe(true);
    expect(
      verifyTlaResult({
        ...timeout,
        output: invariant,
        expected: { kind: "invariant", property: "Guarded" },
      })
    ).toBe(false);
  });
});
