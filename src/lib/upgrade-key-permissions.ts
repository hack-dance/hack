import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  gitIsLocalKeyIgnored,
  gitListTrackedKeyPaths,
  inspectProjectEnvKey,
  resolveEnvKeyCandidates,
} from "./doctor-env-key.ts";
import { readReplaceablePrivateFile } from "./private-file.ts";
import {
  MAX_SNAPSHOT_FILE_BYTES,
  recordUpgradeSnapshotAfter,
  type UpgradeSnapshot,
  type UpgradeSnapshotEntry,
  verifyUpgradeSnapshotRecovery,
} from "./upgrade-snapshot.ts";

/** Only permission-only findings qualify: never create, rotate, chown, move or untrack a key. */
export async function keyPermissionFiles(root: string): Promise<string[]> {
  const candidates = await resolveEnvKeyCandidates({ projectRoot: root });
  const audit = await inspectProjectEnvKey({
    projectRoot: root,
    candidates,
    env: process.env,
    uid: process.getuid?.() ?? null,
    listTrackedKeyPaths: gitListTrackedKeyPaths,
    isLocalKeyIgnored: gitIsLocalKeyIgnored,
  });
  if (
    audit.findings.some(
      (finding) =>
        finding.status !== "ok" && finding.code !== "env-key-weak-permissions"
    )
  ) {
    return [];
  }
  const files: string[] = [];
  for (const candidate of candidates) {
    const info = await lstat(candidate.path).catch(() => null);
    if (info?.isFile() && info.uid === process.getuid?.()) {
      files.push(candidate.path);
    }
  }
  return [...new Set(files)];
}

/** The frozen write set and snapshot guard survive chmod's write-to-record crash window. */
export async function verifyKeyPermissionFiles(input: {
  snapshot: UpgradeSnapshot;
  files: readonly string[];
  output: boolean;
  interrupted: boolean;
}): Promise<boolean> {
  if (
    input.files.length === 0 ||
    !(await verifyUpgradeSnapshotRecovery({
      manifestPath: input.snapshot.manifestPath,
      paths: input.files,
    }))
  ) {
    return false;
  }
  for (const path of input.files) {
    const entry = input.snapshot.manifest.entries.find(
      (item) => item.path === path
    );
    const current = await readReplaceablePrivateFile({
      path,
      directories: [dirname(path)],
      maxBytes: MAX_SNAPSHOT_FILE_BYTES,
      refusal: () => new Error("Unsafe key permission target."),
    }).catch(() => null);
    if (
      !matchesPermissionState({
        entry,
        current,
        output: input.output,
        interrupted: input.interrupted,
      })
    ) {
      return false;
    }
  }
  return true;
}

function matchesPermissionState(input: {
  entry: UpgradeSnapshotEntry | undefined;
  current: Awaited<ReturnType<typeof readReplaceablePrivateFile>>;
  output: boolean;
  interrupted: boolean;
}): boolean {
  const { entry, current } = input;
  if (entry?.before.kind !== "file" || current === null) {
    return false;
  }
  const digest = createHash("sha256").update(current.text).digest("hex");
  if (digest !== entry.before.sha256) {
    return false;
  }
  if (input.output) {
    return current.mode === 0o600;
  }
  if (entry.after !== null) {
    return (
      entry.after.kind === "file" &&
      current.mode === entry.after.mode &&
      digest === entry.after.sha256
    );
  }
  return (
    current.mode === entry.before.mode ||
    (input.interrupted && current.mode === 0o600)
  );
}

/** Hold the original inode through chmod; no key content enters the result or journal. */
export async function applyKeyPermissions(input: {
  snapshot: UpgradeSnapshot;
  files: readonly string[];
  checkpoint?: (boundary: string) => Promise<void>;
}): Promise<"applied" | "unchanged" | "failed"> {
  let changed = false;
  try {
    for (const path of input.files) {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        const entry = input.snapshot.manifest.entries.find(
          (item) => item.path === path
        );
        if (
          entry?.before.kind !== "file" ||
          info.size > MAX_SNAPSHOT_FILE_BYTES
        ) {
          return "failed";
        }
        const digest = createHash("sha256")
          .update(await file.readFile())
          .digest("hex");
        const afterRead = await file.stat();
        const named = await lstat(path);
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          named.dev !== info.dev ||
          named.ino !== info.ino ||
          digest !== entry.before.sha256 ||
          afterRead.size !== info.size ||
          afterRead.mtimeMs !== info.mtimeMs ||
          afterRead.ctimeMs !== info.ctimeMs
        ) {
          return "failed";
        }
        if ((info.mode & 0o7777) !== 0o600) {
          await file.chmod(0o600);
          await file.sync();
          changed = true;
        }
      } finally {
        await file.close();
      }
      await input.checkpoint?.("key-permissions-written");
      if (
        !(await verifyKeyPermissionFiles({
          snapshot: input.snapshot,
          files: [path],
          output: true,
          interrupted: true,
        }))
      ) {
        return "failed";
      }
      if (
        (
          await recordUpgradeSnapshotAfter({
            manifestPath: input.snapshot.manifestPath,
            paths: [path],
          })
        ).status !== "recorded"
      ) {
        return "failed";
      }
    }
    return changed ? "applied" : "unchanged";
  } catch {
    return "failed";
  }
}
