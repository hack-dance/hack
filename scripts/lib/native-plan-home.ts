import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";

/**
 * Offline planning may read prepared global files, but must not write state.
 * Failed lifecycle attempts may add only their intentional activity records.
 */
export async function assertNativePlanHome(opts: {
  readonly home: string;
  readonly failedUps: number;
  readonly preparedHackFiles?: readonly string[];
}): Promise<void> {
  const expectedHackFiles = [...(opts.preparedHackFiles ?? [])];
  if (opts.failedUps > 0) {
    expectedHackFiles.push("activity.jsonl");
  }
  const expectedHome = expectedHackFiles.length > 0 ? [".hack"] : [];
  const homeEntries = await readdir(opts.home);
  assertNames(homeEntries, expectedHome);
  if (expectedHackFiles.length === 0) {
    return;
  }
  assertNames(await readdir(join(opts.home, ".hack")), expectedHackFiles);
  if (opts.failedUps === 0) {
    return;
  }
  const text = await Bun.file(join(opts.home, ".hack/activity.jsonl")).text();
  const lines = text.trim().split("\n");
  if (!text.endsWith("\n") || lines.length !== opts.failedUps) {
    throw new Error("Expected one complete activity record per failed up");
  }
  for (const line of lines) {
    const activity: unknown = JSON.parse(line);
    if (
      !isRecord(activity) ||
      activity.action !== "up" ||
      activity.outcome !== "failed" ||
      activity.project !== null
    ) {
      throw new Error("Expected failed unregistered up activity");
    }
  }
}

function assertNames(actual: string[], expected: string[]): void {
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())) {
    throw new Error("Unexpected registry or runtime HOME state");
  }
}
