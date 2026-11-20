import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathExists } from "./fs.ts";

/**
 * Where the generated internal Compose override (DNS, `*.hack` host entries,
 * local CA trust) lives: in Hack's home, not in the project.
 *
 * Layout: `<hack home>/compose-overrides/<project key>/<instance>.yml`, where
 * the project key is the project folder name plus a digest of the project's
 * `.hack` path, and the instance is the branch slug or `@base`.
 *
 * Compose resolves relative paths against the project directory (the first
 * `-f` file's folder), never against an override's own folder, and the file
 * sets only absolute mounts, `dns`, `extra_hosts` and environment, so its
 * location does not change the model or the config hash.
 */
const STORE_DIR_NAME = "compose-overrides";

/** Instance name for the base (non-branch) instance; no branch slug has `@`. */
export const BASE_INSTANCE = "@base";

/** The override written by Hack 5.0.0-next.24 and earlier, inside the project. */
export function legacyInternalOverridePath(projectDir: string): string {
  return resolve(projectDir, ".internal", "compose.override.yml");
}

function projectStoreDir(opts: {
  readonly hackHome: string;
  readonly projectDir: string;
}): string {
  const projectDir = resolve(opts.projectDir);
  const digest = createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 16);
  const name = basename(dirname(projectDir)).replace(/[^A-Za-z0-9._-]/g, "_");
  return join(opts.hackHome, STORE_DIR_NAME, `${name}-${digest}`);
}

export function internalOverrideStorePath(opts: {
  readonly hackHome: string;
  readonly projectDir: string;
  readonly branch: string | null;
}): string {
  return join(projectStoreDir(opts), `${opts.branch ?? BASE_INSTANCE}.yml`);
}

/**
 * The override already on disk for an instance, without generating one: the
 * stored file, else the in-project file an older Hack wrote (still read for
 * a project started by that version), else null.
 */
export async function existingInternalOverride(opts: {
  readonly hackHome: string;
  readonly projectDir: string;
  readonly branch: string | null;
}): Promise<string | null> {
  for (const path of [
    internalOverrideStorePath(opts),
    legacyInternalOverridePath(opts.projectDir),
  ]) {
    if (await pathExists(path)) {
      return path;
    }
  }
  return null;
}

/**
 * Every override stored for a project, base instance first, then the
 * in-project file of an older Hack if present.
 */
export async function listInternalOverrides(opts: {
  readonly hackHome: string;
  readonly projectDir: string;
}): Promise<readonly string[]> {
  const dir = projectStoreDir(opts);
  const names = await readdir(dir).catch(() => [] as string[]);
  const stored = names
    .filter((name) => name.endsWith(".yml"))
    // `@base.yml` first: "" sorts before every branch file name.
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((name) => join(dir, name));
  const legacy = legacyInternalOverridePath(opts.projectDir);
  return (await pathExists(legacy)) ? [...stored, legacy] : stored;
}

function sortKey(name: string): string {
  return name === `${BASE_INSTANCE}.yml` ? "" : name;
}
