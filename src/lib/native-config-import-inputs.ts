import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import { inspectProjectInputsAtRoot } from "./project-input-selection.ts";
import { resolveVerifiedGitCheckoutLocation } from "./worktree-local-config.ts";

const ownedAcquisitions = new WeakSet<object>();
const privateLocalInputs = new WeakMap<object, NativeConfigImportLocalInput>();

/** Private optional local bytes and identity from the issued source acquisition. Never report. */
export type NativeConfigImportLocalInput = {
  readonly text: string | null;
  readonly proof: {
    readonly hash: string;
    readonly info: Pick<
      NativeConfigImportSourceIdentity,
      "dev" | "ino" | "mode" | "nlink" | "uid"
    >;
  } | null;
};

/** Ordinary import capabilities have no local authority. Only the adoption factory issues this snapshot. */
export function privateNativeConfigImportLocalInput(
  source: NativeConfigImportInputs
) {
  if (!ownedAcquisitions.has(source)) {
    throw failure();
  }
  return privateLocalInputs.get(source);
}
const privateSourceProofs = new WeakMap<
  object,
  NativeConfigImportSourceProof
>();

/** Private durable provenance captured from the same strict source acquisition. Never report. */
export type NativeConfigImportSourceProof = {
  readonly root: { readonly dev: number; readonly ino: number };
  readonly project: { readonly dev: number; readonly ino: number };
  readonly sourceFiles: {
    readonly config: NativeConfigImportSourceIdentity;
    readonly compose: NativeConfigImportSourceIdentity;
  };
  readonly configHash: string;
  readonly composeHash: string;
};

