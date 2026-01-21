import { dirname, resolve } from "node:path";

import { pathExists } from "./fs.ts";

export function ensureAbsolutePath(pathLike: string, cwd: string): string {
  return resolve(cwd, pathLike);
}

export async function findUp(
  startDir: string,
  predicate: (absoluteDir: string) => Promise<boolean>
): Promise<string | null> {
  let current = resolve(startDir);
  while (true) {
    if (await predicate(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function findUpFile(
  startDir: string,
  relativeFilePath: string
): Promise<string | null> {
  return await findUp(startDir, async (dir) => {
    return await pathExists(resolve(dir, relativeFilePath));
  });
}
