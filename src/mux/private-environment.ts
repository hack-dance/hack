import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { childEnvironment } from "../lib/child-environment.ts";
import {
  livePaths,
  resolveLiveInputScope,
  touchesLiveInput,
} from "../lib/live-inputs.ts";
import { findProjectContext } from "../lib/project.ts";
import type { SecretsHygieneScope } from "../lib/secrets-hygiene.ts";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREFIX = "hack-mux-env-";
const MAX_BYTES = 1024 * 1024;
/**
 * How long a staged payload may wait for its pane. Past this it is refused by
 * the consumer and removed by the next staging (or by the staging process,
 * if it still runs): a session that never runs the command must not leave
 * the values on disk. Generous, because a busy pane runs sent keys late.
 */
export const MUX_ENVIRONMENT_TTL_MS = 10 * 60 * 1000;
// The sweep ages a payload by its directory's mtime, the consumer by the
// file's: both are set within moments of each other at staging. A payload
// whose mtime is in the future (clock skew) never counts as expired.

/** Test seam: told the parent directory of every sweep this process runs. */
export const sweepObserver: { onSweep?: (parent: string) => void } = {};

/**
 * Remove this user's staged payloads older than the TTL from `parent`
 * (normally the temp directory), before a new staging. It uses the doctor's
 * own path: {@link findStaleMuxEnvironments} (private `hack-mux-env-*`
 * directories owned by this user) and {@link removeStaleMuxEnvironment} (the
 * directory found, its own `env.json`, then the directory if empty). Before
 * any removal the current configuration is resolved (strictly) and a
 * directory that is, or holds, a file it reads (a configured store or key,
 * the project or shared key, `hack.config.json`, an env layer) is left
 * alone; when the configuration cannot be read nothing is removed
 * (HACK-2181). Failures are skipped: this is cleanup, never a reason to
 * refuse a new session.
 */
export async function sweepStaleMuxEnvironments(opts: {
  readonly parent?: string;
  readonly now?: number;
  /** The configuration to respect; default: resolved from the working directory. */
  readonly scope?: () => Promise<SecretsHygieneScope>;
}): Promise<void> {
  const parent = opts.parent ?? tmpdir();
  sweepObserver.onSweep?.(parent);
  const stale = await findStaleMuxEnvironments({
    tmpDir: parent,
    now: opts.now,
  }).catch(() => []);
  if (stale.length === 0) {
    return;
  }
  const scope = await (
    opts.scope ??
    (() =>
      resolveLiveInputScope({
        startDir: process.cwd(),
        strict: true,
        findProject: findProjectContext,
      }))
  )().catch(() => null);
  if (scope === null) {
    return;
  }
  const live = await livePaths(scope).catch(() => "unknown" as const);
  for (const entry of stale) {
    if (await touchesLiveInput({ target: entry.root, live })) {
      continue;
    }
    await removeStaleMuxEnvironment(entry).catch(() => false);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** A staged payload directory older than the time limit. */
export type StaleMuxEnvironment = {
  readonly root: string;
  readonly dev: number;
  readonly ino: number;
};

/**
 * Payload directories under `tmpDir` (default: the OS temporary directory)
 * that this user staged and that are older than {@link MUX_ENVIRONMENT_TTL_MS}.
 * The doctor reports these and removes them on `--fix`; staging itself uses
 * {@link sweepStaleMuxEnvironments}. Only
 * private directories with Hack's prefix and owned by this user qualify;
 * nothing is read.
 */
export async function findStaleMuxEnvironments(opts?: {
  readonly tmpDir?: string;
  readonly now?: number;
}): Promise<readonly StaleMuxEnvironment[]> {
  const base = opts?.tmpDir ?? tmpdir();
  const now = opts?.now ?? Date.now();
  const names = await readdir(base).catch(() => [] as string[]);
  const stale: StaleMuxEnvironment[] = [];
  for (const name of names.filter((entry) => entry.startsWith(PREFIX))) {
    const root = join(base, name);
    const info = await lstat(root).catch(() => null);
    if (
      info?.isDirectory() &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o077) === 0 &&
      now - info.mtimeMs >= MUX_ENVIRONMENT_TTL_MS
    ) {
      stale.push({ root, dev: info.dev, ino: info.ino });
    }
  }
  return stale;
}

/**
 * Removes a stale payload directory while it is still the one found: its
 * `env.json` (a regular file of this user's) and then the directory. Anything
 * else inside it is left, and so is the directory.
 */
export async function removeStaleMuxEnvironment(
  stale: StaleMuxEnvironment
): Promise<boolean> {
  const info = await lstat(stale.root).catch(() => null);
  if (
    !info?.isDirectory() ||
    info.dev !== stale.dev ||
    info.ino !== stale.ino
  ) {
    return false;
  }
  const path = join(stale.root, "env.json");
  const file = await lstat(path).catch(() => null);
  if (file?.isFile() && file.uid === process.getuid?.() && file.nlink === 1) {
    await unlink(path).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw error;
      }
    });
  }
  return await rmdir(stale.root).then(
    () => true,
    () => false
  );
}

