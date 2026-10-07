import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  compileNativeConfig,
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import type { ImportField } from "./native-config-import-parser.ts";
import {
  mapLegacyNativeImport,
  type NativeImportPlan,
  nativeImportResult,
} from "./native-config-import-plan.ts";
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
function refusedField(code: string): ImportField {
  return {
    document: "config",
    pointer: "",
    line: 1,
    column: 1,
    status: "refused",
    code,
  };
}

/**
 * Exact-root read-only preview. No draft, active input, engine, env/key or registry
 * operations. Complete private candidates go only to the matching pure Rust compiler
 * in memory. Stable reads and rechecks do not lock concurrent external editors.
 */
export async function previewNativeConfigImport(inputOpts: {
  readonly projectRoot: string;
  readonly binary?: string;
  readonly signal?: AbortSignal;
}): Promise<NativeImportPlan> {
  const { binary, signal } = inputOpts;
  const root = resolve(inputOpts.projectRoot);
  try {
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
        return nativeImportResult({
          fields: [refusedField("local_or_dotenv_input_outside_first_slice")],
        });
      }
    }
    const git = await gitLayout(root);
    if (!git.supported) {
      return nativeImportResult({
        fields: [refusedField("git_file_layout_outside_first_slice")],
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
    const mapped = mapLegacyNativeImport({
      configText: decoder.decode(config.bytes),
      composeText: decoder.decode(compose.bytes),
    });
    let result = mapped;
    if (mapped.candidate) {
      const compiled = await compileNativeConfig({
        input: new TextEncoder().encode(JSON.stringify(mapped.candidate)),
        binary,
        signal,
      });
      if (!compiled.ok) {
        // Compiler output/plans and partial candidates never enter a public report.
        result = nativeImportResult({
          fields: [
            ...mapped.report.fields,
            refusedField("candidate_compiler_refused"),
          ],
        });
      }
    }
    await recheckInputs({ root, config, compose, dirs, blocked, git, signal });
    return result;
  } catch (error: unknown) {
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_COMPILER_CANCELLED"
    ) {
      throw error;
    }
    return nativeImportResult({
      fields: [refusedField("unsafe_changed_or_unavailable_input")],
    });
  }
}
