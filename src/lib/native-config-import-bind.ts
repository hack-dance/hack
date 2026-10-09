import { posix } from "node:path";
import { isRecord } from "./guards.ts";
import { literalComposeArg } from "./native-config-import-argv.ts";

const UNSAFE_PATH = /[\\\0\r\n:]/;
const TARGET = /^\/[a-zA-Z0-9_./-]+$/;
const PRIVATE_DIRECTORIES = [".git", ".hack/.internal", ".hack/.branch"];

export type LegacyComposeSourceBind = {
  /** Private checkout-relative literal, rebased from the canonical `.hack` Compose directory. */
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly short: boolean;
};

/**
 * Closed pure directory-bind intent. Long syntax must explicitly disable host
 * path creation. Short syntax is admitted only by the retained-existing owner:
 * Compose would otherwise create a missing directory, unlike the native mount.
 * No path is opened or created here. An existing checkout-root bind is allowed;
 * explicitly selected Git/managed-state directories remain unsupported.
 */
export function mapLegacyComposeSourceBind(
  value: unknown,
  opts: { readonly retainedExisting: boolean }
): LegacyComposeSourceBind | undefined {
  const short = typeof value === "string";
  let rawSource: unknown;
  let rawTarget: unknown;
  let readOnly: unknown = false;
  if (short) {
    if (!opts.retainedExisting) {
      return undefined;
    }
    const parts = value.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
      return undefined;
    }
    [rawSource, rawTarget] = parts;
    if (parts.length === 3) {
      if (parts[2] !== "ro" && parts[2] !== "rw") {
        return undefined;
      }
      readOnly = parts[2] === "ro";
    }
  } else if (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["type", "source", "target", "read_only", "bind"].includes(key)
    ) &&
    value.type === "bind" &&
    isRecord(value.bind) &&
    Object.keys(value.bind).join() === "create_host_path" &&
    value.bind.create_host_path === false
  ) {
    rawSource = value.source;
    rawTarget = value.target;
    readOnly = Object.hasOwn(value, "read_only") ? value.read_only : false;
  } else {
    return undefined;
  }
  const decoded = literalComposeArg(rawSource);
  const target = literalComposeArg(rawTarget);
  if (
    decoded === undefined ||
    decoded.length > 1024 ||
    !(
      decoded === "." ||
      decoded === ".." ||
      decoded.startsWith("./") ||
      decoded.startsWith("../")
    ) ||
    UNSAFE_PATH.test(decoded) ||
    target === undefined ||
    !TARGET.test(target) ||
    posix.normalize(target) !== target ||
    target.endsWith("/") ||
    typeof readOnly !== "boolean"
  ) {
    return undefined;
  }
  const source = posix.normalize(`.hack/${decoded}`).replace(/\/$/, "");
  if (
    source === ".." ||
    source.startsWith("../") ||
    source.split("/").length > 32 ||
    PRIVATE_DIRECTORIES.some(
      (path) => source === path || source.startsWith(`${path}/`)
    )
  ) {
    return undefined;
  }
  return Object.freeze({ source, target, readOnly, short });
}

export function legacyComposeMountTargetsOverlap(
  a: string,
  b: string
): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
