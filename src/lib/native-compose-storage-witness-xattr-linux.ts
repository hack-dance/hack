import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
} from "node:fs";
import {
  NATIVE_STORAGE_XATTR_BYTES,
  type NativeComposeStorageXattrRoot,
  nativeComposeStorageXattrRootValid,
  refuseNativeComposeStorageXattr as refuse,
} from "./native-compose-storage-witness-xattr-codec.ts";
import type { NativeComposeStorageXattrKernel } from "./native-compose-storage-witness-xattr-helper.ts";

const XATTR_NAME = /^user\.hack\.storage\.[a-f0-9]{64}$/;

/** Source contract only. Image/Bun/libc/program hashes and engine mounts require external qualification. */
export const NATIVE_STORAGE_XATTR_LINUX_ABI = Object.freeze({
  version: 1,
  root: "/hack-storage-witness",
  xattrCreate: 1,
  fGetFd: 1,
  fdCloseExec: 1,
  pointerBits: 64,
  sizeTBits: 64,
  signedSizeBits: 64,
  arm64: Object.freeze({
    libc: "/lib/aarch64-linux-gnu/libc.so.6",
    directory: 1 << 14,
    noFollow: 1 << 15,
  }),
  x64: Object.freeze({
    libc: "/lib/x86_64-linux-gnu/libc.so.6",
    directory: 1 << 16,
    noFollow: 1 << 17,
  }),
});

function directory(info: BigIntStats): NativeComposeStorageXattrRoot {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return refuse();
  }
  const value = {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    uid: Number(info.uid),
    gid: Number(info.gid),
  };
  if (!nativeComposeStorageXattrRootValid(value)) {
    return refuse();
  }
  return Object.freeze(value);
}
function libc(): string {
  let abi: {
    readonly libc: string;
    readonly directory: number;
    readonly noFollow: number;
  } | null = null;
  if (process.arch === "arm64") {
    abi = NATIVE_STORAGE_XATTR_LINUX_ABI.arm64;
  } else if (process.arch === "x64") {
    abi = NATIVE_STORAGE_XATTR_LINUX_ABI.x64;
  }
  if (
    process.platform !== "linux" ||
    !abi ||
    constants.O_DIRECTORY !== abi.directory ||
    constants.O_NOFOLLOW !== abi.noFollow ||
    constants.O_RDONLY !== 0 ||
    !process.geteuid ||
    !process.getegid ||
    !process.getuid ||
    !process.getgid ||
    process.getuid() !== process.geteuid() ||
    process.getgid() !== process.getegid()
  ) {
    return refuse();
  }
  return abi.libc;
}

/** Never called by the CLI or offline controls. A qualified Linux helper is its only intended caller. */
export async function createNativeComposeStorageXattrLinuxKernel(): Promise<{
  readonly kernel: NativeComposeStorageXattrKernel;
  readonly close: () => void;
}> {
  const libraryPath = libc();
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen(libraryPath, {
    fsetxattr: {
      args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32],
      returns: FFIType.i32,
    },
    fgetxattr: {
      args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    fcntl: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const { fsetxattr, fgetxattr, fcntl } = library.symbols;
  const held = new Set<number>();
  let closed = false;
  const active = () => {
    if (closed) {
      refuse();
    }
  };
  const fdOwned = (fd: number) => {
    active();
    if (!held.has(fd)) {
      refuse();
    }
  };
  const nameBytes = (name: string) => {
    if (!XATTR_NAME.test(name)) {
      return refuse();
    }
    return Buffer.from(`${name}\0`, "ascii");
  };
  const kernel: NativeComposeStorageXattrKernel = Object.freeze({
    effectiveUid: () => process.geteuid?.() ?? refuse(),
    effectiveGid: () => process.getegid?.() ?? refuse(),
    probeRoot() {
      active();
      return directory(
        lstatSync(NATIVE_STORAGE_XATTR_LINUX_ABI.root, {
          bigint: true,
        })
      );
    },
    openRoot() {
      active();
      const fd = openSync(
        NATIVE_STORAGE_XATTR_LINUX_ABI.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      held.add(fd);
      const flags = fcntl(fd, NATIVE_STORAGE_XATTR_LINUX_ABI.fGetFd, 0);
      if (
        flags < 0 ||
        (flags & NATIVE_STORAGE_XATTR_LINUX_ABI.fdCloseExec) === 0
      ) {
        held.delete(fd);
        closeSync(fd);
        return refuse();
      }
      return fd;
    },
    statRoot(fd) {
      fdOwned(fd);
      return directory(fstatSync(fd, { bigint: true }));
    },
    createXattr(fd, name, value) {
      fdOwned(fd);
      if (value.byteLength !== NATIVE_STORAGE_XATTR_BYTES) {
        return refuse();
      }
      const selectedName = nameBytes(name);
      const bytes = Buffer.from(value);
      if (
        fsetxattr(
          fd,
          ptr(selectedName),
          ptr(bytes),
          BigInt(bytes.length),
          NATIVE_STORAGE_XATTR_LINUX_ABI.xattrCreate
        ) !== 0
      ) {
        return refuse();
      }
    },
    syncRoot(fd) {
      fdOwned(fd);
      // Metadata synchronization is mandatory; never substitute fdatasync.
      fsyncSync(fd);
    },
    readXattr(fd, name, bytes) {
      fdOwned(fd);
      if (bytes !== NATIVE_STORAGE_XATTR_BYTES) {
        return refuse();
      }
      const selectedName = nameBytes(name);
      const value = Buffer.alloc(bytes);
      if (
        fgetxattr(fd, ptr(selectedName), ptr(value), BigInt(bytes)) !==
        BigInt(bytes)
      ) {
        return refuse();
      }
      return new Uint8Array(value);
    },
    closeRoot(fd) {
      fdOwned(fd);
      held.delete(fd);
      closeSync(fd);
    },
  });
  return Object.freeze({
    kernel,
    close() {
      active();
      closed = true;
      try {
        for (const fd of held) {
          closeSync(fd);
        }
      } finally {
        held.clear();
        library.close();
      }
    },
  });
}
