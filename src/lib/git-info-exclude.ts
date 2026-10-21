import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { HACK_DIR_GITIGNORE_ENTRIES } from "../templates.ts";
import { logger } from "../ui/logger.ts";
import { mergeManagedGitignoreBlock } from "./fs.ts";
import { exec } from "./shell.ts";

/**
 * Keeps Hack's machine-local generated files (`.internal/`, `.branch/`, env
 * state and local overlays under the project dir) out of `git status` without
 * writing into the user's working tree.
 *
 * Lifecycle commands (`up`, `down`, `restart`, `run`, `exec`, ...) call this
 * instead of writing `.hack/.gitignore`, which only `hack init` and
 * `hack doctor --fix` create. The rules go into the repository's
 * `info/exclude`, resolved through `git rev-parse --git-common-dir` so one
 * block covers the primary checkout and every linked worktree. Each project
 * dir gets its own marker-delimited block of patterns anchored at the
 * repository root, so several Hack projects in one repository do not
 * overwrite each other and user lines are preserved.
 *
 * Invariants:
 * - Best-effort: any failure (no git, not a repository, unreadable or
 *   symlinked `info/` or `exclude`, write error) is swallowed. The caller's
 *   command never fails or changes behavior because of it.
 * - Value-free: only Hack's fixed ignore patterns are written, and a failure
 *   is logged at debug level by error code only.
 * - No-follow: a symlinked `info/` dir or `exclude` file is left alone; the
 *   new content is written to an exclusive, no-follow temp file in `info/`
 *   and renamed into place, so readers never see a partial file.
 * - Concurrency: two writers can race and one block update can be lost; the
 *   next lifecycle command converges it again. Within a process, the work
 *   runs at most once per project dir.
 */
export async function ensureHackGitInfoExclude(opts: {
  readonly projectDir: string;
}): Promise<void> {
  const key = resolve(opts.projectDir);
  const pending = ensured.get(key);
  if (pending) {
    return await pending;
  }
  const run = ensureUncached(key).catch((error: unknown) => {
    logger.debug({
      message: `Skipped git info/exclude update (${errorCode(error)})`,
    });
  });
  ensured.set(key, run);
  return await run;
}

const ensured = new Map<string, Promise<void>>();

/** Test hook: forget which project dirs were already handled. */
export function resetHackGitInfoExcludeCacheForTests(): void {
  ensured.clear();
}

const LINE_BREAK = /[\r\n]/;
/** Characters with glob meaning in a gitignore pattern. */
const GLOB_SPECIAL = /[\\*?[\]]/g;

/**
 * The managed block for a project dir at `prefix` (its path relative to the
 * repository root, with a trailing slash, as `git rev-parse --show-prefix`
 * prints it). Returns null when the prefix cannot be expressed safely.
 */
export function renderHackGitInfoExcludeBlock(opts: {
  readonly prefix: string;
}): {
  readonly beginMarker: string;
  readonly endMarker: string;
  readonly entries: readonly string[];
} | null {
  if (opts.prefix.length === 0 || LINE_BREAK.test(opts.prefix)) {
    return null;
  }
  const anchor = `/${opts.prefix.endsWith("/") ? opts.prefix : `${opts.prefix}/`}`;
  const escaped = anchor.replace(GLOB_SPECIAL, (char) => `\\${char}`);
  return {
    beginMarker: `# managed by hack — machine-local generated files under ${anchor} (do not edit between markers)`,
    endMarker: `# end managed by hack: ${anchor}`,
    entries: HACK_DIR_GITIGNORE_ENTRIES.map((entry) => `${escaped}${entry}`),
  };
}

async function ensureUncached(projectDir: string): Promise<void> {
  const location = await resolveExcludeLocation({ projectDir });
  if (location === null) {
    return;
  }
  const block = renderHackGitInfoExcludeBlock({ prefix: location.prefix });
  if (block === null) {
    return;
  }

  const infoDir = join(location.commonDir, "info");
  const infoStat = await lstat(infoDir).catch(() => null);
  if (infoStat === null) {
    await mkdir(infoDir, { mode: 0o755 });
  } else if (!infoStat.isDirectory()) {
    return;
  }

  const excludePath = join(infoDir, "exclude");
  const existing = await readNoFollow(excludePath);
  if (existing.kind === "skip") {
    return;
  }
  const current = existing.kind === "text" ? existing.text : null;
  const next = mergeManagedGitignoreBlock({ existing: current, ...block });
  if (next === current) {
    return;
  }
  await replaceNoFollow({
    dir: infoDir,
    path: excludePath,
    text: next,
    mode: existing.kind === "text" ? existing.mode : 0o644,
  });
}

async function resolveExcludeLocation(opts: {
  readonly projectDir: string;
}): Promise<{ readonly commonDir: string; readonly prefix: string } | null> {
  const result = await exec(
    [
      "git",
      "-C",
      opts.projectDir,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--show-prefix",
    ],
    { stdin: "ignore", timeoutMs: 5000 }
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const [commonDir = "", prefix = ""] = result.stdout.split("\n");
  if (!isAbsolute(commonDir)) {
    return null;
  }
  return { commonDir, prefix };
}

type ExistingExclude =
  | { readonly kind: "absent" }
  | { readonly kind: "skip" }
  | { readonly kind: "text"; readonly text: string; readonly mode: number };

async function readNoFollow(path: string): Promise<ExistingExclude> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT"
      ? { kind: "absent" }
      : { kind: "skip" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return { kind: "skip" };
    }
    const text = await handle.readFile({ encoding: "utf8" });
    return { kind: "text", text, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function replaceNoFollow(opts: {
  readonly dir: string;
  readonly path: string;
  readonly text: string;
  readonly mode: number;
}): Promise<void> {
  const temp = join(
    opts.dir,
    `.exclude.hack-${process.pid}-${randomBytes(6).toString("hex")}.tmp`
  );
  const handle = await open(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    opts.mode
  );
  try {
    try {
      await handle.writeFile(opts.text, { encoding: "utf8" });
      await handle.chmod(opts.mode);
    } finally {
      await handle.close();
    }
    await rename(temp, opts.path);
  } catch (error: unknown) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "error";
}
