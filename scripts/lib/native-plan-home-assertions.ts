import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";

/** Planning writes no state; refused up attempts may write only their activity journal. */
export async function assertNativePlanHome(opts: {
  readonly home: string;
  readonly failedUpCount: number;
  readonly privateInputs: readonly string[];
  readonly hasGlobalConfig?: boolean;
}): Promise<void> {
  const expected = [
    ...(opts.hasGlobalConfig ? ["hack.config.json"] : []),
    ...(opts.failedUpCount > 0 ? ["activity.jsonl"] : []),
  ].sort();
  const homeEntries = (await readdir(opts.home)).sort();
  check(
    JSON.stringify(homeEntries) ===
      JSON.stringify(expected.length ? [".hack"] : []),
    "unexpected global home state"
  );
  if (expected.length) {
    check(
      JSON.stringify((await readdir(join(opts.home, ".hack"))).sort()) ===
        JSON.stringify(expected),
      "unexpected registry or runtime home state"
    );
  }
  if (opts.failedUpCount === 0) {
    return;
  }
  const journal = await Bun.file(
    join(opts.home, ".hack/activity.jsonl")
  ).text();
  const records: unknown[] = journal
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  check(
    records.length === opts.failedUpCount &&
      records.every(
        (record) =>
          isRecord(record) &&
          record.action === "up" &&
          record.outcome === "failed" &&
          record.project === null
      ) &&
      opts.privateInputs.every((value) => !journal.includes(value)),
    "expected only redacted failed lifecycle activity"
  );
}

function check(condition: boolean, label: string): asserts condition {
  if (!condition) {
    throw new Error(`Native plan home acceptance failed: ${label}`);
  }
}
