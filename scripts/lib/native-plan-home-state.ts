import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";

/** Exact offline fixture state: planning writes nothing; failed up may add private activity only. */
export async function nativePlanHomeMatches(opts: {
  readonly home: string;
  readonly activityCount: number;
  readonly existingConfig?: boolean;
  readonly privateValues: readonly string[];
}): Promise<boolean> {
  try {
    const entries = await readdir(opts.home);
    if (opts.activityCount === 0 && !opts.existingConfig) {
      return entries.length === 0;
    }
    if (entries.length !== 1 || entries[0] !== ".hack") {
      return false;
    }
    const hackHome = join(opts.home, ".hack");
    const directory = await lstat(hackHome);
    if (!directory.isDirectory() || (directory.mode & 0o022) !== 0) {
      return false;
    }
    const expected = [
      ...(opts.existingConfig ? ["hack.config.json"] : []),
      ...(opts.activityCount > 0 ? ["activity.jsonl"] : []),
    ].sort();
    const actual = (await readdir(hackHome)).sort();
    if (actual.join("\n") !== expected.join("\n")) {
      return false;
    }
    if (opts.activityCount === 0) {
      return true;
    }
    const path = join(hackHome, "activity.jsonl");
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 65_536) {
      return false;
    }
    const text = await Bun.file(path).text();
    if (
      opts.privateValues.some(
        (value) => value.length > 0 && text.includes(value)
      )
    ) {
      return false;
    }
    const records: unknown[] = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return (
      records.length === opts.activityCount &&
      records.every(
        (entry) =>
          isRecord(entry) && entry.action === "up" && entry.outcome === "failed"
      )
    );
  } catch {
    return false;
  }
}
