import { expect, test } from "bun:test";
import { shardSummary } from "../scripts/docker-e2e-summary.ts";

test("summary allowlists names and numeric durations, never raw diagnostic text", () => {
  const summary = shardSummary({
    shard: "6/6",
    names: ["init", "doctor", "env-secrets"],
    elapsedSeconds: 125.5,
    succeeded: false,
    log: [
      "PASS init (1.2s)",
      "FAIL doctor (3.4s) — private diagnostic",
      "PASS unknown (99s)",
      "SKIP env-secrets (0s) — private diagnostic",
      "raw environment and filesystem diagnostic",
    ].join("\n"),
  });
  expect(summary).toContain("Duration: 125.5 seconds");
  expect(summary).toContain("| init | 1.2 | pass |");
  expect(summary).toContain("| doctor | 3.4 | fail |");
  expect(summary).toContain("| env-secrets |  | fail |");
  expect(summary).not.toMatch(/private|unknown|environment|filesystem/);
});

test("missing results and setup or cleanup failures cannot report a passing shard", () => {
  for (const [log, succeeded, status] of [
    ["PASS init (1s)", true, "pass"],
    ["PASS init (1s)", false, "fail"],
    ["", true, "fail"],
  ] as const) {
    expect(
      shardSummary({
        shard: "1/4",
        names: ["init"],
        elapsedSeconds: 2,
        log,
        succeeded,
      })
    ).toContain(`Status: ${status}`);
  }
});
