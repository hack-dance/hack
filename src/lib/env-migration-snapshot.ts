import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import {
  assertMigrationStorageOutsideWorkingTrees,
  migrationRefusal,
  readMigrationFile,
  sameMigrationFile,
} from "./env-migration-files.ts";
import { resolveEnvMigrationDataHome } from "./env-migration-home.ts";
import { isRecord } from "./guards.ts";
import {
  createUpgradeSnapshot,
  type defaultUpgradeSnapshotRoot,
  readUpgradeSnapshot,
  recordUpgradeSnapshotAfter,
  restoreUpgradeSnapshot,
  type UpgradeRestoreEntry,
  type UpgradeSnapshotState,
} from "./upgrade-snapshot.ts";

/** Metadata only. An absent path has a null checksum and mode. */
export type EnvMigrationFileState = {
  readonly path: string;
  readonly sha256: string | null;
  readonly mode: number | null;
  readonly size: number;
};

/** Small integration boundary owned by HACK-2189's private snapshot library. */
export type EnvMigrationSnapshots = {
  readonly capture: (input: {
    readonly projectRoot: string;
    readonly files: readonly EnvMigrationFileState[];
  }) => Promise<{ readonly manifestPath: string }>;
  /** Must verify payload checksums, not merely the existence of a manifest. */
  readonly assertCoverage: (input: {
    readonly manifestPath: string;
    readonly files: readonly EnvMigrationFileState[];
  }) => Promise<void>;
  readonly recordAfter: (input: {
    readonly manifestPath: string;
    readonly files: readonly EnvMigrationFileState[];
  }) => Promise<void>;
  readonly rollback: (input: {
    readonly manifestPath: string;
    readonly expectedCurrent: readonly EnvMigrationFileState[];
    readonly preserveChanges?: boolean;
  }) => Promise<{
    readonly status: "restored" | "incomplete";
    readonly results: readonly unknown[];
    readonly preserved?: readonly {
      readonly path: string;
      readonly backupPath: string;
    }[];
  }>;
};

type SnapshotLibrary = {
  readonly createUpgradeSnapshot: typeof createUpgradeSnapshot;
  readonly defaultUpgradeSnapshotRoot: typeof defaultUpgradeSnapshotRoot;
  readonly readUpgradeSnapshot: typeof readUpgradeSnapshot;
  readonly recordUpgradeSnapshotAfter: typeof recordUpgradeSnapshotAfter;
  readonly restoreUpgradeSnapshot: typeof restoreUpgradeSnapshot;
};

/** Static imports keep the production provider in both source and compiled CLI routes. */
export function envMigrationSnapshots(): EnvMigrationSnapshots {
  return bindEnvMigrationSnapshots({
    createUpgradeSnapshot,
    defaultUpgradeSnapshotRoot: () =>
      join(resolveEnvMigrationDataHome(), "upgrade", "snapshots"),
    readUpgradeSnapshot,
    recordUpgradeSnapshotAfter,
    restoreUpgradeSnapshot,
  });
}

function restoreFilesystemRefusal(): ClosedCliError {
  return new ClosedCliError(
    "Env migration needs snapshot storage on the same filesystem and mount as every target, with hard links permitted, so rollback can restore it. Choose a private HACK_HOME on that filesystem outside Git working trees; no migration files were changed (values omitted)."
  );
}

async function removeRestoreProbe(
  path: string,
  identity: Stats
): Promise<void> {
  const current = await lstat(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw restoreFilesystemRefusal();
  }
  await unlink(path);
}

