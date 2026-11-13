import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

const MAX_FILE_BYTES = 256 * 1024;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VARIABLE_PATH = /[$\0\r\n]/;
const FIELD = /^[A-Za-z0-9_.-]{1,128}$/;
const IGNORE_SOURCES = new Set([".gitignore", ".ignore"]);

/** A closed native-only refusal; source paths and names are allowed, values are not. */
export class NativeEnvFileRefusal extends HackCliError {
  readonly service?: string;
  readonly source: string;
  readonly field: string;

  constructor(opts: {
    readonly source: string;
    readonly reason: string;
    readonly service?: string;
    readonly field?: string;
  }) {
    const service =
      opts.service !== undefined && SERVICE.test(opts.service)
        ? opts.service
        : undefined;
    const fallbackField =
      opts.source === "environment" ? "environment" : "env_file";
    const field =
      opts.field !== undefined && FIELD.test(opts.field)
        ? opts.field
        : fallbackField;
    super({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: `Native environment input${service === undefined ? "" : ` for service ${service} field ${field}`} source ${JSON.stringify(opts.source)} refused: ${opts.reason}; values omitted.`,
    });
    this.source = opts.source;
    this.service = service;
    this.field = field;
  }
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function sameVersion(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink
  );
}

function safeFile(info: Stats): boolean {
  return (
    info.isFile() &&
    info.uid === process.getuid?.() &&
    info.nlink === 1 &&
    (info.mode & 0o022) === 0 &&
    (info.mode & 0o400) !== 0 &&
    info.size <= MAX_FILE_BYTES
  );
}

async function readStableBytes(opts: {
  readonly path: string;
  readonly observed: Stats;
  readonly refusal: (reason: string) => Error;
}): Promise<Buffer> {
  const file = await open(
    opts.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (!sameVersion(opts.observed, before)) {
      throw opts.refusal("the source changed before reading");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const chunk = await file.read(buffer, size, buffer.length - size, size);
      if (chunk.bytesRead === 0) {
        break;
      }
      size += chunk.bytesRead;
    }
    if (
      size !== before.size ||
      !sameVersion(before, await file.stat()) ||
      !sameVersion(before, await lstat(opts.path))
    ) {
      throw opts.refusal("the source changed while reading");
    }
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

/** Literal source admission also runs before reusing a cached read. */
export function nativeEnvFileSourceLocation(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly path: string;
  readonly service?: string;
}): { readonly root: string; readonly path: string; readonly member: string } {
  const refusal = (reason: string) =>
    new NativeEnvFileRefusal({
      source: opts.path,
      service: opts.service,
      reason,
    });
  if (
    opts.path.length === 0 ||
    opts.path.length > 4096 ||
    VARIABLE_PATH.test(opts.path) ||
    opts.path.includes("~")
  ) {
    throw refusal("use a literal project-local path");
  }
  const root = resolve(opts.projectRoot);
  const path = resolve(dirname(opts.composeFile), opts.path);
  if (IGNORE_SOURCES.has(basename(path))) {
    throw refusal("an environment source cannot also own source ignore rules");
  }
  const member = relative(root, path);
  if (
    member === "" ||
    member === ".." ||
    member.startsWith(`..${sep}`) ||
    isAbsolute(member)
  ) {
    throw refusal("the source must stay inside this project root");
  }
  return { root, path, member };
}

/**
 * Read one project-owned env source without mutations. Every ancestor within
 * the canonical project root is a stable, owned, non-writable-by-others real
 * directory. The final entry is opened O_NOFOLLOW|O_NONBLOCK and must be a
 * stable single-link regular file that other users cannot write. Optional
 * ignores initial ENOENT only, never a disappearance during a read.
 */
export async function readNativeEnvFileSource(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly path: string;
  readonly required: boolean;
  readonly service?: string;
}): Promise<{ readonly path: string; readonly text: string } | null> {
  const { root, path, member } = nativeEnvFileSourceLocation(opts);
  const refusal = (reason: string) =>
    new NativeEnvFileRefusal({
      source: opts.path,
      service: opts.service,
      reason,
    });
  const directories: { readonly path: string; readonly info: Stats }[] = [];
  const paths = [root];
  let parent = root;
  for (const component of member.split(sep).slice(0, -1)) {
    parent = resolve(parent, component);
    paths.push(parent);
  }
  const recheckDirectories = async () => {
    for (const directory of directories) {
      const now = await lstat(directory.path);
      if (
        !now.isDirectory() ||
        now.dev !== directory.info.dev ||
        now.ino !== directory.info.ino ||
        now.uid !== directory.info.uid ||
        (now.mode & 0o022) !== 0
      ) {
        throw refusal("a source directory changed or is unsafe");
      }
    }
  };
  let observedSource = false;
  try {
    for (const directory of paths) {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0
      ) {
        throw refusal(
          "source directories must be real, owned by this user and not writable by others"
        );
      }
      directories.push({ path: directory, info });
    }
    const observed = await lstat(path);
    observedSource = true;
    if (!safeFile(observed)) {
      throw refusal(
        "use a single-link regular file owned by this user, owner-readable and not writable by others, at most 256 KiB"
      );
    }
    const buffer = await readStableBytes({ path, observed, refusal });
    await recheckDirectories();
    return {
      path,
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    };
  } catch (error: unknown) {
    if (missing(error) && !observedSource && directories.length > 0) {
      await recheckDirectories().catch(() => {
        throw refusal("a source directory changed");
      });
      if (!opts.required) {
        return null;
      }
      throw refusal("the required source is missing");
    }
    throw error instanceof NativeEnvFileRefusal
      ? error
      : refusal("the source is unreadable, unsafe or not valid UTF-8");
  }
}
