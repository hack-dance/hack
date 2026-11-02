import { posix } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type NativeComposeFileMode,
  nativeComposeFileMode,
} from "./native-compose-file-permissions.ts";
import { literalComposeArg } from "./native-config-import-argv.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNSAFE_PATH = /[\\\0\r\n:]/;

export type ImportedFileKind = "config" | "secret";
export type ImportedFileGrant =
  | {
      readonly config: string;
      readonly target: string;
      readonly access: "read-only";
      readonly mode: NativeComposeFileMode;
    }
  | {
      readonly secret: string;
      readonly target: string;
      readonly access: "read-only";
      readonly mode: NativeComposeFileMode;
    };
export type ImportedFileGrantMapping = {
  readonly grant: ImportedFileGrant;
  /** Only retained-purpose mappings preserve omission as distinct private intent. */
  readonly declaredMode?: NativeComposeFileMode | null;
  readonly fields: readonly {
    readonly source: string;
    readonly target: string;
    readonly code: string;
  }[];
};
export type RetainedFilePermissionPolicy = {
  readonly service: string;
  readonly kind: ImportedFileKind;
  readonly name: string;
  readonly target: string;
  readonly declaredMode: NativeComposeFileMode | null;
};

/** Read only own enumerable data fields; accessor/prototype authority is never acquired. */
function dataRecord(
  value: unknown,
  allowed: readonly string[]
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.includes(key)
    )
  ) {
    return undefined;
  }
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!(descriptor.enumerable && Object.hasOwn(descriptor, "value"))) {
      return undefined;
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && NAME.test(value);
}

/** Raw file declarations are based at `.hack`, not cwd. No material/path/env lookup occurs. */
export function mapLegacyComposeFileDeclaration(
  value: unknown
): { readonly file: string } | undefined {
  const source = dataRecord(value, ["file"]);
  const decoded =
    source && Object.hasOwn(source, "file")
      ? literalComposeArg(source.file)
      : undefined;
  if (
    decoded === undefined ||
    decoded.length === 0 ||
    UNSAFE_PATH.test(decoded) ||
    decoded.startsWith("/") ||
    decoded.startsWith("~") ||
    decoded.endsWith("/")
  ) {
    return undefined;
  }
  const file = posix.normalize(`.hack/${decoded}`);
  if (
    file === "." ||
    file === ".hack" ||
    file === ".." ||
    file.startsWith("../")
  ) {
    return undefined;
  }
  return { file };
}

function absoluteTarget(value: string): string | undefined {
  return value.startsWith("/") &&
    value !== "/" &&
    !UNSAFE_PATH.test(value) &&
    !value.endsWith("/") &&
    posix.normalize(value) === value
    ? value
    : undefined;
}

function target(kind: ImportedFileKind, raw: unknown): string | undefined {
  const decoded = literalComposeArg(raw);
  if (
    decoded === undefined ||
    decoded.length === 0 ||
    UNSAFE_PATH.test(decoded)
  ) {
    return undefined;
  }
  if (decoded.startsWith("/")) {
    return absoluteTarget(decoded);
  }
  return kind === "secret" &&
    decoded !== "." &&
    decoded !== ".." &&
    !decoded.includes("/") &&
    !decoded.startsWith("~")
    ? `/run/secrets/${decoded}`
    : undefined;
}

function declaredMode(
  source: Record<string, unknown>
): NativeComposeFileMode | null | undefined {
  if (!Object.hasOwn(source, "mode")) {
    return null;
  }
  const raw = source.mode;
  return typeof raw === "number"
    ? new Map<number, NativeComposeFileMode>([
        [0o444, "0444"],
        [0o400, "0400"],
        [0o600, "0600"],
      ]).get(raw)
    : nativeComposeFileMode(raw);
}

function grantFields(opts: {
  readonly source: Record<string, unknown>;
  readonly kind: ImportedFileKind;
  readonly destination: string;
  readonly mode: NativeComposeFileMode;
  readonly shorthand: boolean;
}) {
  const fields = [
    { source: "", target: "", code: "compose_linux_file_grant_policy" },
  ];
  if (opts.shorthand) {
    return fields;
  }
  fields.push({ source: "source", target: opts.kind, code: "exact" });
  if (Object.hasOwn(opts.source, "target")) {
    fields.push({
      source: "target",
      target: "target",
      code:
        opts.source.target === opts.destination
          ? "exact"
          : "compose_file_target_normalized",
    });
  }
  if (Object.hasOwn(opts.source, "mode")) {
    fields.push({
      source: "mode",
      target: "mode",
      code:
        opts.source.mode === opts.mode ? "exact" : "compose_file_mode_octal",
    });
  }
  return fields;
}

/** Explicit Linux grants only; defaults normalize declaration intent, not source-file mode or bind fidelity. */
export function mapLegacyComposeFileGrant(opts: {
  readonly kind: ImportedFileKind;
  readonly value: unknown;
  readonly retainedPermissions?: boolean;
}): ImportedFileGrantMapping | undefined {
  const shorthand = typeof opts.value === "string";
  const source: Record<string, unknown> | undefined = shorthand
    ? { source: opts.value }
    : dataRecord(opts.value, ["source", "target", "mode"]);
  if (!(source && Object.hasOwn(source, "source") && name(source.source))) {
    return undefined;
  }
  const authoredMode = declaredMode(source);
  if (
    authoredMode === undefined ||
    (authoredMode !== null &&
      authoredMode !== "0444" &&
      !(opts.retainedPermissions === true && opts.kind === "secret"))
  ) {
    return undefined;
  }
  const mode = authoredMode ?? "0444";
  const defaultTarget =
    opts.kind === "config"
      ? `/${source.source}`
      : `/run/secrets/${source.source}`;
  const destination = Object.hasOwn(source, "target")
    ? target(opts.kind, source.target)
    : defaultTarget;
  if (destination === undefined) {
    return undefined;
  }
  const grant: ImportedFileGrant =
    opts.kind === "config"
      ? {
          config: source.source,
          target: destination,
          access: "read-only",
          mode,
        }
      : {
          secret: source.source,
          target: destination,
          access: "read-only",
          mode,
        };
  const fields = grantFields({
    source,
    kind: opts.kind,
    destination,
    mode,
    shorthand,
  });
  return {
    grant,
    fields,
    ...(opts.retainedPermissions === true
      ? { declaredMode: authoredMode }
      : {}),
  };
}
