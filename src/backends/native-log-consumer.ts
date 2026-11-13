import { fstatSync } from "node:fs";
import type { Writable } from "node:stream";

/** Observe a closed consumer without sending probe bytes into its log stream. */
export async function watchLogConsumer(output: Writable, closed: () => void) {
  output.on("close", closed);
  let disposePoll: () => void = () => undefined;
  try {
    if (output === process.stdout && !process.stdout.isTTY) {
      const stat = fstatSync(process.stdout.fd);
      if (stat.isFIFO() || stat.isSocket()) {
        disposePoll =
          process.platform === "darwin"
            ? await watchDarwinPipe(closed)
            : await watchPosixPipe(closed);
      }
    }
  } catch {
    // FFI unavailable: retain the ordinary close event and write-time EPIPE path.
  }
  return () => {
    disposePoll();
    output.off("close", closed);
  };
}
async function watchPosixPipe(closed: () => void) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen("libc.so.6", {
    poll: {
      args: [FFIType.ptr, FFIType.u64, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  // POSIX pollfd: int fd, short events, short revents. Error/hangup only.
  const bytes = new Int32Array(2);
  bytes[0] = process.stdout.fd;
  const flags = new Int16Array(bytes.buffer);
  const timer = setInterval(() => {
    flags[3] = 0;
    if (library.symbols.poll(ptr(bytes), 1, 0) > 0 && (flags[3] & 0x38) !== 0) {
      closed();
    }
  }, 50);
  timer.unref();
  return () => {
    clearInterval(timer);
    library.close();
  };
}
async function watchDarwinPipe(closed: () => void) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    kqueue: { args: [], returns: FFIType.i32 },
    kevent: {
      args: [
        FFIType.i32,
        FFIType.ptr,
        FFIType.i32,
        FFIType.ptr,
        FFIType.i32,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  const queue = library.symbols.kqueue();
  if (queue < 0) {
    library.close();
    throw new Error("Log consumer observation unavailable");
  }
  // Darwin 64-bit kevent layout (32 bytes). Buffers remain alive across each
  // synchronous native call. Only our kqueue is closed; fd 1 remains borrowed.
  const change = new Uint8Array(32),
    event = new Uint8Array(32);
  const view = new DataView(change.buffer),
    result = new DataView(event.buffer);
  view.setBigUint64(0, BigInt(process.stdout.fd), true);
  view.setInt16(8, -2, true); // EVFILT_WRITE
  view.setUint16(10, 5, true); // EV_ADD | EV_ENABLE
  const timeout = new BigInt64Array(2); // Nonblocking, zero timespec.
  if (
    library.symbols.kevent(queue, ptr(change), 1, null, 0, ptr(timeout)) < 0
  ) {
    library.symbols.close(queue);
    library.close();
    throw new Error("Log consumer observation unavailable");
  }
  const timer = setInterval(() => {
    if (
      library.symbols.kevent(queue, null, 0, ptr(event), 1, ptr(timeout)) > 0 &&
      (result.getUint16(10, true) & 0x80_00) !== 0
    ) {
      closed();
    }
  }, 50);
  timer.unref();
  return () => {
    clearInterval(timer);
    library.symbols.close(queue);
    library.close();
  };
}
