import {
  decodeNativeComposeStorageXattrRequest,
  NATIVE_STORAGE_XATTR_BYTES,
  NATIVE_STORAGE_XATTR_KIND,
  NATIVE_STORAGE_XATTR_VERSION,
  type NativeComposeStorageXattrResponse,
  type NativeComposeStorageXattrRoot,
  nativeComposeStorageXattrRootValid,
  nativeComposeStorageXattrValueMatches,
  refuseNativeComposeStorageXattr as refuse,
  sameNativeComposeStorageXattrRoot,
} from "./native-compose-storage-witness-xattr-codec.ts";

/** Synchronous fixed-root syscall boundary. Offline tests substitute ports; no engine transport lives here. */
export type NativeComposeStorageXattrKernel = {
  readonly effectiveUid: () => number;
  readonly effectiveGid: () => number;
  readonly probeRoot: () => NativeComposeStorageXattrRoot;
  readonly openRoot: () => number;
  readonly statRoot: (fd: number) => NativeComposeStorageXattrRoot;
  readonly createXattr: (fd: number, name: string, value: Uint8Array) => void;
  readonly syncRoot: (fd: number) => void;
  readonly readXattr: (fd: number, name: string, bytes: number) => Uint8Array;
  readonly closeRoot: (fd: number) => void;
};

function root(value: unknown): NativeComposeStorageXattrRoot {
  if (!nativeComposeStorageXattrRootValid(value)) {
    return refuse();
  }
  return Object.freeze({ ...value });
}
function requireRoot(
  actual: NativeComposeStorageXattrRoot,
  expected: NativeComposeStorageXattrRoot
): void {
  if (!sameNativeComposeStorageXattrRoot(root(actual), expected)) {
    refuse();
  }
}
/** Never reports enrollment or generation readiness. Only the enclosing owner can publish either. */
export function runNativeComposeStorageXattrHelper(opts: {
  readonly request: unknown;
  readonly kernel: NativeComposeStorageXattrKernel;
}): NativeComposeStorageXattrResponse {
  let fd: number | null = null;
  let capturedClose: ((fd: number) => void) | null = null;
  try {
    const request = decodeNativeComposeStorageXattrRequest(opts.request);
    const {
      effectiveUid,
      effectiveGid,
      probeRoot,
      openRoot,
      statRoot,
      createXattr,
      syncRoot,
      readXattr,
      closeRoot,
    } = opts.kernel;
    capturedClose = closeRoot;
    if (request.operation === "root") {
      const before = root(probeRoot());
      requireRoot(probeRoot(), before);
      return {
        kind: NATIVE_STORAGE_XATTR_KIND,
        version: NATIVE_STORAGE_XATTR_VERSION,
        outcome: "root",
        root: before,
      };
    }
    if (
      effectiveUid() !== request.root.uid ||
      effectiveGid() !== request.root.gid
    ) {
      return refuse();
    }
    fd = openRoot();
    if (!Number.isInteger(fd) || fd < 0) {
      return refuse();
    }
    requireRoot(statRoot(fd), request.root);
    let response: NativeComposeStorageXattrResponse;
    if (request.operation === "seed") {
      createXattr(fd, request.name, Buffer.from(request.valueHex, "hex"));
      syncRoot(fd);
      requireRoot(statRoot(fd), request.root);
      response = {
        kind: NATIVE_STORAGE_XATTR_KIND,
        version: NATIVE_STORAGE_XATTR_VERSION,
        outcome: "seeded",
        root: request.root,
      };
    } else {
      const first = readXattr(fd, request.name, NATIVE_STORAGE_XATTR_BYTES);
      if (!nativeComposeStorageXattrValueMatches(first, request.valueHex)) {
        return refuse();
      }
      requireRoot(statRoot(fd), request.root);
      const latest = readXattr(fd, request.name, NATIVE_STORAGE_XATTR_BYTES);
      if (!nativeComposeStorageXattrValueMatches(latest, request.valueHex)) {
        return refuse();
      }
      requireRoot(statRoot(fd), request.root);
      response = {
        kind: NATIVE_STORAGE_XATTR_KIND,
        version: NATIVE_STORAGE_XATTR_VERSION,
        outcome: "verified",
        root: request.root,
        valueHex: Buffer.from(latest).toString("hex"),
      };
    }
    // A failed close is not a completed helper proof, and must never be hidden.
    const selected = fd;
    fd = null;
    closeRoot(selected);
    return response;
  } catch {
    return {
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: "refused",
    };
  } finally {
    if (fd !== null && Number.isInteger(fd) && fd >= 0 && capturedClose) {
      try {
        capturedClose(fd);
      } catch {
        // The fixed refusal already represents uncertain completion; no error text escapes.
      }
    }
  }
}
