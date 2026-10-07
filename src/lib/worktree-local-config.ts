import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { isSlimExecutionMode } from "./execution-mode.ts";
import {
  isLinkedGitWorktree,
  resolveGitPrimaryWorktreeRoot,
} from "./git-worktree.ts";
import { isRecord } from "./guards.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import { readProjectConfig } from "./project.ts";

/** Keep runner exclusions independent of either configuration format's policy parser. */
export function shouldInheritPrimaryLocalInputs(opts: {
  readonly inheritLocal: boolean;
}): boolean {
  return (
    opts.inheritLocal &&
    !isSlimExecutionMode() &&
    !["1", "true"].includes(process.env.CI ?? "")
  );
}

/**
 * Verify both real Git roots and their shared administrative identity before
 * admitting a primary checkout. Without an exact-root .git marker there is no primary;
 * present but unverifiable Git linkage fails closed. This does not parse policy.
 */
export async function resolveVerifiedPrimaryWorktreeRoot(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  try {
    throwIfCancelled(opts.signal);
    const checkoutRoot = await realpath(opts.projectRoot);
    const checkout = await readGitCheckoutIdentity({
      projectRoot: checkoutRoot,
      signal: opts.signal,
    });
    if (!checkout || checkout.gitDir === checkout.commonDir) {
      return null;
    }
    if (
      basename(checkout.commonDir) !== ".git" ||
      dirname(dirname(checkout.gitDir)) !== checkout.commonDir ||
      basename(dirname(checkout.gitDir)) !== "worktrees"
    ) {
      throw worktreeVerificationError();
    }
    const primaryRoot = dirname(checkout.commonDir);
    const primary = await readGitCheckoutIdentity({
      projectRoot: primaryRoot,
      signal: opts.signal,
    });
    if (
      !primary ||
      primary.commonDir !== checkout.commonDir ||
      primary.gitDir !== checkout.commonDir
    ) {
      throw worktreeVerificationError();
    }
    const listing = await readGitInspection({
      projectRoot: checkoutRoot,
      args: ["worktree", "list", "--porcelain", "-z"],
      signal: opts.signal,
    });
    const listedRoots = listing
      ?.split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
    if (
      !(
        listedRoots?.includes(checkoutRoot) && listedRoots.includes(primaryRoot)
      )
    ) {
      throw worktreeVerificationError();
    }
    return primaryRoot;
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw worktreeVerificationError();
  }
}

type GitCheckoutIdentity = {
  readonly gitDir: string;
  readonly commonDir: string;
};

async function readGitCheckoutIdentity(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<GitCheckoutIdentity | null> {
  throwIfCancelled(opts.signal);
  const gitMarker = await lstat(resolve(opts.projectRoot, ".git")).catch(
    (error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw worktreeVerificationError();
    }
  );
  if (!gitMarker) {
    return null;
  }
  if (!(gitMarker.isFile() || gitMarker.isDirectory())) {
    throw worktreeVerificationError();
  }
  const result = await readGitInspection({
    projectRoot: opts.projectRoot,
    args: [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    signal: opts.signal,
  });
  if (result === null) {
    throw worktreeVerificationError();
  }
  const [root, gitDir, commonDir, extra] = result.trimEnd().split("\n");
  if (
    !(root && gitDir && commonDir) ||
    extra !== undefined ||
    ![root, gitDir, commonDir].every(isAbsolute)
  ) {
    throw worktreeVerificationError();
  }
  const realRoot = await realpath(root);
  if (realRoot !== opts.projectRoot) {
    throw worktreeVerificationError();
  }
  const after = await lstat(resolve(opts.projectRoot, ".git"));
  if (
    gitMarker.dev !== after.dev ||
    gitMarker.ino !== after.ino ||
    gitMarker.ctimeMs !== after.ctimeMs
  ) {
    throw worktreeVerificationError();
  }
  return {
    gitDir: await realpath(gitDir),
    commonDir: await realpath(commonDir),
  };
}

/** Ignore caller Git redirection and never surface repository paths or child output. */
async function readGitInspection(opts: {
  readonly projectRoot: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  throwIfCancelled(opts.signal);
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const name of [
    "PATH",
    "HOME",
    "SYSTEMROOT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  try {
    const child = Bun.spawn(["git", "-C", opts.projectRoot, ...opts.args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    let timedOut = false;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, 10_000);
    opts.signal?.addEventListener("abort", cancel, { once: true });
    if (opts.signal?.aborted) {
      cancel();
    }
    try {
      const [output, code] = await Promise.all([
        readGitOutput(child.stdout),
        child.exited,
      ]);
      if (cancelled) {
        throwIfCancelled(opts.signal);
      }
      return code === 0 && !timedOut ? output : null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", cancel);
      if (child.exitCode === null) {
        kill();
      }
      await child.exited;
    }
  } catch (error: unknown) {
    throwIfCancelled(opts.signal);
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    return null;
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Native configuration input acquisition was cancelled."
    );
  }
}

async function readGitOutput(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > 1024 * 1024) {
        throw worktreeVerificationError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function worktreeVerificationError(): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Cannot verify the local configuration Git worktree family; values omitted.",
  });
}

/** Resolve only the matching primary configuration directory; never copy state. */
export async function resolvePrimaryLocalProjectDir(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<string | null> {
  if (!shouldInheritPrimaryLocalInputs({ inheritLocal: true })) {
    return null;
  }
  const name = basename(opts.projectDir);
  if (
    ![".hack", ".dev"].includes(name) ||
    relative(opts.projectRoot, opts.projectDir) !== name
  ) {
    return null;
  }
  const cfg = await readProjectConfig({
    ...opts,
    projectDirName: name === ".dev" ? ".dev" : ".hack",
    composeFile: resolve(opts.projectDir, "docker-compose.yml"),
    envFile: resolve(opts.projectDir, ".env"),
    configFile: resolve(opts.projectDir, "hack.config.json"),
  });
  if (cfg.parseError) {
    throw new Error(
      "Cannot inherit worktree configuration with invalid project config"
    );
  }
  if (
    cfg.worktree?.inheritLocal === false ||
    !(await isLinkedGitWorktree({ repoRoot: opts.projectRoot }))
  ) {
    return null;
  }
  const primary = await resolveGitPrimaryWorktreeRoot({
    repoRoot: opts.projectRoot,
  });
  if (!primary || resolve(primary) === resolve(opts.projectRoot)) {
    return null;
  }
  const candidate = resolve(primary, name);
  try {
    // A symlinked primary configuration must not redirect inheritance elsewhere.
    if (
      (await realpath(candidate)) !== resolve(await realpath(primary), name)
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/** Inherited inputs may not redirect through a file or nested-directory symlink. */
export async function validatePrimaryLocalFile(path: string): Promise<void> {
  try {
    if ((await realpath(path)) !== resolve(path)) {
      throw new Error("Refusing redirected primary local configuration");
    }
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
