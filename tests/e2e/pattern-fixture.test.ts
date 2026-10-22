import { describe, expect, test } from "bun:test";
import type { CliResult } from "./harness.ts";
import { partitionContainerInspection } from "./scenarios/pattern-fixture.ts";

const KEPT = "1a2b3c4d5e6f";
const GONE = "307b0e394010";

function inspection(opts: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}): CliResult {
  const stderr = opts.stderr ?? "";
  return {
    command: "docker inspect --type container",
    exitCode: opts.exitCode,
    stdout: opts.stdout,
    stderr,
    combined: `${opts.stdout}${stderr}`,
    timedOut: opts.timedOut ?? false,
    durationMs: 1,
  };
}

const kept = JSON.stringify([{ Id: `${KEPT}${"0".repeat(52)}` }]);

describe("partitionContainerInspection", () => {
  test("keeps every listed container when inspection succeeds", () => {
    const split = partitionContainerInspection({
      ids: [KEPT],
      result: inspection({ exitCode: 0, stdout: kept }),
    });
    expect(split).toEqual({
      resources: [{ Id: `${KEPT}${"0".repeat(52)}` }],
      missing: [],
    });
  });

  test("reports the CI failure shape as a removed container, not an error", () => {
    const split = partitionContainerInspection({
      ids: [GONE],
      result: inspection({
        exitCode: 1,
        stdout: "[]\n",
        stderr: `Error: No such object: ${GONE}\n`,
      }),
    });
    expect(split).toEqual({ resources: [], missing: [GONE] });
  });

  test("keeps survivors when one of several listed containers is removed", () => {
    for (const stderr of [
      `Error response from daemon: No such container: ${GONE}\n`,
      `error: no such object: ${GONE}\n`,
    ]) {
      const split = partitionContainerInspection({
        ids: [KEPT, GONE],
        result: inspection({ exitCode: 1, stdout: kept, stderr }),
      });
      expect(split).toEqual({
        resources: [{ Id: `${KEPT}${"0".repeat(52)}` }],
        missing: [GONE],
      });
    }
  });

  test("rejects failures that are not a removed listed container", () => {
    const failures: CliResult[] = [
      inspection({
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon\n",
      }),
      inspection({
        exitCode: 1,
        stdout: "[]\n",
        stderr: "Error: No such object: ffffffffffff\n",
      }),
      inspection({
        exitCode: 1,
        stdout: "[]\n",
        stderr: `Error: No such object: ${KEPT}\npermission denied\n`,
      }),
      // A listed container silently dropped from stdout is not "removed".
      inspection({ exitCode: 1, stdout: "[]\n" }),
      // Reported missing yet inspected is contradictory.
      inspection({
        exitCode: 1,
        stdout: kept,
        stderr: `Error: No such object: ${KEPT}\n`,
      }),
      // Exit 0 with a missing container, and a timeout, are never accepted.
      inspection({
        exitCode: 0,
        stdout: "[]\n",
        stderr: `Error: No such object: ${KEPT}\n`,
      }),
      inspection({ exitCode: 0, stdout: kept, timedOut: true }),
      inspection({ exitCode: 0, stdout: "{}" }),
    ];
    for (const result of failures) {
      expect(
        partitionContainerInspection({ ids: [KEPT], result })
      ).toHaveProperty("error");
    }
  });
});
