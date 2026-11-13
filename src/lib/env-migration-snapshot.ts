import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import {
  migrationRefusal,
  readMigrationFile,
  sameMigrationFile,
} from "./env-migration-files.ts";
import { isRecord } from "./guards.ts";

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
  }) => Promise<{
    readonly status: "restored" | "incomplete";
    readonly results: readonly unknown[];
  }>;
};

/** Late binding keeps this unit independent until HACK-2189 lands; replace with a typed static import on integration. */
export async function envMigrationSnapshots(): Promise<EnvMigrationSnapshots> {
  const moduleUrl = new URL("./upgrade-snapshot.ts", import.meta.url).href;
  let library: unknown;
  try {
    library = await import(moduleUrl);
  } catch {
    throw new ClosedCliError(
      "Env migration requires the upgrade snapshot library. Preview is available; no migration files were changed."
    );
  }
  return bindEnvMigrationSnapshots(library);
}

/** Adapter checks both the snapshot owner's verdict and the journal's exact expectations. */
export function bindEnvMigrationSnapshots(
  library: unknown
): EnvMigrationSnapshots {
  if (!isRecord(library)) {
    throw migrationRefusal();
  }
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    const operation = library[name];
    if (typeof operation !== "function") {
      throw migrationRefusal();
    }
    return await Reflect.apply(operation, undefined, [input]);
  };
  const load = async (manifestPath: string) => {
    const loaded = await invoke("readUpgradeSnapshot", { manifestPath });
    if (
      !(
        isRecord(loaded) &&
        loaded.status === "ok" &&
        isRecord(loaded.snapshot) &&
        isRecord(loaded.snapshot.manifest) &&
        Array.isArray(loaded.snapshot.manifest.entries) &&
        typeof loaded.snapshot.dir === "string"
      )
    ) {
      throw migrationRefusal();
    }
    return {
      dir: loaded.snapshot.dir,
      entries: loaded.snapshot.manifest.entries as unknown[],
    };
  };
  const matches = (state: unknown, expected: EnvMigrationFileState) =>
    isRecord(state) &&
    (expected.sha256 === null
      ? state.kind === "absent"
      : state.kind === "file" &&
        state.sha256 === expected.sha256 &&
        state.size === expected.size &&
        state.mode === expected.mode);
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
    expectedCurrent: readonly EnvMigrationFileState[]
  ) => {
    const pending: EnvMigrationFileState[] = [];
    for (const expected of expectedCurrent) {
      const current = (await readMigrationFile(expected.path)).state;
      const original = snapshot.entries.find(
        (entry) => isRecord(entry) && entry.path === expected.path
      );
      if (isRecord(original) && matches(original.before, current)) {
        continue;
      }
      if (!sameMigrationFile(current, expected)) {
        throw migrationRefusal();
      }
      pending.push(expected);
    }
    return pending;
  };
  return {
    capture: async ({ projectRoot, files }) => {
      const result = await invoke("createUpgradeSnapshot", {
        purpose: "env-migration",
        targets: files.map((file) => ({
          path: file.path,
          label: `env migration: ${file.path}`,
        })),
      });
      if (
        !(
          isRecord(result) &&
          result.status === "created" &&
          isRecord(result.snapshot) &&
          typeof result.snapshot.manifestPath === "string"
        )
      ) {
        throw new ClosedCliError(
          `Snapshot refused for ${projectRoot}; no migration files were changed (values omitted).`
        );
      }
      return { manifestPath: result.snapshot.manifestPath };
    },
    assertCoverage: async ({ manifestPath, files }) => {
      const snapshot = await load(manifestPath);
      for (const expected of files) {
        const entry = snapshot.entries.find(
          (candidate) => isRecord(candidate) && candidate.path === expected.path
        );
        if (!(isRecord(entry) && matches(entry.before, expected))) {
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
      const result = await invoke("recordUpgradeSnapshotAfter", {
        manifestPath,
        paths: files.map((file) => file.path),
      });
      if (!(isRecord(result) && result.status === "recorded")) {
        throw migrationRefusal();
      }
      await verifyCurrent(files);
    },
    rollback: async ({ manifestPath, expectedCurrent }) => {
      const snapshot = await load(manifestPath);
      const pending = await collectPending(snapshot, expectedCurrent);
      // A killed publication may predate the provider's after receipt; only journal-proven bytes may fill that gap.
      const recorded = await invoke("recordUpgradeSnapshotAfter", {
        manifestPath,
        paths: pending.map((file) => file.path),
      });
      if (!(isRecord(recorded) && recorded.status === "recorded")) {
        throw migrationRefusal();
      }
      const results: unknown[] = [];
      let incomplete = false;
      for (const target of expectedCurrent) {
        const result = await invoke("restoreUpgradeSnapshot", {
          manifestPath,
          paths: [target.path],
          beforeReplace: async (path: string) => {
            const expected = pending.find((file) => file.path === path);
            if (expected) {
              await verifyCurrent([expected]);
            }
          },
        });
        if (
          !(
            isRecord(result) &&
            (result.status === "restored" || result.status === "incomplete") &&
            Array.isArray(result.results)
          )
        ) {
          throw migrationRefusal();
        }
        results.push(...result.results);
        if (result.status !== "restored") {
          incomplete = true;
          break;
        }
      }
      return { status: incomplete ? "incomplete" : "restored", results };
    },
  };
}
