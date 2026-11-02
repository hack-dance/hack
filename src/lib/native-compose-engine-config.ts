import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, normalize, parse } from "node:path";
import { isRecord } from "./guards.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";

const DOCUMENT_LIMIT = 1024 * 1024;
const ASCII_FIELD = /^[\x20-\x7e]+$/;
type Environment = Readonly<Record<string, string | undefined>>;
type Entry = { readonly path: string; readonly identity: readonly number[] };
/** Named-path facts of one document: each component identity, then content. */
type DocumentBinding = {
  readonly path: string;
  readonly entries: readonly Entry[];
  readonly missing: string | null;
  readonly sha256: string | null;
};
type ConfigBinding = DocumentBinding & {
  /** The client config's `currentContext`, or null when absent or empty. */
  readonly currentContext: string | null;
};

function identity(info: Stats): readonly number[] {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    ...(info.isDirectory()
      ? []
      : [info.nlink, info.size, info.mtimeMs, info.ctimeMs]),
  ];
}
function same(left: readonly number[], right: readonly number[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * lstat every named component from the root without following any link. A
 * missing component ends the walk with that component recorded; a link, a
 * non-directory ancestor or any other error makes the path ineligible.
 */
function walk(path: string): {
  readonly entries: readonly Entry[];
  readonly missing: string | null;
  readonly leaf: Stats | null;
} | null {
  if (!isAbsolute(path) || normalize(path) !== path) {
    return null;
  }
  const root = parse(path).root;
  let current = root;
  const entries: Entry[] = [];
  for (const component of ["", ...path.slice(root.length).split("/")]) {
    current = component ? join(current, component) : current;
    let info: Stats;
    try {
      info = lstatSync(current);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") {
        return { entries, missing: current, leaf: null };
      }
      return null;
    }
    if (info.isSymbolicLink()) {
      return null;
    }
    entries.push({ path: current, identity: identity(info) });
    if (current === path) {
      return { entries, missing: null, leaf: info };
    }
    if (!info.isDirectory()) {
      return null;
    }
  }
  return null;
}

/**
 * Read one bounded strict JSON object through a no-follow descriptor whose
 * identity equals the named entry before and after the read. The existing
 * strict parser rejects decoded duplicate keys; every object key must be
 * printable ASCII so that case-insensitive field matching is exact.
 */
function readDocument<T>(
  path: string,
  named: Stats,
  inspect: (value: Record<string, unknown>) => T | null
): { readonly sha256: string; readonly value: T } | null {
  if (!(named.isFile() && named.size <= DOCUMENT_LIMIT)) {
    return null;
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!same(identity(named), identity(fstatSync(fd)))) {
      return null;
    }
    const bytes = Buffer.alloc(named.size + 1);
    let size = 0;
    while (size < bytes.byteLength) {
      const count = readSync(fd, bytes, size, bytes.byteLength - size, null);
      if (count === 0) {
        break;
      }
      size += count;
    }
    if (
      size !== named.size ||
      !same(identity(named), identity(fstatSync(fd))) ||
      !same(identity(named), identity(lstatSync(path)))
    ) {
      return null;
    }
    const data = bytes.subarray(0, size);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const { value } = parseImportDocument({ text, document: "config" });
    if (!value || Object.keys(value).some((key) => !ASCII_FIELD.test(key))) {
      return null;
    }
    const inspected = inspect(value);
    return inspected === null
      ? null
      : {
          sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
          value: inspected,
        };
  } finally {
    closeSync(fd);
  }
}

/**
 * Go's JSON decoder matches struct fields without case, and a later duplicate
 * spelling overwrites (or merges into) an earlier one. Return the fields by
 * folded name only when every key is printable ASCII and no folded name repeats.
 * With `allowed`, any other folded name is ineligible too.
 */
