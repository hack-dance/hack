import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";
import { nativeComposeSourceCaptured } from "./native-source-capture.ts";

/**
 * Native source content limit (HACK-1965).
 *
 * Native `up` captures the selected (non-ignored) project content into memory to
 * bind a source revision, so that content is bounded: 128 MiB by default, raised per
 * project with `native.sourceLimitMiB` in `.hack/hack.config.json` up to
 * {@link NATIVE_SOURCE_LIMIT_MAXIMUM_MIB}. The runtime owns both the measurement and
 * the configured limit (`project source-size`), so this check, `hack doctor` and the
 * capture itself agree on the selection rules. The request reads metadata only and
 * writes no state.
 */
export const NATIVE_SOURCE_LIMIT_DEFAULT_MIB = 128;
export const NATIVE_SOURCE_LIMIT_MAXIMUM_MIB = 512;
const MIB = 1024 * 1024;
/** The runtime's inventory budget is 10 seconds; allow process start-up around it. */
const SOURCE_SIZE_TIMEOUT_MS = 20_000;
const MAX_REPORTED_PATHS = 5;
const CONTROL = /[\x00-\x1f\x7f]/;

export interface NativeSourcePathSize {
  /** Project-relative path. */
  readonly path: string;
  readonly bytes: number;
}

/** Validated `project source-size` receipt. */
export interface NativeSourceSize {
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly limitBytes: number;
  /** `project` when `.hack/hack.config.json` sets `native.sourceLimitMiB`. */
  readonly limitOrigin: "default" | "project";
  readonly maximumLimitBytes: number;
  readonly withinLimit: boolean;
  readonly largestFiles: readonly NativeSourcePathSize[];
  readonly largestDirectories: readonly NativeSourcePathSize[];
}

function byteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function pathSizes(value: unknown): NativeSourcePathSize[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_PATHS) {
    return undefined;
  }
  const sizes: NativeSourcePathSize[] = [];
  for (const item of value) {
    if (
      !(
        isRecord(item) &&
        typeof item.path === "string" &&
        item.path.length > 0 &&
        item.path.length <= 4096 &&
        !CONTROL.test(item.path) &&
        !item.path.startsWith("/") &&
        byteCount(item.bytes)
      )
    ) {
      return undefined;
    }
    sizes.push({ path: item.path, bytes: item.bytes });
  }
  return sizes;
}

/** Parse the runtime receipt; anything else is `undefined`, never a partial report. */
export function parseNativeSourceSize(
  value: unknown
): NativeSourceSize | undefined {
  if (
    !(
      isRecord(value) &&
      value.schema_version === 1 &&
      value.kind === "native_source_size" &&
      byteCount(value.total_bytes) &&
      byteCount(value.file_count) &&
      byteCount(value.limit_bytes) &&
      value.limit_bytes > 0 &&
      byteCount(value.maximum_limit_bytes) &&
      value.limit_bytes <= value.maximum_limit_bytes &&
      (value.limit_origin === "default" || value.limit_origin === "project") &&
      value.within_limit === value.total_bytes <= value.limit_bytes
    )
  ) {
    return undefined;
  }
  const largestFiles = pathSizes(value.largest_files);
  const largestDirectories = pathSizes(value.largest_directories);
  if (!(largestFiles && largestDirectories)) {
    return undefined;
  }
  return {
    totalBytes: value.total_bytes,
    fileCount: value.file_count,
    limitBytes: value.limit_bytes,
    limitOrigin: value.limit_origin,
    maximumLimitBytes: value.maximum_limit_bytes,
    withinLimit: value.within_limit,
    largestFiles,
    largestDirectories,
  };
}

