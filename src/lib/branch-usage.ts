import { resolve } from "node:path";
import type { BranchEntry } from "./branches.ts";
import { ensureDir, readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

/**
 * Machine-local branch usage, kept under `.hack/.internal/` so runtime
 * commands (up/down/restart/run/exec/logs) never write a tracked file.
 *
 * The committed `hack.branches.json` only holds the explicit registry
 * (`hack branch add/remove`). Its legacy `last_used_at` values are read as a
 * fallback and never rewritten by runtime commands. Each checkout (primary or
 * linked worktree) has its own `.hack/.internal/`, so usage is naturally
 * keyed by checkout.
 */

export const BRANCH_USAGE_VERSION = 1 as const;
const BRANCH_USAGE_FILENAME = "branch-usage.json" as const;

export type BranchUsageEntry = {
  readonly last_used_at: string;
};

type BranchUsageFile = {
  readonly version: typeof BRANCH_USAGE_VERSION;
  readonly branches: Readonly<Record<string, BranchUsageEntry>>;
};

export type RecordBranchUsageResult = {
  readonly path: string;
  readonly error?: string;
};

export function resolveBranchUsagePath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, ".internal", BRANCH_USAGE_FILENAME);
}

/** Reads machine-local usage; a missing or corrupt file yields no entries. */
export async function readBranchUsage(opts: {
  readonly projectDir: string;
}): Promise<ReadonlyMap<string, BranchUsageEntry>> {
  const text = await readTextFile(resolveBranchUsagePath(opts));
  if (text === null) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  return parseBranchUsage(parsed);
}

/** Records that a branch instance was just used by a runtime command. */
export async function recordBranchUsage(opts: {
  readonly projectDir: string;
  readonly branch: string;
  readonly nowIso?: string;
}): Promise<RecordBranchUsageResult> {
  const path = resolveBranchUsagePath(opts);
  try {
    const current = await readBranchUsage(opts);
    const next = new Map(current);
    next.set(opts.branch, {
      last_used_at: opts.nowIso ?? new Date().toISOString(),
    });
    await writeBranchUsage({ projectDir: opts.projectDir, usage: next });
    return { path };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, error: message };
  }
}

/** Drops machine-local usage for a branch removed from the registry. */
export async function forgetBranchUsage(opts: {
  readonly projectDir: string;
  readonly branch: string;
}): Promise<void> {
  const current = await readBranchUsage(opts);
  if (!current.has(opts.branch)) {
    return;
  }
  const next = new Map(current);
  next.delete(opts.branch);
  await writeBranchUsage({ projectDir: opts.projectDir, usage: next });
}

/**
 * Overlays machine-local `last_used_at` onto registry entries; legacy
 * tracked values remain as a fallback when this checkout has no record.
 */
export function mergeBranchUsage(opts: {
  readonly branches: readonly BranchEntry[];
  readonly usage: ReadonlyMap<string, BranchUsageEntry>;
}): BranchEntry[] {
  return opts.branches.map((entry) => {
    const local = opts.usage.get(entry.slug);
    return local ? { ...entry, last_used_at: local.last_used_at } : entry;
  });
}

async function writeBranchUsage(opts: {
  readonly projectDir: string;
  readonly usage: ReadonlyMap<string, BranchUsageEntry>;
}): Promise<void> {
  const branches: Record<string, BranchUsageEntry> = {};
  for (const [slug, entry] of [...opts.usage].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    branches[slug] = entry;
  }
  const file: BranchUsageFile = { version: BRANCH_USAGE_VERSION, branches };
  await ensureDir(resolve(opts.projectDir, ".internal"));
  await writeTextFileIfChanged(
    resolveBranchUsagePath(opts),
    `${JSON.stringify(file, null, 2)}\n`
  );
}

function parseBranchUsage(value: unknown): Map<string, BranchUsageEntry> {
  const out = new Map<string, BranchUsageEntry>();
  if (!isRecord(value) || value.version !== BRANCH_USAGE_VERSION) {
    return out;
  }
  const branches = value.branches;
  if (!isRecord(branches)) {
    return out;
  }
  for (const [slug, entry] of Object.entries(branches)) {
    if (!isRecord(entry)) {
      continue;
    }
    const lastUsedAt = getString(entry, "last_used_at");
    if (lastUsedAt) {
      out.set(slug, { last_used_at: lastUsedAt });
    }
  }
  return out;
}