/** Only an issued source can supply a proof; this performs no second acquisition. */
export function privateNativeConfigImportSourceProof(
  source: NativeConfigImportInputs
): NativeConfigImportSourceProof {
  const proof = privateSourceProofs.get(source);
  if (!(proof && ownedAcquisitions.has(source))) {
    throw failure();
  }
  return proof;
}

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
export type NativeConfigImportSourceIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly uid: number;
};
function sourceIdentity(info: Stats): NativeConfigImportSourceIdentity {
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    uid: info.uid,
  });
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
async function readStable(
  path: string,
  signal?: AbortSignal,
  expectedLinks = 1
) {
  cancelled(signal);
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== expectedLinks ||
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
/** Same bounded authored reader for a durable owner's exact canonical or held-original paths. Private bytes grant no discovery or effect authority. */
export async function readNativeConfigImportSourceFile(opts: {
  readonly path: string;
  readonly signal?: AbortSignal;
}) {
  let signal: AbortSignal | undefined;
  try {
    const path = opts.path;
    signal = opts.signal;
    if (
      typeof path !== "string" ||
      !path.length ||
      path.includes("\0") ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) {
      throw failure();
    }
    return await readStable(path, signal);
  } catch (error: unknown) {
    redactFailure(error, signal);
  }
}
/** Only the durable owner's two known paths may account for an interrupted link-before-unlink restore. Ordinary source acquisition still requires one link. */
export async function readNativeConfigImportSourceLinkPair(opts: {
  readonly left: string;
  readonly right: string;
  readonly signal?: AbortSignal;
}) {
  let signal: AbortSignal | undefined;
  try {
    const { left, right } = opts;
    signal = opts.signal;
    if (
      typeof left !== "string" ||
      typeof right !== "string" ||
      !left.length ||
      !right.length ||
      left.includes("\0") ||
      right.includes("\0") ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) {
      throw failure();
    }
    cancelled(signal);
    const a = await lstat(left),
      b = await lstat(right);
    if (
      left === right ||
      !same(a, b) ||
      a.nlink !== 2 ||
      !a.isFile() ||
      !b.isFile()
    ) {
      throw failure();
    }
    const read = await readStable(left, signal, 2);
    if (
      !(
        same(a, read.info) &&
        same(a, await lstat(left)) &&
        same(a, await lstat(right))
      )
    ) {
      throw failure();
    }
    return read;
  } catch (error: unknown) {
    redactFailure(error, signal);
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
async function optionalLocal(root: string, signal?: AbortSignal) {
  const path = resolve(root, ".hack/hack.local.json");
  if (await absent(path)) {
    return null;
  }
  const local = await readStable(path, signal);
  if (
    local.info.uid !== process.getuid?.() ||
    (local.info.mode & 0o022) !== 0
  ) {
    throw failure();
  }
  return local;
}

/** Only marker types are inspected; linked/separate Git layouts are outside this slice. */
async function gitLayout(
  root: string,
  allowLinkedWorktree = false,
  signal?: AbortSignal
) {
  const markers: { readonly path: string; readonly info: Stats | null }[] = [];
  let current = root;
  for (let depth = 0; depth < 64; depth++) {
    const path = resolve(current, ".git");
    const info = await markerInfo(path);
    markers.push({ path, info });
    if (info) {
      if (info.isFile() && allowLinkedWorktree && current === root) {
        const location = await resolveVerifiedGitCheckoutLocation({
          projectRoot: root,
          signal,
        }).catch(() => {
          cancelled(signal);
          return null;
        });
        if (!location?.primaryRoot || location.gitDir === location.commonDir) {
          return { markers, supported: false };
        }
        const marker = await readStable(path, signal);
        return {
          markers,
          supported: true,
          linked: { location, marker },
        };
      }
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
async function recheckGit(
  root: string,
  git: Awaited<ReturnType<typeof gitLayout>>,
  signal?: AbortSignal
) {
  for (const marker of git.markers) {
    const current = await markerInfo(marker.path);
    if (
      marker.info === null
        ? current !== null
        : !(
            current !== null &&
            (git.linked ? current.isFile() : current.isDirectory()) &&
            current.dev === marker.info.dev &&
            current.ino === marker.info.ino
          )
    ) {
      throw failure();
    }
  }
  if (git.linked) {
    const current = await gitLayout(root, true, signal);
    if (
      !current.linked ||
      JSON.stringify(current.linked.location) !==
        JSON.stringify(git.linked.location) ||
      !same(current.linked.marker.info, git.linked.marker.info) ||
      !current.linked.marker.bytes.equals(git.linked.marker.bytes)
    ) {
      throw failure();
    }
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
  readonly local?: Awaited<ReturnType<typeof readStable>> | null;
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
  if (opts.local !== undefined) {
    const path = resolve(opts.root, ".hack/hack.local.json");
    if (opts.local === null) {
      if (!(await absent(path))) {
        throw failure();
      }
    } else {
      const local = await readStable(path, opts.signal);
      if (
        !(
          same(opts.local.info, local.info) &&
          opts.local.bytes.equals(local.bytes)
        )
      ) {
        throw failure();
      }
    }
  }
  await recheckGit(opts.root, opts.git, opts.signal);
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
      readonly sourceFiles: {
        readonly config: NativeConfigImportSourceIdentity;
        readonly compose: NativeConfigImportSourceIdentity;
      };
      readonly assertFresh: (opts?: {
        readonly signal?: AbortSignal;
      }) => Promise<void>;
    };

/** Identity-only admission for a private source capability; copied or structural claims grant no authority. */
export function isOwnedNativeConfigImportAcquisition(
  input: unknown
): input is Extract<NativeConfigImportInputs, { readonly ok: true }> {
  return (
    typeof input === "object" && input !== null && ownedAcquisitions.has(input)
  );
}

/**
 * One exact legacy snapshot for import and adoption prerequisites. Original
 * bytes, pathname identities and marker absences stay in the closure. Rechecks
 * detect cooperative external changes; they do not lock arbitrary editors.
 * Successful private source and methods are non-enumerable and immutable.
 */
async function acquireInputs(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly allowLinkedWorktree?: boolean;
  readonly allowLocal?: boolean;
}): Promise<NativeConfigImportInputs> {
  const root = resolve(opts.projectRoot);
  const signal = opts.signal;
  cancelled(signal);
  await exactLegacy(root);
  const dirs = await directories(root);
  const blocked = [
    resolve(root, ".env"),
    resolve(root, ".hack/.env"),
    ...(opts.allowLocal ? [] : [resolve(root, ".hack/hack.local.json")]),
  ];
  for (const path of blocked) {
    if (!(await absent(path))) {
      return Object.freeze({
        ok: false,
        code: "local_or_dotenv_input_outside_first_slice",
      });
    }
  }
  const git = await gitLayout(root, opts.allowLinkedWorktree, signal);
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
  const local = opts.allowLocal ? await optionalLocal(root, signal) : undefined;
  const result = {
    ok: true as const,
    configText: decoder.decode(config.bytes),
    composeText: decoder.decode(compose.bytes),
    projectRoot: root,
    sourceFiles: Object.freeze({
      config: sourceIdentity(config.info),
      compose: sourceIdentity(compose.info),
    }),
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
          local,
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
    "sourceFiles",
    "assertFresh",
  ]) {
    Object.defineProperty(result, key, { enumerable: false });
  }
  await result.assertFresh();
  ownedAcquisitions.add(result);
  if (local !== undefined) {
    const snapshot = {
      text: local === null ? null : decoder.decode(local.bytes),
      proof:
        local === null
          ? null
          : Object.freeze({
              hash: createHash("sha256").update(local.bytes).digest("hex"),
              info: Object.freeze({
                dev: local.info.dev,
                ino: local.info.ino,
                mode: local.info.mode,
                nlink: local.info.nlink,
                uid: local.info.uid,
              }),
            }),
    };
    for (const key of Object.keys(snapshot)) {
      Object.defineProperty(snapshot, key, { enumerable: false });
    }
    privateLocalInputs.set(result, Object.freeze(snapshot));
  }
  const [rootDirectory, projectDirectory] = dirs;
  if (!(rootDirectory && projectDirectory)) {
    throw failure();
  }
  privateSourceProofs.set(
    result,
    Object.freeze({
      root: Object.freeze({
        dev: rootDirectory.info.dev,
        ino: rootDirectory.info.ino,
      }),
      project: Object.freeze({
        dev: projectDirectory.info.dev,
        ino: projectDirectory.info.ino,
      }),
      sourceFiles: result.sourceFiles,
      configHash: createHash("sha256").update(config.bytes).digest("hex"),
      composeHash: createHash("sha256").update(compose.bytes).digest("hex"),
    })
  );
  return Object.freeze(result);
}

/** Private source capability; filesystem and decoder diagnostics remain redacted. */
async function validatedAcquisition(
  opts: {
    readonly projectRoot: string;
    readonly signal?: AbortSignal;
    /** Private adoption owner only; ordinary import preview keeps its existing refusal. */
    readonly allowLinkedWorktree?: boolean;
  },
  allowLocal: boolean
): Promise<NativeConfigImportInputs> {
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
    const allowLinkedWorktree = opts.allowLinkedWorktree;
    if (
      allowLinkedWorktree !== undefined &&
      typeof allowLinkedWorktree !== "boolean"
    ) {
      throw failure();
    }
    return await acquireInputs({
      projectRoot,
      signal,
      allowLinkedWorktree,
      allowLocal,
    });
  } catch (error: unknown) {
    redactFailure(error, signal);
  }
}

/** Private source capability; ordinary preview retains local-input refusal. */
export async function acquireNativeConfigImportInputs(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly allowLinkedWorktree?: boolean;
}): Promise<NativeConfigImportInputs> {
  return await validatedAcquisition(opts, false);
}

/** Adoption-only optional local capture. Reading bytes does not grant mapping, selection or effect authority. */
export async function acquireLegacyAdoptionSourceInputs(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly allowLinkedWorktree?: boolean;
}): Promise<NativeConfigImportInputs> {
  return await validatedAcquisition(opts, true);
}