/** The pane consumes and deletes this one-shot, owner-only payload before spawning. */
export async function stageMuxEnvironment(
  env: Readonly<Record<string, string>>,
  opts?: {
    /** Parent of the payload directory; the OS temporary directory by default. */
    readonly tmpDir?: string;
  }
) {
  const base = opts?.tmpDir ?? tmpdir();
  if (
    Object.entries(env).some(
      ([key, value]) => !KEY.test(key) || value.includes("\0")
    )
  ) {
    throw new Error("Invalid mux environment; values omitted");
  }
  const bytes = JSON.stringify(env);
  if (Buffer.byteLength(bytes) > MAX_BYTES) {
    throw new Error("Mux environment exceeds the private input limit");
  }
  await sweepStaleMuxEnvironments({ parent: base });
  const root = await realpath(await mkdtemp(join(base, PREFIX)));
  const path = join(root, "env.json");
  let identity: { dev: number; ino: number } | undefined;
  const cleanup = async () => {
    const current = await lstat(path).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (current) {
      if (
        !identity ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new Error("Private mux input was replaced; cleanup refused");
      }
      await unlink(path);
    }
    await rmdir(root).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  };
  try {
    const file = await open(path, "wx", 0o600);
    try {
      identity = await file.stat();
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    // Remove it on timeout if this process is still running then; the
    // timer never keeps the process alive.
    setTimeout(() => {
      cleanup().catch(() => undefined);
    }, MUX_ENVIRONMENT_TTL_MS).unref();
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Read only a bounded private payload; never emit values in diagnostics or argv. */
export async function runMuxEnvironment(
  path: string,
  args: readonly string[]
): Promise<number> {
  const root = dirname(path);
  if (
    !isAbsolute(path) ||
    basename(path) !== "env.json" ||
    !basename(root).startsWith(PREFIX)
  ) {
    return 1;
  }
  const parent = await lstat(root);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  ) {
    return 1;
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let value: unknown;
  let identity: { dev: number; ino: number };
  try {
    const info = await file.stat();
    identity = info;
    if (
      !info.isFile() ||
      info.uid !== parent.uid ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_BYTES
    ) {
      return 1;
    }
    if (Date.now() - info.mtimeMs >= MUX_ENVIRONMENT_TTL_MS) {
      // Too old: the values are removed, never used.
      await unlink(path).catch(() => undefined);
      await rmdir(root).catch(() => undefined);
      return 1;
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size || bytesRead > MAX_BYTES) {
      return 1;
    }
    value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 1;
  }
  const env = new Map(Object.entries(process.env));
  for (const [key, entry] of Object.entries(value)) {
    if (!KEY.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      return 1;
    }
    env.set(key, entry);
  }
  const command = applyCommandAssignments({ args, env });
  const current = await lstat(path);
  const currentParent = await lstat(root);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    currentParent.dev !== parent.dev ||
    currentParent.ino !== parent.ino
  ) {
    return 1;
  }
  await unlink(path);
  await rmdir(root);
  if (command.length === 0) {
    return 1;
  }
  return await runInForeground(command, env);
}

/** The terminal signals the whole foreground group, so the command already receives these. */
const TERMINAL_SIGNALS = ["SIGINT", "SIGQUIT"] as const;
/** Signals sent to this launcher alone; the command would have received them under exec. */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/**
 * Stand in for `exec`: the pane shell waits on this launcher, so it stays alive
 * until the command exits, even when the command handles a terminal interrupt,
 * and then reports the command's own status.
 */
async function runInForeground(
  command: readonly string[],
  env: Map<string, string | undefined>
): Promise<number> {
  const ignore = () => undefined;
  for (const signal of TERMINAL_SIGNALS) {
    process.on(signal, ignore);
  }
  const forwards: [NodeJS.Signals, () => void][] = [];
  try {
    const child = Bun.spawn([...command], {
      env: childEnvironment(Object.fromEntries(env)),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    for (const signal of FORWARDED_SIGNALS) {
      const forward = () => child.kill(signal);
      forwards.push([signal, forward]);
      process.on(signal, forward);
    }
    const code = await child.exited;
    if (child.signalCode) {
      return 128 + (osConstants.signals[child.signalCode] ?? 0);
    }
    return code;
  } finally {
    for (const signal of TERMINAL_SIGNALS) {
      process.off(signal, ignore);
    }
    for (const [signal, forward] of forwards) {
      process.off(signal, forward);
    }
  }
}

/** These assignments are authored command text, already tokenized by the pane shell. */
function applyCommandAssignments(opts: {
  readonly args: readonly string[];
  readonly env: Map<string, string | undefined>;
}): readonly string[] {
  let first = 0;
  for (const arg of opts.args) {
    const equals = arg.indexOf("=");
    if (equals < 1 || !KEY.test(arg.slice(0, equals))) {
      break;
    }
    opts.env.set(arg.slice(0, equals), arg.slice(equals + 1));
    first++;
  }
  return opts.args.slice(first);
}
