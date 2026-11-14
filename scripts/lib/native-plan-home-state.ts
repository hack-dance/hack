import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";

const ACTIVITY_FIELDS = new Set([
  "v",
  "ts",
  "project",
  "branch",
  "action",
  "origin",
  "outcome",
  "failed_services",
  "duration_ms",
]);

/** Fingerprint a private acceptance HOME, including modes, without retaining values. */
export async function snapshotNativePlanHome(
  home: string
): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  for (const name of (await readdir(home, { recursive: true })).sort()) {
    const path = join(home, name);
    const info = await lstat(path);
    if (!(info.isFile() || info.isDirectory()) || info.isSymbolicLink()) {
      throw new Error("Native plan fixture HOME contains an unexpected entry");
    }
    const digest = info.isFile()
      ? new Bun.CryptoHasher("sha256")
          .update(await readFile(path))
          .digest("hex")
      : "directory";
    result.set(name, `${info.mode}:${digest}`);
  }
  return result;
}

/** Admit exactly the failed lifecycle records added after read-only planning. */
export async function assertNativePlanRefusalActivity(opts: {
  readonly home: string;
  readonly before: ReadonlyMap<string, string>;
  readonly attempts: number;
  readonly sentinel: string;
  readonly fixtureRoot: string;
}): Promise<void> {
  const name = ".hack/activity.jsonl";
  const path = join(opts.home, name);
  const after = new Map(await snapshotNativePlanHome(opts.home));
  const activity = await readFile(path, "utf8");
  let records: unknown[];
  try {
    records = activity
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  } catch {
    throw new Error(
      "Native plan fixture activity is malformed; values omitted"
    );
  }
  after.delete(name);
  if (!opts.before.has(".hack")) {
    after.delete(".hack");
  }
  if (
    opts.before.has(name) ||
    after.size !== opts.before.size ||
    [...opts.before].some(([entry, state]) => after.get(entry) !== state) ||
    ((await lstat(path)).mode & 0o077) !== 0 ||
    (!opts.before.has(".hack") &&
      ((await lstat(join(opts.home, ".hack"))).mode & 0o077) !== 0) ||
    records.length !== opts.attempts ||
    records.some(
      (entry) =>
        !isRecord(entry) ||
        Object.keys(entry).some((field) => !ACTIVITY_FIELDS.has(field)) ||
        entry.v !== 1 ||
        entry.action !== "up" ||
        entry.outcome !== "failed"
    ) ||
    activity.includes(opts.sentinel) ||
    activity.includes(opts.fixtureRoot)
  ) {
    throw new Error(
      "Native plan startup refusal changed HOME beyond private value-free failure activity"
    );
  }
}
