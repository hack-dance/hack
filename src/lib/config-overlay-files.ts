import { lstat } from "node:fs/promises";
import { isRecord } from "./guards.ts";
import { resolveEnvFilePath } from "./hack-env.ts";
import { parseEnvConfigSelection } from "./project.ts";
import {
  resolveProjectEnvConfigPath,
  resolveProjectEnvLocalConfigPath,
} from "./project-env-config.ts";

/** Probe known private filenames directly, including when a directory cannot be listed. */
export async function privateOverlayFilesExist(opts: {
  readonly projectDir: string;
  readonly inheritedDirs: readonly (string | null)[];
  readonly names: readonly string[];
  readonly planned?: Pick<ReadonlySet<string>, "has"> | null;
}): Promise<boolean> {
  const dirs = new Set([
    opts.projectDir,
    ...opts.inheritedDirs.filter((dir) => dir !== null),
  ]);
  for (const envName of opts.names) {
    const selectable = parseEnvConfigSelection(envName) === envName;
    const paths = [
      resolveEnvFilePath({ projectDir: opts.projectDir, envName }),
    ];
    if (selectable) {
      paths.push(
        resolveProjectEnvConfigPath({ projectDir: opts.projectDir, envName })
      );
      for (const projectDir of dirs) {
        paths.push(resolveProjectEnvLocalConfigPath({ projectDir, envName }));
      }
    }
    for (const path of paths) {
      if (
        opts.planned?.has(path) ||
        (await lstat(path).then(
          () => true,
          (error: unknown) => {
            // The legacy migrator discovers dotenv files by filename, including
            // names outside the selector limit that still fit on disk.
            if (
              isRecord(error) &&
              (error.code === "ENOENT" ||
                (!selectable && error.code === "ENAMETOOLONG"))
            ) {
              return false;
            }
            throw error;
          }
        ))
      ) {
        return true;
      }
    }
  }
  return false;
}
