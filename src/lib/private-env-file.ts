import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type ReplaceablePrivateFileOptions,
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "./private-file.ts";

/**
 * Plaintext env files under `.hack/` (`.hack/.env` and `.hack/.env.<overlay>`).
 *
 * Ownership: Hack owns these files. They are read without following a symlink
 * and replaced atomically with mode 0600. A symlink or non-regular entry at the
 * file, or a symlinked `.hack` directory, is refused with
 * {@link PRIVATE_ENV_FILE_REFUSAL}; the refusal never names the file, overlay
 * or any value. Ancestors above `.hack` are not inspected.
 */
export const PRIVATE_ENV_FILE_REFUSAL =
  "Refused .hack env file access: the env file or its .hack directory is a symlink or not a regular file. Replace it with a regular file or directory and retry; values omitted.";

function privateEnvFileRefusal(): Error {
  return new Error(PRIVATE_ENV_FILE_REFUSAL);
}

function envFileOptions(envFile: string): ReplaceablePrivateFileOptions {
  return {
    path: envFile,
    directories: [dirname(envFile)],
    refusal: privateEnvFileRefusal,
  };
}

/** Current text, or null when the env file is absent. */
export async function readPrivateEnvFile(opts: {
  readonly envFile: string;
}): Promise<string | null> {
  const current = await readReplaceablePrivateFile(
    envFileOptions(opts.envFile)
  );
  return current?.text ?? null;
}

/**
 * Writes `text` when it differs from the current contents, or when the existing
 * file grants any group/other permission. `changed` reports a content change.
 */
export async function writePrivateEnvFileIfChanged(opts: {
  readonly envFile: string;
  readonly text: string;
}): Promise<{ readonly changed: boolean }> {
  await ensureEnvFileDirectory({ directory: dirname(opts.envFile) });
  const options = envFileOptions(opts.envFile);
  const existing = await readReplaceablePrivateFile(options);
  const changed = existing?.text !== opts.text;
  if (changed || ((existing?.mode ?? 0) & 0o077) !== 0) {
    await replacePrivateFileAtomic({ ...options, text: opts.text });
  }
  return { changed };
}

/** Creates a missing `.hack` directory; an existing entry is left to the refusal checks. */
async function ensureEnvFileDirectory(opts: {
  readonly directory: string;
}): Promise<void> {
  try {
    await lstat(opts.directory);
  } catch (error: unknown) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      throw error;
    }
    await mkdir(opts.directory, { recursive: true });
  }
}
