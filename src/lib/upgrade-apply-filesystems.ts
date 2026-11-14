import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import type { Planned } from "./upgrade-apply.ts";

const OTHER_FILESYSTEM =
  "Not run: the checkout and snapshot are on different filesystems. Rerun with --project <name> --snapshot-root <private directory on that volume, outside every Git working tree>, or run the checkout's manual fix.";
const UNKNOWN_FILESYSTEM =
  "Not run: the target or snapshot filesystem could not be checked; inspect its directory permissions before retrying.";

/** Read-only: nonexistent snapshot roots are checked through their nearest existing parent. */
export async function upgradeFilesystemDevice(path: string): Promise<number> {
  let current = resolve(path);
  for (;;) {
    try {
      return (await stat(current)).dev;
    } catch (error: unknown) {
      const parent = dirname(current);
      if (!isRecord(error) || error.code !== "ENOENT" || parent === current) {
        throw new Error("The upgrade filesystem could not be checked.");
      }
      current = parent;
    }
  }
}

/** Skip unsupported recovery layouts before creating the snapshot or writing a journal. */
export async function planUpgradeFilesystems(opts: {
  targets: readonly Planned[];
  snapshotRoot: string;
  files: (target: Planned) => Promise<readonly string[]>;
  device?: (path: string) => Promise<number>;
}): Promise<Planned[]> {
  const device = opts.device ?? upgradeFilesystemDevice;
  const snapshotDevice = await device(opts.snapshotRoot).catch(() => null);
  return await Promise.all(
    opts.targets.map(async (target) => {
      if (target.skip !== null) {
        return target;
      }
      try {
        if (snapshotDevice === null) {
          throw new Error("Unknown snapshot filesystem.");
        }
        const files = await opts.files(target);
        const paths =
          files.length === 0 ? [target.projectDir ?? target.root] : files;
        for (const path of paths) {
          if ((await device(path)) !== snapshotDevice) {
            return {
              ...target,
              skip: OTHER_FILESYSTEM,
              skipReason: "other-filesystem" as const,
            };
          }
        }
        return { ...target, files };
      } catch {
        return {
          ...target,
          skip: UNKNOWN_FILESYSTEM,
          skipReason: "filesystem-unknown" as const,
        };
      }
    })
  );
}

export function hasOtherFilesystem(targets: readonly Planned[]): boolean {
  return targets.some((target) => target.skipReason === "other-filesystem");
}
