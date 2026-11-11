import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("summary command honors the explicit composite outcome even with all PASS lines", async () => {
  const temp = await mkdtemp(join(tmpdir(), "docker-summary-"));
  try {
    await Bun.write(
      join(temp, "docker-e2e.log"),
      "PASS native-config-networks-ingress (1.2s)\n"
    );
    for (const succeeded of ["true", "false"]) {
      const summaryPath = join(temp, `summary-${succeeded}.md`);
      const result = Bun.spawnSync(
        ["bun", resolve(import.meta.dir, "../scripts/docker-e2e-summary.ts")],
        {
          env: {
            ...process.env,
            HACK_E2E_SHARD: "1/6",
            E2E_SUCCEEDED: succeeded,
            E2E_STARTED_AT: String(Date.now() / 1000 - 2),
            RUNNER_TEMP: temp,
            GITHUB_STEP_SUMMARY: summaryPath,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        }
      );
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(summaryPath).text()).toContain(
        `Status: ${succeeded === "true" ? "pass" : "fail"}`
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