/** Empty, exclusively created probes contain no input bytes and never replace an existing name. */
async function probeRestoreLink(input: {
  readonly snapshotDir: string;
  readonly parent: string;
  readonly linkFile: typeof link;
}): Promise<void> {
  const name = `.hack-env-restore-probe-${randomUUID()}`;
  const source = join(input.snapshotDir, name);
  const destination = join(input.parent, `${name}.link`);
  let identity: Stats | null = null;
  let linked = false;
  try {
    try {
      const handle = await open(source, "wx", 0o600);
      try {
        identity = await handle.stat();
      } finally {
        await handle.close();
      }
      await input.linkFile(source, destination);
      linked = true;
    } finally {
      if (identity) {
        try {
          if (linked) {
            await removeRestoreProbe(destination, identity);
          }
        } finally {
          await removeRestoreProbe(source, identity);
        }
      }
    }
  } catch {
    throw restoreFilesystemRefusal();
  }
}

async function existingRestoreDirectory(path: string): Promise<string> {
  let parent = path;
  for (;;) {
    const info = await stat(parent).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw migrationRefusal();
    });
    if (info) {
      if (!info.isDirectory()) {
        throw restoreFilesystemRefusal();
      }
      return parent;
    }
    parent = dirname(parent);
  }
}

/** Device numbers alone miss distinct bind mounts on the same filesystem. */
async function assertRestoreFilesystem(
  snapshotDir: string,
  files: readonly EnvMigrationFileState[],
  linkFile: typeof link
): Promise<void> {
  const snapshot = await stat(snapshotDir);
  const checked = new Set<string>();
  for (const file of files) {
    let parent = dirname(file.path);
    for (;;) {
      const info = await stat(parent).catch((error: unknown) => {
        if (isRecord(error) && error.code === "ENOENT") {
          return null;
        }
        throw migrationRefusal();
      });
      if (info) {
        if (!info.isDirectory() || info.dev !== snapshot.dev) {
          throw restoreFilesystemRefusal();
        }
        if (!checked.has(parent)) {
          await probeRestoreLink({ snapshotDir, parent, linkFile });
          checked.add(parent);
        }
        break;
      }
      parent = dirname(parent);
    }
  }
}

