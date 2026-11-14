import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";

/** Planning stays read-only; subsequent refused lifecycle probes may append only their audit records. */
export async function nativePlanHomeMatches(opts: {
  readonly home: string;
  readonly privateRoot: string;
  readonly failedActions: number;
  readonly existing?: readonly string[];
}): Promise<boolean> {
  const actual = (await readdir(opts.home, { recursive: true })).sort();
  const expected = [...(opts.existing ?? [])];
  if (opts.failedActions > 0) {
    expected.push(".hack", ".hack/activity.jsonl");
  }
  if (
    JSON.stringify(actual) !== JSON.stringify([...new Set(expected)].sort())
  ) {
    return false;
  }
  if (opts.failedActions === 0) {
    return true;
  }
  const text = await readFile(join(opts.home, ".hack/activity.jsonl"), "utf8");
  const entries: unknown[] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return (
    entries.length === opts.failedActions &&
    entries.every(
      (entry) =>
        isRecord(entry) &&
        entry.action === "up" &&
        entry.outcome === "failed" &&
        JSON.stringify(Object.keys(entry).sort()) ===
          JSON.stringify([
            "action",
            "branch",
            "duration_ms",
            "failed_services",
            "origin",
            "outcome",
            "project",
            "ts",
            "v",
          ]) &&
        !JSON.stringify(entry).includes(opts.privateRoot)
    )
  );
}