/** Ask the selected runtime to measure the project's selected source content. */
export async function readNativeSourceSize(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeSourceSize> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const result = await invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: ["project", "source-size", "--project", opts.projectRoot, "--json"],
    timeoutMs: SOURCE_SIZE_TIMEOUT_MS,
    signal: opts.signal,
  });
  const size = parseNativeSourceSize(result);
  if (!size) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message:
        "Native source size check returned an invalid receipt; no runtime, image or build work was started.",
    });
  }
  return size;
}

/** One decimal place, without a trailing `.0`. */
function oneDecimal(value: number): string {
  const text = value.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** `237.4 MiB`, `512 KiB` or `12 B`. */
export function formatNativeSourceBytes(bytes: number): string {
  if (bytes >= MIB) {
    return `${oneDecimal(bytes / MIB)} MiB`;
  }
  if (bytes >= 1024) {
    return `${oneDecimal(bytes / 1024)} KiB`;
  }
  return `${bytes} B`;
}

function listed(sizes: readonly NativeSourcePathSize[]): string {
  return sizes
    .map(({ path, bytes }) => `${path} (${formatNativeSourceBytes(bytes)})`)
    .join(", ");
}

/** One-line summary: total, limit and where the limit comes from. */
export function describeNativeSourceSize(size: NativeSourceSize): string {
  const origin =
    size.limitOrigin === "project"
      ? "native.sourceLimitMiB in .hack/hack.config.json"
      : "default";
  return `Selected (non-ignored) source is ${formatNativeSourceBytes(size.totalBytes)} in ${size.fileCount} files; the native source limit is ${formatNativeSourceBytes(size.limitBytes)} (${origin}).`;
}

/** The largest paths and the two ways to get under the limit. */
export function nativeSourceSizeRemedy(size: NativeSourceSize): string {
  const directories =
    size.largestDirectories.length > 0
      ? ` Largest directories: ${listed(size.largestDirectories)}.`
      : "";
  const files =
    size.largestFiles.length > 0
      ? ` Largest files: ${listed(size.largestFiles)}.`
      : "";
  const raise =
    size.limitBytes < size.maximumLimitBytes
      ? ` or raise native.sourceLimitMiB in .hack/hack.config.json (maximum ${size.maximumLimitBytes / MIB})`
      : "";
  return `${directories}${files} Exclude paths the containers do not need in the project's .gitignore or .ignore file (for example a line such as \`assets/video/\`)${raise}.`;
}

/**
 * Refuse a project whose selected source exceeds its native source limit, before
 * hooks, runtime start, image pulls or builds. The capture enforces the same limit
 * again, so this check is an early report, not the only gate.
 */
export async function requireNativeSourceWithinLimit(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeSourceSize> {
  const size = await readNativeSourceSize(opts);
  if (!size.withinLimit) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: `${describeNativeSourceSize(size)} Native up refuses source over the limit; no runtime, image or build work was started.${nativeSourceSizeRemedy(size)}`,
    });
  }
  return size;
}

/**
 * Apply {@link requireNativeSourceWithinLimit} only to a startup that captures source:
 * one whose selected Compose services bind-mount project source or declare a
 * dependency cache ({@link nativeComposeSourceCaptured}, the predicate the startup
 * source flags use). An image-only graph never reads source content, so its checkout
 * size is not limited and nothing is measured; the result is then `undefined`.
 * `up` and the restart preflight both decide here, so a restart never stops a graph
 * that its replacement startup would refuse for size.
 */
export async function requireCapturedNativeSourceWithinLimit(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  /** The selected Compose services, keyed by name, before review. */
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly profiles: readonly string[] | undefined;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly check?: typeof requireNativeSourceWithinLimit;
}): Promise<NativeSourceSize | undefined> {
  if (
    !nativeComposeSourceCaptured({
      services: opts.services,
      profiles: opts.profiles,
    })
  ) {
    return undefined;
  }
  return await (opts.check ?? requireNativeSourceWithinLimit)({
    runtime: opts.runtime,
    projectRoot: opts.projectRoot,
    signal: opts.signal,
    invoke: opts.invoke,
  });
}
