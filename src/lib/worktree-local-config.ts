import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
} from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import { isSlimExecutionMode } from "./execution-mode.ts";
import { isRecord } from "./guards.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import { readProjectConfig, sanitizeBranchSlug } from "./project.ts";

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

/**
 * Resolve the existing managed-env key owner's Git locations without parsing
 * project policy. Nested projects share repository keys; env-layer inheritance
 * still uses the separate exact-root resolver. Git inspection remains bounded,
 * ignores caller redirection and verifies linked-worktree ownership before use.
 */
export async function resolveVerifiedProjectEnvKeyGitLocation(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly checkoutRoot: string;
  readonly commonDir: string;
  readonly primaryRoot: string | null;
} | null> {
  try {
    throwIfCancelled(opts.signal);
    const projectRoot = await realpath(opts.projectRoot);
    let checkoutRoot = projectRoot;
    for (;;) {
      throwIfCancelled(opts.signal);
      const marker = await lstat(resolve(checkoutRoot, ".git")).catch(
        (error: unknown) => {
          if (isRecord(error) && error.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      );
      if (marker) {
        break;
      }
      const parent = dirname(checkoutRoot);
      if (parent === checkoutRoot) {
        return null;
      }
      checkoutRoot = parent;
    }
    const checkout = await readGitCheckoutIdentity({
      projectRoot: checkoutRoot,
      signal: opts.signal,
    });
    if (!checkout) {
      throw worktreeVerificationError();
    }
    const linkedPrimary = await resolveVerifiedPrimaryWorktreeRoot({
      projectRoot: checkoutRoot,
      signal: opts.signal,
    });
    const primaryRoot =
      linkedPrimary ??
      (checkout.gitDir === checkout.commonDir &&
      checkout.commonDir === resolve(checkoutRoot, ".git") &&
      checkoutRoot !== projectRoot
        ? checkoutRoot
        : null);
    throwIfCancelled(opts.signal);
    return { checkoutRoot, commonDir: checkout.commonDir, primaryRoot };
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw worktreeVerificationError();
  }
}

/** Exact-root Git ownership for a private durable checkout owner; paths never belong in public reports. */
export async function resolveVerifiedGitCheckoutLocation(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly gitDir: string;
  readonly commonDir: string;
  readonly primaryRoot: string | null;
}> {
  let signal: AbortSignal | undefined;
  try {
    const projectRootInput = opts.projectRoot;
    const suppliedSignal = opts.signal;
    if (
      typeof projectRootInput !== "string" ||
      !projectRootInput.length ||
      projectRootInput.includes("\0") ||
      (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal))
    ) {
      throw worktreeVerificationError();
    }
    signal = suppliedSignal;
    throwIfCancelled(signal);
    const projectRoot = resolve(projectRootInput);
    if ((await realpath(projectRoot)) !== projectRoot) {
      throw worktreeVerificationError();
    }
    const before = await readGitCheckoutIdentity({ projectRoot, signal });
    if (!before) {
      throw worktreeVerificationError();
    }
    const primaryRoot = await resolveVerifiedPrimaryWorktreeRoot({
      projectRoot,
      signal,
    });
    const after = await readGitCheckoutIdentity({ projectRoot, signal });
    if (
      !after ||
      before.gitDir !== after.gitDir ||
      before.commonDir !== after.commonDir
    ) {
      throw worktreeVerificationError();
    }
    throwIfCancelled(signal);
    return { ...before, primaryRoot };
  } catch {
    throwIfCancelled(signal);
    throw worktreeVerificationError();
  }
}

/** Derive a read-only linked-worktree namespace under the existing collision convention. */
export async function resolveVerifiedNativeBranch(opts: {
  readonly projectRoot: string;
  readonly autoBranch: boolean;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  throwIfCancelled(opts.signal);
  if (!shouldInheritPrimaryLocalInputs({ inheritLocal: opts.autoBranch })) {
    return undefined;
  }
  const selected = await resolveVerifiedLegacyAdoptionBranch(opts);
  return selected?.branch;
}

/** Bounded, exact-root Git selection for the retained branch owner. */
export async function resolveVerifiedLegacyAdoptionBranch(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly branch: string; readonly gitBranch: string } | null> {
  try {
    throwIfCancelled(opts.signal);
    const projectRoot = resolve(opts.projectRoot);
    if ((await realpath(projectRoot)) !== projectRoot) {
      throw worktreeVerificationError();
    }
    const primary = await resolveVerifiedPrimaryWorktreeRoot({
      projectRoot,
      signal: opts.signal,
    });
    if (primary === null) {
      return null;
    }
    const before = await readGitCheckoutIdentity({
      projectRoot,
      signal: opts.signal,
    });
    if (!before) {
      throw worktreeVerificationError();
    }
    const admin = await lstat(before.gitDir);
    const common = await lstat(before.commonDir);
    const marker = await lstat(resolve(projectRoot, ".git"));
    const read = (args: readonly string[]) =>
      readGitInspection({ projectRoot, args, signal: opts.signal });
    const branch = await read(["symbolic-ref", "--quiet", "HEAD"]);
    const listing = await read(["worktree", "list", "--porcelain", "-z"]);
    if (
      !(branch?.startsWith("refs/heads/") && branch.endsWith("\n")) ||
      branch.trimEnd().includes("\n") ||
      listing === null
    ) {
      throw worktreeVerificationError();
    }
    const ref = branch.trimEnd();
    const entries = listing
      .split("\0\0")
      .filter(Boolean)
      .map((entry) => {
        const fields = entry.split("\0");
        const roots = fields.filter((field) => field.startsWith("worktree "));
        const branches = fields.filter((field) => field.startsWith("branch "));
        if (roots.length !== 1 || branches.length > 1) {
          throw worktreeVerificationError();
        }
        return { root: roots[0]?.slice(9), branch: branches[0]?.slice(7) };
      });
    const selected = entries.filter((entry) => entry.root === projectRoot);
    if (selected.length !== 1 || selected[0]?.branch !== ref) {
      throw worktreeVerificationError();
    }
    const names = entries.flatMap((entry) =>
      entry.branch?.startsWith("refs/heads/") ? [entry.branch.slice(11)] : []
    );
    const raw = ref.slice(11);
    const derive = (name: string) => {
      const slug = sanitizeBranchSlug(name);
      const collision = names.some(
        (other) => other !== name && sanitizeBranchSlug(other) === slug
      );
      return collision
        ? `${slug}-${new Bun.CryptoHasher("sha1").update(name).digest("hex").slice(0, 4)}`
        : slug;
    };
    const slug = derive(raw);
    if (
      !NATIVE_BRANCH_DNS_LABEL.test(slug) ||
      slug.length > 63 ||
      names.some((other) => other !== raw && derive(other) === slug)
    ) {
      throw worktreeVerificationError();
    }
    const after = await readGitCheckoutIdentity({
      projectRoot,
      signal: opts.signal,
    });
    const markerAfter = await lstat(resolve(projectRoot, ".git"));
    const adminAfter = await lstat(before.gitDir);
    const commonAfter = await lstat(before.commonDir);
    if (
      !(before && after) ||
      before.gitDir !== after.gitDir ||
      before.commonDir !== after.commonDir ||
      admin.dev !== adminAfter.dev ||
      admin.ino !== adminAfter.ino ||
      common.dev !== commonAfter.dev ||
      common.ino !== commonAfter.ino ||
      marker.dev !== markerAfter.dev ||
      marker.ino !== markerAfter.ino ||
      marker.ctimeMs !== markerAfter.ctimeMs ||
      (await read(["symbolic-ref", "--quiet", "HEAD"])) !== branch ||
      (await read(["worktree", "list", "--porcelain", "-z"])) !== listing ||
      (await resolveVerifiedPrimaryWorktreeRoot({
        projectRoot,
        signal: opts.signal,
      })) !== primary
    ) {
      throw worktreeVerificationError();
    }
    throwIfCancelled(opts.signal);
    return { branch: slug, gitBranch: raw };
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw worktreeVerificationError();
  }
}

const NATIVE_BRANCH_DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

type GitCheckoutIdentity = {
  readonly gitDir: string;
  readonly commonDir: string;
};

/** Inspect only the managed owner's historical local-overlay filename at an exact Git root. */
export async function isNativeManagedLocalTracked(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<boolean | null> {
  try {
    const projectRoot = resolve(opts.projectRoot);
    const before = await readGitCheckoutIdentity({ ...opts, projectRoot });
    if (!before) {
      return null;
    }
    const path = ".hack/hack.env.local.yaml";
    const output = await readGitInspection({
      ...opts,
      projectRoot,
      args: [
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--cached",
        "-z",
        "--",
        path,
      ],
    });
    const after = await readGitCheckoutIdentity({ ...opts, projectRoot });
    if (
      output === null ||
      !after ||
      after.gitDir !== before.gitDir ||
      after.commonDir !== before.commonDir ||
      (output !== "" && output !== `${path}\0`)
    ) {
      throw worktreeVerificationError();
    }
    return output !== "";
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw worktreeVerificationError();
  }
}

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

/** Bounded read-only Git acquisition, separate from engine command file quotas.
 * Ignore caller Git redirection and never surface repository paths or child output.
 * An owner may supply a synchronous final admission and observe the owned child. */
export async function readGitInspection(opts: {
  readonly projectRoot: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly beforeSpawn?: () => undefined;
  readonly onSpawn?: (pid: number) => undefined;
}): Promise<string | null> {
  const { projectRoot, signal, beforeSpawn, onSpawn } = opts;
  const args = [...opts.args];
  throwIfCancelled(signal);
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
    const admitted: unknown = beforeSpawn?.();
    if (admitted !== undefined) {
      throw worktreeVerificationError();
    }
    throwIfCancelled(signal);
    const child = Bun.spawn(["git", "-C", projectRoot, ...args], {
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
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
    }
    try {
      const reading = readGitOutput(child.stdout);
      let observationFailed = false;
      try {
        const observed: unknown = onSpawn?.(child.pid);
        observationFailed = observed !== undefined;
      } catch {
        observationFailed = true;
      }
      const [output, code] = await Promise.all([reading, child.exited]);
      if (cancelled) {
        throwIfCancelled(signal);
      }
      return code === 0 && !timedOut && !observationFailed ? output : null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (child.exitCode === null) {
        kill();
      }
      await child.exited;
    }
  } catch (error: unknown) {
    throwIfCancelled(signal);
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

/** `HACK_WORKTREE_INHERIT_LOCAL=0` opts this checkout out of local env inheritance. */
function isLocalInheritanceDisabledByEnv(): boolean {
  return ["0", "false", "off", "no"].includes(
    (process.env.HACK_WORKTREE_INHERIT_LOCAL ?? "").trim().toLowerCase()
  );
}

/**
 * Resolve only an existing, direct primary project directory; never copy state.
 * Every opt-out (env, CI, slim mode, project config) is checked before any Git
 * subprocess runs. A linkage that fails verification does not inherit.
 */
export async function resolvePrimaryLocalProjectDir(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<string | null> {
  if (
    !shouldInheritPrimaryLocalInputs({ inheritLocal: true }) ||
    isLocalInheritanceDisabledByEnv()
  ) {
    return null;
  }
  const name = basename(opts.projectDir);
  if (
    (name !== ".hack" && name !== ".dev") ||
    relative(opts.projectRoot, opts.projectDir) !== name
  ) {
    return null;
  }
  // Primary checkouts never inherit; only a `.git` file marks a linked worktree.
  const marker = await lstat(resolve(opts.projectRoot, ".git")).catch(
    () => null
  );
  if (!marker?.isFile()) {
    return null;
  }
  const cfg = await readProjectConfig({
    ...opts,
    projectDirName: name,
    composeFile: resolve(opts.projectDir, "docker-compose.yml"),
    envFile: resolve(opts.projectDir, ".env"),
    configFile: resolve(opts.projectDir, "hack.config.json"),
  });
  if (cfg.worktree?.inheritLocal === false) {
    return null;
  }
  const primaryRoot = await resolveVerifiedPrimaryWorktreeRoot({
    projectRoot: opts.projectRoot,
  }).catch((error: unknown) => {
    // Unverifiable linkage (bare common dirs, foreign git dirs) reads no primary.
    if (error instanceof HackCliError) {
      return null;
    }
    throw error;
  });
  if (!primaryRoot) {
    return null;
  }
  await assertProjectConfigReadable({ projectDir: opts.projectDir });
  const candidate = resolve(primaryRoot, name);
  const info = await lstat(candidate).catch(() => null);
  if (
    !info?.isDirectory() ||
    (await realpath(candidate).catch(() => {
      throw primaryLocalReadError(candidate);
    })) !== candidate
  ) {
    return null;
  }
  return candidate;
}

/**
 * The config loader treats unreadable files as absent, which would hide a
 * `worktree.inherit_local: false` opt-out; fail closed instead (path only).
 * Field errors elsewhere in a well-formed file do not block env resolution.
 */
async function assertProjectConfigReadable(opts: {
  readonly projectDir: string;
}): Promise<void> {
  for (const name of [
    PROJECT_CONFIG_FILENAME,
    PROJECT_CONFIG_LEGACY_FILENAME,
  ]) {
    const path = resolve(opts.projectDir, name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (!isEnoent(error)) {
        throw new Error(`Cannot read project config: ${path}`);
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed =
        name === PROJECT_CONFIG_FILENAME
          ? JSON.parse(text)
          : Bun.TOML.parse(text);
    } catch {
      throw new Error("Cannot inherit local env with invalid project config");
    }
    if (!isRecord(parsed)) {
      throw new Error("Cannot inherit local env with invalid project config");
    }
    return;
  }
}

/** Whether the primary checkout holds any local overlay this checkout could inherit. */
export async function hasPrimaryLocalInputs(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<boolean> {
  const primaryDir = await resolvePrimaryLocalProjectDir(opts);
  if (primaryDir === null) {
    return false;
  }
  const entries = await readdir(primaryDir, { withFileTypes: true });
  // Match by name only: a symlinked or non-regular overlay must still route to
  // the YAML commands so resolution can reject it instead of falling back to .env.
  return entries.some(
    (entry) =>
      entry.name.startsWith("hack.env.") && entry.name.endsWith(".local.yaml")
  );
}

/** Read an inherited file; only a missing file is skipped, other errors fail closed. */
export async function readPrimaryLocalFile(
  path: string
): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null;
    }
    throw primaryLocalReadError(path);
  }
}

function primaryLocalReadError(path: string): Error {
  return new Error(`Cannot read primary local env file: ${path}`);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * Inherited files must be regular files with no symlink redirection. Any
 * filesystem error other than a missing file fails closed with the path only
 * (macOS realpath raises EACCES for unreadable files).
 */
export async function validatePrimaryLocalFile(path: string): Promise<void> {
  const failClosed = (error: unknown): null => {
    if (isEnoent(error)) {
      return null;
    }
    throw primaryLocalReadError(path);
  };
  const info = await lstat(path).catch(failClosed);
  if (!info) {
    return;
  }
  const real = info.isFile() ? await realpath(path).catch(failClosed) : "";
  if (real !== null && real !== resolve(path)) {
    throw new Error(
      `Refusing redirected or non-regular primary local env file: ${path}`
    );
  }
}
