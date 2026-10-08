import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import { inspectProjectInputsAtRoot } from "./project-input-selection.ts";

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Native configuration import was cancelled; values omitted."
    );
  }
}
function failure(): Error {
  return new Error(
    "Cannot preview native import: selected inputs are invalid, unsafe or changed; values omitted."
  );
}
function redactFailure(error: unknown, signal?: AbortSignal): never {
  cancelled(signal);
  if (
    error instanceof NativeConfigCompilerError &&
    error.code === "E_COMPILER_CANCELLED"
  ) {
    throw error;
  }
  throw failure();
}
function same(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function directories(root: string) {
  const result: { readonly path: string; readonly info: Stats }[] = [];
  for (const path of [root, resolve(root, ".hack")]) {
    const info = await lstat(path);
    if (!info.isDirectory() || (await realpath(path)) !== path) {
      throw failure();
    }
    result.push({ path, info });
  }
  return result;
}
async function readStable(path: string, signal?: AbortSignal) {
  cancelled(signal);
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size > NATIVE_CONFIG_INPUT_LIMIT ||
    !(entry.mode & 0o444)
  ) {
    throw failure();
  }
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    cancelled(signal);
    const before = await descriptor.stat();
    if (!same(entry, before)) {
      throw failure();
    }
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      cancelled(signal);
      const { bytesRead } = await descriptor.read(
        buffer,
        size,
        buffer.length - size,
        size
      );
      if (!bytesRead) {
        break;
      }
      size += bytesRead;
    }
    if (
      size !== before.size ||
      !same(before, await descriptor.stat()) ||
      !same(before, await lstat(path))
    ) {
      throw failure();
    }
    cancelled(signal);
    return { bytes: buffer.subarray(0, size), info: before };
  } finally {
    await descriptor.close();
  }
}
async function markerInfo(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw failure();
  }
}
async function absent(path: string): Promise<boolean> {
  return (await markerInfo(path)) === null;
}

/** Only marker types are inspected; linked/separate Git layouts are outside this slice. */
async function gitLayout(root: string) {
  const markers: { readonly path: string; readonly info: Stats | null }[] = [];
  let current = root;
  for (let depth = 0; depth < 64; depth++) {
    const path = resolve(current, ".git");
    const info = await markerInfo(path);
    markers.push({ path, info });
    if (info) {
      return { markers, supported: info.isDirectory() };
    }
    const parent = dirname(current);
    if (parent === current) {
      return { markers, supported: true };
    }
    current = parent;
  }
  throw failure();
}
async function exactLegacy(root: string): Promise<void> {
  const selected = await inspectProjectInputsAtRoot({ projectRoot: root });
  const expected = [
    resolve(root, ".hack/hack.config.json"),
    resolve(root, ".hack/docker-compose.yml"),
  ];
  if (
    selected.kind !== "legacy" ||
    selected.legacyFiles.length !== expected.length ||
    expected.some((path) => !selected.legacyFiles.includes(path))
  ) {
    throw failure();
  }
}
async function recheckInputs(opts: {
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly config: Awaited<ReturnType<typeof readStable>>;
  readonly compose: Awaited<ReturnType<typeof readStable>>;
  readonly dirs: Awaited<ReturnType<typeof directories>>;
  readonly blocked: readonly string[];
  readonly git: Awaited<ReturnType<typeof gitLayout>>;
}) {
  const config = await readStable(
    resolve(opts.root, ".hack/hack.config.json"),
    opts.signal
  );
  const compose = await readStable(
    resolve(opts.root, ".hack/docker-compose.yml"),
    opts.signal
  );
  if (
    !(
      same(opts.config.info, config.info) &&
      opts.config.bytes.equals(config.bytes) &&
      same(opts.compose.info, compose.info) &&
      opts.compose.bytes.equals(compose.bytes)
    )
  ) {
    throw failure();
  }
  for (const dir of opts.dirs) {
    const current = await lstat(dir.path);
    if (
      !current.isDirectory() ||
      current.dev !== dir.info.dev ||
      current.ino !== dir.info.ino ||
      (await realpath(dir.path)) !== dir.path
    ) {
      throw failure();
    }
  }
  for (const path of opts.blocked) {
    if (!(await absent(path))) {
      throw failure();
    }
  }
  for (const marker of opts.git.markers) {
    const current = await markerInfo(marker.path);
    if (
      marker.info === null
        ? current !== null
        : !(
            current?.isDirectory() &&
            current.dev === marker.info.dev &&
            current.ino === marker.info.ino
          )
    ) {
      throw failure();
    }
  }
  await exactLegacy(opts.root);
  cancelled(opts.signal);
}

