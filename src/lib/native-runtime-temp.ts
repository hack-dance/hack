import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Private request directories may become runtime state and must use a physical path. */
export async function nativeRuntimeTempDirectory(
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await realpath(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
