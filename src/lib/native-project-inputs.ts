import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import {
  discoverProjectInputs,
  inspectProjectInputsAtRoot,
  NATIVE_PROJECT_FILENAME,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
import {
  resolveVerifiedPrimaryWorktreeRoot,
  shouldInheritPrimaryLocalInputs,
} from "./worktree-local-config.ts";

const NATIVE_LOCAL_FILENAME = "hack.local.json";
const MANAGED_ENV_FILENAME =
  /^hack\.env\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.local)?\.yaml$/;

/** Fixed failures never disclose authored bytes, paths, or filesystem error text. */
export class NativeProjectInputError extends HackCliError {
  constructor(kind: "unsupported" | "unsafe") {
    super({
      code:
        kind === "unsupported"
          ? "E_NATIVE_PROJECT_UNSUPPORTED"
          : "E_CONFIG_INVALID",
      message:
        kind === "unsupported"
          ? "Project-aware native validation requires an exact native input family; values omitted."
          : "Native project inputs must be stable, readable regular files of at most 1 MiB in unredirected directories; values omitted.",
    });
    this.name = "NativeProjectInputError";
  }
}

/** Select native input only, preserving the shared discovery boundary and raw bytes. */
export async function acquireNativeProjectInput(opts: {
  readonly startDir: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly projectRoot: string; readonly input: Uint8Array }> {
  try {
    throwIfCancelled(opts.signal);
    const selected = await discoverProjectInputs(opts);
    if (selected?.kind === "conflict") {
      throw new ProjectInputSelectionError("conflict");
    }
    if (selected?.kind !== "native") {
      throw new NativeProjectInputError("unsupported");
    }
    const input = await readAuthoredNativeFile({
      projectRoot: selected.projectRoot,
      filename: NATIVE_PROJECT_FILENAME,
      required: true,
      signal: opts.signal,
    });
    await requireNativeFamilyAtRoot({ projectRoot: selected.projectRoot });
    throwIfCancelled(opts.signal);
    if (!input) {
      throw new NativeProjectInputError("unsafe");
    }
    return { projectRoot: selected.projectRoot, input };
  } catch (error: unknown) {
    throw redactAcquisitionError(error);
  }
}

/**
 * Acquire only the optional raw local documents. `inheritLocal` comes from the
 * validated Rust project policy; no policy, environment, or generated state is
 * interpreted here. Descriptor checks are preflight, not a multi-file snapshot.
 */
export async function acquireNativeLocalInputs(opts: {
  readonly projectRoot: string;
  readonly inheritLocal: boolean;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly primaryLocal?: Uint8Array;
  readonly checkoutLocal?: Uint8Array;
}> {
  try {
    throwIfCancelled(opts.signal);
    const projectRoot = resolve(opts.projectRoot);
    await requireNativeFamilyAtRoot({ projectRoot });
    await readAuthoredNativeFile({
      projectRoot,
      filename: NATIVE_PROJECT_FILENAME,
      required: true,
      signal: opts.signal,
    });
    let primaryLocal: Uint8Array | undefined;
    if (shouldInheritPrimaryLocalInputs(opts)) {
      const primaryRoot = await resolveVerifiedPrimaryWorktreeRoot({
        projectRoot,
        signal: opts.signal,
      });
      if (primaryRoot) {
        await requireNativeFamilyAtRoot({ projectRoot: primaryRoot });
        await readAuthoredNativeFile({
          projectRoot: primaryRoot,
          filename: NATIVE_PROJECT_FILENAME,
          required: true,
          signal: opts.signal,
        });
        primaryLocal = await readAuthoredNativeFile({
          projectRoot: primaryRoot,
          filename: NATIVE_LOCAL_FILENAME,
          required: false,
          signal: opts.signal,
        });
        await requireNativeFamilyAtRoot({ projectRoot: primaryRoot });
      }
    }
    const checkoutLocal = await readAuthoredNativeFile({
      projectRoot,
      filename: NATIVE_LOCAL_FILENAME,
      required: false,
      signal: opts.signal,
    });
    await requireNativeFamilyAtRoot({ projectRoot });
    throwIfCancelled(opts.signal);
    return {
      ...(primaryLocal === undefined ? {} : { primaryLocal }),
      ...(checkoutLocal === undefined ? {} : { checkoutLocal }),
    };
  } catch (error: unknown) {
    throw redactAcquisitionError(error);
  }
}

export async function requireNativeFamilyAtRoot(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  const selected = await inspectProjectInputsAtRoot(opts);
  if (selected.kind === "conflict") {
    throw new ProjectInputSelectionError("conflict");
  }
  if (selected.kind !== "native") {
    throw new NativeProjectInputError("unsupported");
  }
}

/** Verify an exact native root and its required marker without interpreting authored policy. */
export async function assertNativeProjectInputRoot(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  try {
    throwIfCancelled(opts.signal);
    const projectRoot = resolve(opts.projectRoot);
    await requireNativeFamilyAtRoot({ projectRoot });
    await readAuthoredNativeFile({
      ...opts,
      projectRoot,
      filename: NATIVE_PROJECT_FILENAME,
      required: true,
    });
    await requireNativeFamilyAtRoot({ projectRoot });
    throwIfCancelled(opts.signal);
  } catch (error: unknown) {
    throw redactAcquisitionError(error);
  }
}

/**
 * The managed-env owner may acquire only its YAML layers through the same bounded
 * descriptor boundary. These bytes can contain secrets: never expose them outside
 * that owner. File checks do not provide an atomic multi-file snapshot.
 */
export async function acquireNativeManagedEnvFile(opts: {
  readonly projectRoot: string;
  readonly filename: string;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array | undefined> {
  try {
    throwIfCancelled(opts.signal);
    if (!MANAGED_ENV_FILENAME.test(opts.filename)) {
      throw new NativeProjectInputError("unsafe");
    }
    const projectRoot = resolve(opts.projectRoot);
    await requireNativeFamilyAtRoot({ projectRoot });
    const bytes = await readAuthoredNativeFile({
      ...opts,
      projectRoot,
      required: false,
    });
    await requireNativeFamilyAtRoot({ projectRoot });
    throwIfCancelled(opts.signal);
    return bytes;
  } catch (error: unknown) {
    throw redactAcquisitionError(error);
  }
}

type DirectoryIdentity = {
  readonly path: string;
  readonly stats: Stats;
};

async function inspectInputDirectories(
  projectRoot: string
): Promise<readonly DirectoryIdentity[]> {
  const directories: DirectoryIdentity[] = [];
  for (const path of [
    projectRoot,
    resolve(projectRoot, HACK_PROJECT_DIR_PRIMARY),
  ]) {
    const stats = await lstat(path);
    if (!stats.isDirectory() || (await realpath(path)) !== path) {
      throw new NativeProjectInputError("unsafe");
    }
    directories.push({ path, stats });
  }
  return directories;
}

async function recheckInputDirectories(
  directories: readonly DirectoryIdentity[]
): Promise<void> {
  for (const directory of directories) {
    const current = await lstat(directory.path);
    if (
      !(current.isDirectory() && sameIdentity(directory.stats, current)) ||
      (await realpath(directory.path)) !== directory.path
    ) {
      throw new NativeProjectInputError("unsafe");
    }
  }
}

/** Bound descriptor reads, reject path redirection, and reject identity/content changes. */
async function readAuthoredNativeFile(opts: {
  readonly projectRoot: string;
  readonly filename: string;
  readonly required: boolean;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array | undefined> {
  throwIfCancelled(opts.signal);
  const directories = await inspectInputDirectories(opts.projectRoot);
  const path = resolve(
    opts.projectRoot,
    HACK_PROJECT_DIR_PRIMARY,
    opts.filename
  );
  const observed = await lstat(path).catch((error: unknown) => {
    if (!opts.required && isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw new NativeProjectInputError("unsafe");
  });
  if (!observed) {
    await recheckInputDirectories(directories);
    return undefined;
  }
  if (
    !observed.isFile() ||
    observed.size > NATIVE_CONFIG_INPUT_LIMIT ||
    (observed.mode & 0o444) === 0 ||
    (await realpath(path)) !== path
  ) {
    throw new NativeProjectInputError("unsafe");
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    throwIfCancelled(opts.signal);
    const before = await file.stat();
    if (
      !(
        before.isFile() &&
        sameIdentity(observed, before) &&
        sameContentMetadata(observed, before)
      )
    ) {
      throw new NativeProjectInputError("unsafe");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      throwIfCancelled(opts.signal);
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size
      );
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (
      size > NATIVE_CONFIG_INPUT_LIMIT ||
      size !== before.size ||
      !current.isFile() ||
      !sameIdentity(before, after) ||
      !sameIdentity(before, current) ||
      !sameContentMetadata(before, after) ||
      !sameContentMetadata(before, current) ||
      (await realpath(path)) !== path
    ) {
      throw new NativeProjectInputError("unsafe");
    }
    await recheckInputDirectories(directories);
    throwIfCancelled(opts.signal);
    return Uint8Array.from(buffer.subarray(0, size));
  } finally {
    await file.close();
  }
}

function sameIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function sameContentMetadata(before: Stats, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function redactAcquisitionError(
  error: unknown
): HackCliError | NativeConfigCompilerError {
  return error instanceof HackCliError ||
    error instanceof NativeConfigCompilerError
    ? error
    : new NativeProjectInputError("unsafe");
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Native configuration input acquisition was cancelled."
    );
  }
}
