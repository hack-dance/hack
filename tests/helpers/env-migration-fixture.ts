import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EnvMigrationFileState,
  EnvMigrationSnapshots,
} from "../../src/lib/env-migration-snapshot.ts";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type FixtureManifest = {
  readonly files: readonly (EnvMigrationFileState & {
    readonly payload: string | null;
  })[];
};

/** Synthetic snapshot owner for migration tests; replaced by HACK-2189 in production. */
export function fixtureEnvSnapshots(root: string): EnvMigrationSnapshots {
  const readManifest = async (path: string): Promise<FixtureManifest> =>
    JSON.parse(await readFile(path, "utf8"));
  return {
    capture: async ({ files }) => {
      const dir = join(root, `snapshot-${randomUUID()}`);
      await mkdir(dir, { mode: 0o700 });
      const entries: FixtureManifest["files"][number][] = [];
      for (const [index, file] of files.entries()) {
        const payload =
          file.sha256 === null ? null : join(dir, `${index}.original`);
        if (payload) {
          await writeFile(payload, await readFile(file.path), { mode: 0o600 });
        }
        entries.push({ ...file, payload });
      }
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({ files: entries }), {
        mode: 0o600,
      });
      return { manifestPath };
    },
    assertCoverage: async ({ manifestPath, files }) => {
      const manifest = await readManifest(manifestPath);
      for (const file of files) {
        const stored = manifest.files.find((entry) => entry.path === file.path);
        if (
          !stored ||
          stored.sha256 !== file.sha256 ||
          stored.mode !== file.mode ||
          stored.size !== file.size ||
          (stored.payload &&
            hash(await readFile(stored.payload)) !== file.sha256)
        ) {
          throw new Error("Fixture snapshot coverage failed");
        }
      }
    },
    recordAfter: () => Promise.resolve(),
    rollback: async ({ manifestPath, expectedCurrent }) => {
      const manifest = await readManifest(manifestPath);
      const currentState = async (path: string) => {
        if (!(await Bun.file(path).exists())) {
          return { path, sha256: null, mode: null, size: 0 };
        }
        const bytes = await readFile(path);
        return {
          path,
          sha256: hash(bytes),
          mode: (await lstat(path)).mode & 0o777,
          size: bytes.length,
        };
      };
      const matches = (
        left: EnvMigrationFileState,
        right: EnvMigrationFileState
      ) =>
        left.sha256 === right.sha256 &&
        left.mode === right.mode &&
        left.size === right.size;
      for (const file of expectedCurrent) {
        const original = manifest.files.find(
          (entry) => entry.path === file.path
        );
        const current = await currentState(file.path);
        if (
          !(original && (matches(current, file) || matches(current, original)))
        ) {
          throw new Error("Fixture rollback refuses changed target");
        }
      }
      for (const expected of expectedCurrent) {
        const file = manifest.files.find(
          (entry) => entry.path === expected.path
        );
        if (!file) {
          throw new Error("Fixture snapshot target missing");
        }
        if (matches(await currentState(file.path), file)) {
          continue;
        }
        if (file.payload === null) {
          await rm(file.path, { force: true });
          continue;
        }
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, await readFile(file.payload), {
          mode: file.mode ?? 0o600,
        });
        await chmod(file.path, file.mode ?? 0o600);
      }
      return {
        status: "restored",
        results: manifest.files.map((file) => file.path),
      };
    },
  };
}
