import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { shardScenarioNames } from "../tests/e2e/run.ts";
import { parseShard } from "../tests/e2e/shard.ts";

/** Publish only known scenario names, numeric durations and pass/fail statuses.
 * Raw diagnostics and failure reasons never cross into the job summary.
 * Missing/skipped outcomes fail closed; explicit step outcomes cover cleanup.
 */
export function shardSummary(opts: {
  readonly shard: string;
  readonly names: readonly string[];
  readonly log: string;
  readonly elapsedSeconds: number;
  readonly succeeded: boolean;
}): string {
  if (!(parseShard(opts.shard) && Number.isFinite(opts.elapsedSeconds))) {
    throw new Error("Invalid shard summary timing or selection");
  }
  const results = new Map<string, { seconds: string; passed: boolean }>();
  for (const line of opts.log.split("\n")) {
    const match = /^(PASS|FAIL) +([a-z0-9-]+) \(([0-9]+(?:\.[0-9]+)?)s\)/.exec(
      line
    );
    if (match && opts.names.includes(match[2] ?? "")) {
      results.set(match[2] ?? "", {
        seconds: match[3] ?? "0",
        passed: match[1] === "PASS",
      });
    }
  }
  const passed =
    opts.succeeded && opts.names.every((name) => results.get(name)?.passed);
  const rows = opts.names.map((name) => {
    // Names are the checked-in scenario registry, never log-derived text.
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new Error("Invalid scenario name");
    }
    const result = results.get(name);
    return `| ${name} | ${result?.seconds ?? ""} | ${result?.passed ? "pass" : "fail"} |`;
  });
  return [
    `### Shard ${opts.shard}`,
    "",
    `Duration: ${Math.max(0, opts.elapsedSeconds).toFixed(1)} seconds`,
    `Status: ${passed ? "pass" : "fail"}`,
    "",
    "| Scenario | Duration (seconds) | Status |",
    "| --- | ---: | --- |",
    ...rows,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const shard = process.env.HACK_E2E_SHARD ?? "";
  const selection = parseShard(shard);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const temp = process.env.RUNNER_TEMP;
  const started = Number(process.env.E2E_STARTED_AT);
  if (!(selection && summaryPath && temp && Number.isFinite(started))) {
    throw new Error("Missing shard summary inputs");
  }
  const log = Bun.file(join(temp, "docker-e2e.log"));
  await appendFile(
    summaryPath,
    shardSummary({
      shard,
      names: shardScenarioNames(selection),
      log: (await log.exists()) ? await log.text() : "",
      elapsedSeconds: Date.now() / 1000 - started,
      succeeded: process.env.E2E_SUCCEEDED === "true",
    })
  );
}