export type NativeConfigImportInputs =
  | { readonly ok: false; readonly code: string }
  | {
      readonly ok: true;
      /** Private original UTF-8 source. Never serialize or log. */
      readonly configText: string;
      readonly composeText: string;
      readonly projectRoot: string;
      readonly assertFresh: (opts?: {
        readonly signal?: AbortSignal;
      }) => Promise<void>;
    };

/**
 * One exact legacy snapshot for import and adoption prerequisites. Original
 * bytes, pathname identities and marker absences stay in the closure. Rechecks
 * detect cooperative external changes; they do not lock arbitrary editors.
 * Successful private source and methods are non-enumerable and immutable.
 */
async function acquireInputs(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<NativeConfigImportInputs> {
  const root = resolve(opts.projectRoot);
  const signal = opts.signal;
  cancelled(signal);
  await exactLegacy(root);
  const dirs = await directories(root);
  const blocked = [
    resolve(root, ".env"),
    resolve(root, ".hack/.env"),
    resolve(root, ".hack/hack.local.json"),
  ];
  for (const path of blocked) {
    if (!(await absent(path))) {
      return Object.freeze({
        ok: false,
        code: "local_or_dotenv_input_outside_first_slice",
      });
    }
  }
  const git = await gitLayout(root);
  if (!git.supported) {
    return Object.freeze({
      ok: false,
      code: "git_file_layout_outside_first_slice",
    });
  }
  const config = await readStable(
    resolve(root, ".hack/hack.config.json"),
    signal
  );
  const compose = await readStable(
    resolve(root, ".hack/docker-compose.yml"),
    signal
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result = {
    ok: true as const,
    configText: decoder.decode(config.bytes),
    composeText: decoder.decode(compose.bytes),
    projectRoot: root,
    assertFresh: async (current?: { readonly signal?: AbortSignal }) => {
      let recheckSignal = signal;
      try {
        cancelled(signal);
        if (current !== undefined && !isRecord(current)) {
          throw failure();
        }
        const currentSignal = current?.signal;
        if (
          currentSignal !== undefined &&
          !(currentSignal instanceof AbortSignal)
        ) {
          throw failure();
        }
        recheckSignal =
          signal && currentSignal
            ? AbortSignal.any([signal, currentSignal])
            : (currentSignal ?? signal);
        await recheckInputs({
          root,
          config,
          compose,
          dirs,
          blocked,
          git,
          signal: recheckSignal,
        });
        cancelled(signal);
      } catch (error: unknown) {
        redactFailure(error, recheckSignal);
      }
    },
  };
  for (const key of [
    "configText",
    "composeText",
    "projectRoot",
    "assertFresh",
  ]) {
    Object.defineProperty(result, key, { enumerable: false });
  }
  await result.assertFresh();
  return Object.freeze(result);
}

/** Private source capability; filesystem and decoder diagnostics remain redacted. */
export async function acquireNativeConfigImportInputs(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<NativeConfigImportInputs> {
  let signal: AbortSignal | undefined;
  try {
    if (!isRecord(opts)) {
      throw failure();
    }
    const projectRoot = opts.projectRoot;
    const suppliedSignal = opts.signal;
    if (
      typeof projectRoot !== "string" ||
      !projectRoot.length ||
      projectRoot.includes("\0") ||
      (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal))
    ) {
      throw failure();
    }
    signal = suppliedSignal;
    return await acquireInputs({ projectRoot, signal });
  } catch (error: unknown) {
    redactFailure(error, signal);
  }
}