export function foldNativeComposeEngineFields(
  value: Record<string, unknown>,
  allowed?: readonly string[]
): ReadonlyMap<string, unknown> | null {
  const fields = new Map<string, unknown>();
  for (const [key, field] of Object.entries(value)) {
    const folded = key.toLowerCase();
    if (
      !ASCII_FIELD.test(key) ||
      fields.has(folded) ||
      (allowed !== undefined && !allowed.includes(folded))
    ) {
      return null;
    }
    fields.set(folded, field);
  }
  return fields;
}

/**
 * Bind one named JSON document without following links. Returns null when the
 * path or document is ineligible (including when `inspect` returns null),
 * `found: false` with the first missing component, or the inspected value.
 * Never returns diagnostics or document text; the digest is compared only.
 */
export function bindNativeComposeEngineDocument<T>(opts: {
  readonly path: string;
  readonly inspect: (value: Record<string, unknown>) => T | null;
}):
  | { readonly binding: DocumentBinding; readonly found: false }
  | {
      readonly binding: DocumentBinding;
      readonly found: true;
      readonly value: T;
    }
  | null {
  try {
    const named = walk(opts.path);
    if (named === null) {
      return null;
    }
    if (named.leaf === null) {
      return {
        binding: {
          path: opts.path,
          entries: named.entries,
          missing: named.missing,
          sha256: null,
        },
        found: false,
      };
    }
    const document = readDocument(opts.path, named.leaf, opts.inspect);
    return document === null
      ? null
      : {
          binding: {
            path: opts.path,
            entries: named.entries,
            missing: null,
            sha256: document.sha256,
          },
          found: true,
          value: document.value,
        };
  } catch {
    return null;
  }
}

/**
 * Prove a named path absent without following links or reading anything below
 * it: the binding records each existing ancestor and the first missing
 * component. Any existing entry at the path, a link or an error returns null.
 */
export function bindNativeComposeEngineAbsence(path: string): {
  readonly entries: readonly Entry[];
  readonly missing: string;
} | null {
  try {
    const named = walk(path);
    return named === null || named.missing === null
      ? null
      : { entries: named.entries, missing: named.missing };
  } catch {
    return null;
  }
}

/**
 * The Docker CLI's client config directory: DOCKER_CONFIG, else HOME/.docker.
 * Relative or unnormalized spellings return null and keep the CLI.
 */
export function nativeComposeDockerConfigDirectory(
  environment: Environment
): string | null {
  const directory =
    environment.DOCKER_CONFIG ||
    (environment.HOME ? join(environment.HOME, ".docker") : null);
  return directory &&
    isAbsolute(directory) &&
    normalize(directory) === directory
    ? directory
    : null;
}

function inspectConfig(
  value: Record<string, unknown>
): { readonly currentContext: string | null } | null {
  const fields = foldNativeComposeEngineFields(value);
  if (fields === null) {
    return null;
  }
  const headers = fields.get("httpheaders");
  if (
    headers !== undefined &&
    !(isRecord(headers) && Object.keys(headers).length === 0)
  ) {
    return null;
  }
  const current = fields.get("currentcontext");
  if (current !== undefined && typeof current !== "string") {
    return null;
  }
  return { currentContext: current || null };
}

/**
 * Eligibility only: configured headers, ambiguous paths and unreadable inputs
 * keep Docker's CLI transport. Never return parsed configuration or diagnostics
 * beyond the selected context name. Once admitted, compare this named-path and
 * content binding before and after reads; a changed or newly ineligible config
 * must refuse, never select another transport.
 */
export function bindNativeComposeEngineConfig(
  environment: Environment
): ConfigBinding | null {
  const directory = nativeComposeDockerConfigDirectory(environment);
  if (directory === null) {
    return null;
  }
  const bound = bindNativeComposeEngineDocument({
    path: join(directory, "config.json"),
    inspect: inspectConfig,
  });
  if (bound === null) {
    return null;
  }
  return {
    ...bound.binding,
    currentContext: bound.found ? bound.value.currentContext : null,
  };
}
