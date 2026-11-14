import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readReplaceablePrivateFile } from "./private-file.ts";
import { mergeHackDirGitignore } from "./project-env-config.ts";
import type {
  Planned,
  UpgradeApplyJournal,
  UpgradeApplyTarget,
} from "./upgrade-apply.ts";
import { UPGRADE_APPLY_FIXES } from "./upgrade-plan.ts";
import {
  MAX_SNAPSHOT_FILE_BYTES,
  readUpgradeSnapshot,
  readUpgradeSnapshotJournal,
  type UpgradeSnapshot,
  type UpgradeSnapshotState,
  verifyUpgradeSnapshotRecovery,
} from "./upgrade-snapshot.ts";
export const UPGRADE_APPLY_JOURNAL_VERSION = 1;
export const UPGRADE_APPLY_JOURNAL_KIND = "hack-upgrade-apply";

const applyJournalSchema = z.object({
  version: z.literal(UPGRADE_APPLY_JOURNAL_VERSION),
  kind: z.literal(UPGRADE_APPLY_JOURNAL_KIND),
  started_at: z.string(),
  updated_at: z.string(),
  state: z.enum(["applying", "applied", "failed"]),
  cli_version: z.string(),
  filters: z.object({
    only: z.array(z.enum(UPGRADE_APPLY_FIXES)),
    project: z.string().nullable(),
  }),
  snapshot: z.object({
    snapshot_id: z.string(),
    manifest_path: z.string(),
    files: z.number().int().nonnegative(),
    complete: z.boolean(),
    gaps: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  notes: z.array(z.string()),
  targets: z.array(
    z.object({
      fix: z.enum(UPGRADE_APPLY_FIXES),
      root: z.string().refine((path) => resolve(path) === path),
      scope: z.string(),
      project: z.string().nullable(),
      status: z.enum([
        "planned",
        "started",
        "applied",
        "unchanged",
        "skipped",
        "refused",
        "failed",
      ]),
      message: z.string().nullable(),
      backup_manifest: z.string().nullable(),
      reason: z
        .enum(["other-filesystem", "filesystem-unknown"])
        .nullable()
        .optional(),
    })
  ),
});

/** Read only explicit, private recovery points; never infer a run from current findings. */
export async function loadApplyRecovery(
  manifestPath: string
): Promise<{ snapshot: UpgradeSnapshot; journal: UpgradeApplyJournal } | null> {
  const loaded = await readUpgradeSnapshot({ manifestPath });
  const parsed = applyJournalSchema.safeParse(
    await readUpgradeSnapshotJournal({ manifestPath })
  );
  if (loaded.status !== "ok" || !parsed.success) {
    return null;
  }
  const journal = parsed.data;
  const coverage = journal.snapshot;
  const snapshot = loaded.snapshot;
  const keys = journal.targets.map((target) => `${target.fix}\0${target.root}`);
  if (
    coverage.snapshot_id !== snapshot.id ||
    coverage.manifest_path !== snapshot.manifestPath ||
    coverage.files !== snapshot.manifest.entries.length ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  return { snapshot, journal };
}

/**
 * Recovery admits the saved input or the deterministic ignore-rule output.
 * An interrupted agent removal may be absent; it may never become a different file.
 * Hashes are compared in memory; file content never enters the journal.
 */
export async function verifyApplyInput(opts: {
  snapshot: UpgradeSnapshot;
  target: Planned;
  previous: UpgradeApplyTarget | undefined;
}): Promise<"safe" | "conflict"> {
  if (opts.target.fix === "agent-integrations") {
    return await verifyAgentInput(opts);
  }
  if (opts.target.projectDir === null) {
    return "conflict";
  }
  const path = resolve(opts.target.projectDir, ".gitignore");
  if (
    !(await verifyUpgradeSnapshotRecovery({
      manifestPath: opts.snapshot.manifestPath,
      paths: [path],
    }))
  ) {
    return "conflict";
  }
  const entry = opts.snapshot.manifest.entries.find((e) => e.path === path);
  if (entry === undefined) {
    return "conflict";
  }
  try {
    const current = await readApplyState(path);
    if (entry.after !== null) {
      return sameApplyState(current.state, entry.after) ? "safe" : "conflict";
    }
    if (sameApplyState(current.state, entry.before)) {
      return "safe";
    }
    if (opts.previous === undefined || current.state.kind === "absent") {
      return "conflict";
    }
    const original =
      entry.before.kind === "absent"
        ? null
        : await readFile(join(opts.snapshot.dir, "blobs", entry.before.sha256));
    if (
      original !== null &&
      entry.before.kind === "file" &&
      hashBytes(original) !== entry.before.sha256
    ) {
      return "conflict";
    }
    const expected = mergeHackDirGitignore({
      existing: original?.toString("utf8") ?? null,
    });
    const mode = entry.before.kind === "file" ? entry.before.mode : 0o644;
    return current.state.sha256 === hashBytes(Buffer.from(expected)) &&
      current.state.mode === mode
      ? "safe"
      : "conflict";
  } catch {
    return "conflict";
  }
}

export function agentPaths(
  snapshot: UpgradeSnapshot,
  target: Planned
): string[] {
  return snapshot.manifest.entries
    .filter((e) => e.label.startsWith(`agent ${target.root}: `))
    .map((e) => e.path);
}

export async function verifyAgentInput(opts: {
  snapshot: UpgradeSnapshot;
  target: Planned;
  previous?: UpgradeApplyTarget;
}): Promise<"safe" | "conflict"> {
  try {
    const paths = agentPaths(opts.snapshot, opts.target);
    if (
      !(await verifyUpgradeSnapshotRecovery({
        manifestPath: opts.snapshot.manifestPath,
        paths,
      }))
    ) {
      return "conflict";
    }
    for (const path of paths) {
      const entry = opts.snapshot.manifest.entries.find((e) => e.path === path);
      if (entry === undefined) {
        return "conflict";
      }
      const current = await readApplyState(path);
      if (entry.after !== null) {
        if (!sameApplyState(current.state, entry.after)) {
          return "conflict";
        }
        continue;
      }
      if (
        current.state.kind !== "absent" &&
        !sameApplyState(current.state, entry.before)
      ) {
        return "conflict";
      }
    }
    return "safe";
  } catch {
    return "conflict";
  }
}

async function readApplyState(
  path: string
): Promise<{ state: UpgradeSnapshotState }> {
  const file = await readReplaceablePrivateFile({
    path,
    directories: [dirname(path)],
    maxBytes: MAX_SNAPSHOT_FILE_BYTES,
    refusal: () => new Error("Unsafe upgrade target."),
  });
  if (file === null) {
    return { state: { kind: "absent" } };
  }
  const bytes = Buffer.from(file.text);
  return {
    state: {
      kind: "file",
      sha256: hashBytes(bytes),
      size: bytes.length,
      mode: file.mode,
    },
  };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameApplyState(
  a: UpgradeSnapshotState,
  b: UpgradeSnapshotState
): boolean {
  if (a.kind === "absent" || b.kind === "absent") {
    return a.kind === b.kind;
  }
  return a.sha256 === b.sha256 && a.mode === b.mode && a.size === b.size;
}