/** Adapter checks both the snapshot owner's verdict and the journal's exact expectations. */
export function bindEnvMigrationSnapshots(
  library: SnapshotLibrary,
  { linkRestoreProbe = link }: { readonly linkRestoreProbe?: typeof link } = {}
): EnvMigrationSnapshots {
  const load = async (manifestPath: string) => {
    const loaded = await library.readUpgradeSnapshot({ manifestPath });
    if (loaded.status !== "ok") {
      throw migrationRefusal();
    }
    return {
      dir: loaded.snapshot.dir,
      entries: loaded.snapshot.manifest.entries,
    };
  };
  const matches = (
    state: UpgradeSnapshotState,
    expected: EnvMigrationFileState
  ) =>
    expected.sha256 === null
      ? state.kind === "absent"
      : state.kind === "file" &&
        state.sha256 === expected.sha256 &&
        state.size === expected.size &&
        state.mode === expected.mode;
  const verifyCurrent = async (files: readonly EnvMigrationFileState[]) => {
    for (const expected of files) {
      if (
        !sameMigrationFile(
          (await readMigrationFile(expected.path)).state,
          expected
        )
      ) {
        throw migrationRefusal();
      }
    }
  };
  const collectPending = async (
    snapshot: Awaited<ReturnType<typeof load>>,
    expectedCurrent: readonly EnvMigrationFileState[],
    preserveChanges: boolean,
    manifestPath: string
  ) => {
    const pending: EnvMigrationFileState[] = [];
    for (const expected of expectedCurrent) {
      const current = (await readMigrationFile(expected.path)).state;
      const original = snapshot.entries.find(
        (entry) => entry.path === expected.path
      );
      if (original && matches(original.before, current)) {
        continue;
      }
      if (!(sameMigrationFile(current, expected) || preserveChanges)) {
        throw new ClosedCliError(
          `Env rollback refused a changed file: ${JSON.stringify(expected.path)}. Review it, or restore originals while keeping later bytes privately with hack env migrate --rollback-manifest ${JSON.stringify(manifestPath)} --preserve-changes (values omitted).`
        );
      }
      pending.push(preserveChanges ? current : expected);
    }
    return pending;
  };
  return {
    capture: async ({ projectRoot, files }) => {
      const root = resolve(library.defaultUpgradeSnapshotRoot());
      await assertMigrationStorageOutsideWorkingTrees(
        join(root, "manifest.json"),
        {
          projectRoot,
        }
      );
      const existing = await existingRestoreDirectory(root);
      const canonical = resolve(
        await realpath(existing),
        relative(existing, root)
      );
      if (canonical !== root) {
        throw migrationRefusal();
      }
      await assertMigrationStorageOutsideWorkingTrees(
        join(canonical, "manifest.json"),
        { projectRoot }
      );
      // Refuse ordinary storage failures before the provider copies any input
      // bytes. The completed snapshot is checked again by assertCoverage.
      await assertRestoreFilesystem(existing, files, linkRestoreProbe);
      const result = await library.createUpgradeSnapshot({
        root,
        purpose: "env-migration",
        targets: files.map((file) => ({
          path: file.path,
          label: `env migration: ${file.path}`,
        })),
      });
      if (result.status !== "created") {
        throw new ClosedCliError(
          `Snapshot refused for ${projectRoot}; no migration files were changed (values omitted).`
        );
      }
      return { manifestPath: result.snapshot.manifestPath };
    },
    assertCoverage: async ({ manifestPath, files }) => {
      const snapshot = await load(manifestPath);
      await assertRestoreFilesystem(snapshot.dir, files, linkRestoreProbe);
      for (const expected of files) {
        const entry = snapshot.entries.find(
          (candidate) => candidate.path === expected.path
        );
        if (!(entry && matches(entry.before, expected))) {
          throw migrationRefusal();
        }
        if (expected.sha256 !== null) {
          const path = join(snapshot.dir, "blobs", expected.sha256);
          const info = await lstat(path);
          if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
            throw migrationRefusal();
          }
          if (
            (await readMigrationFile(path)).state.sha256 !== expected.sha256
          ) {
            throw migrationRefusal();
          }
        }
      }
    },
    recordAfter: async ({ manifestPath, files }) => {
      await verifyCurrent(files);
      const result = await library.recordUpgradeSnapshotAfter({
        manifestPath,
        paths: files.map((file) => file.path),
      });
      if (result.status !== "recorded") {
        throw migrationRefusal();
      }
      await verifyCurrent(files);
    },
    rollback: async ({ manifestPath, expectedCurrent, preserveChanges }) => {
      const snapshot = await load(manifestPath);
      const pending = await collectPending(
        snapshot,
        expectedCurrent,
        preserveChanges === true,
        manifestPath
      );
      // A killed publication may predate the provider's after receipt; only journal-proven bytes may fill that gap.
      const recorded = await library.recordUpgradeSnapshotAfter({
        manifestPath,
        paths: pending.map((file) => file.path),
      });
      if (recorded.status !== "recorded") {
        throw migrationRefusal();
      }
      const results: UpgradeRestoreEntry[] = [];
      let incomplete = false;
      for (const target of expectedCurrent) {
        const result = await library.restoreUpgradeSnapshot({
          manifestPath,
          paths: [target.path],
          beforeReplace: async (path: string) => {
            const expected = pending.find((file) => file.path === path);
            if (expected) {
              await verifyCurrent([expected]);
            }
          },
        });
        if (result.status === "invalid-manifest") {
          throw migrationRefusal();
        }
        results.push(...result.results);
        if (result.status !== "restored") {
          incomplete = true;
          break;
        }
      }
      const preserved = results.flatMap((result) =>
        result.keptAs !== undefined
          ? [{ path: result.path, backupPath: result.keptAs }]
          : []
      );
      return {
        status: incomplete ? "incomplete" : "restored",
        results,
        preserved,
      };
    },
  };
}
