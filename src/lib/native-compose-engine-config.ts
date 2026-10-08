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

const CONFIG_LIMIT = 1024 * 1024;
const ASCII_FIELD = /^[\x20-\x7e]+$/;
type Entry = { readonly path: string; readonly identity: readonly number[] };
type ConfigBinding = {
  readonly path: string;
  readonly entries: readonly Entry[];
  readonly missing: string | null;
  readonly sha256: string | null;
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
function eligibleFile(path: string, named: Stats): string | null {
  if (!(named.isFile() && named.size <= CONFIG_LIMIT)) {
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
    // The existing bounded strict parser rejects decoded duplicate keys. Go's
    // Docker decoder also matches field names without case, so inspect that set.
    const { value } = parseImportDocument({ text, document: "config" });
    if (!value || Object.keys(value).some((key) => !ASCII_FIELD.test(key))) {
      return null;
    }
    const headers = Object.entries(value).filter(
      ([key]) => key.toLowerCase() === "httpheaders"
    );
    if (
      headers.length > 1 ||
      headers.some(
        ([, value]) => !isRecord(value) || Object.keys(value).length > 0
      )
    ) {
      return null;
    }
    return new Bun.CryptoHasher("sha256").update(data).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function configPath(
  environment: Readonly<Record<string, string | undefined>>
): string | null {
  const directory =
    environment.DOCKER_CONFIG ||
    (environment.HOME ? join(environment.HOME, ".docker") : null);
  return directory &&
    isAbsolute(directory) &&
    normalize(directory) === directory
    ? join(directory, "config.json")
    : null;
}

/**
 * Eligibility only: configured headers, ambiguous paths and unreadable inputs
 * keep Docker's CLI transport. Never return parsed configuration or diagnostics.
 * Once admitted, compare this named-path/content binding before and after reads;
 * a changed or newly ineligible config must refuse, never select another transport.
 */
export function bindNativeComposeEngineConfig(
  environment: Readonly<Record<string, string | undefined>>
): ConfigBinding | null {
  try {
    const path = configPath(environment);
    if (path === null) {
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
          return { path, entries, missing: current, sha256: null };
        }
        return null;
      }
      if (info.isSymbolicLink()) {
        return null;
      }
      entries.push({ path: current, identity: identity(info) });
      if (current === path) {
        const sha256 = eligibleFile(path, info);
        return sha256 === null
          ? null
          : { path, entries, missing: null, sha256 };
      }
      if (!info.isDirectory()) {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
