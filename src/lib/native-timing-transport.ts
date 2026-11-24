/** Loaded only for explicitly requested timings; no filesystem/socket paths. */
import { dlopen, ptr, FFIType as T } from "bun:ffi";

const mac = process.platform === "darwin";
const HOST_CLOCK = mac ? 8 : 1; // CLOCK_UPTIME_RAW / CLOCK_MONOTONIC
const AF_UNIX = 1,
  SOCK_DGRAM = 2;
const F_SETFD = 2,
  FD_CLOEXEC = 1,
  F_GETFL = 3,
  F_SETFL = 4;
const F_GETFD = 1;
const O_NONBLOCK = mac ? 4 : 2048;
const MSG_DONTWAIT = mac ? 0x80 : 0x40;
const stackVararg = mac && process.arch === "arm64";
const SOL_SOCKET = mac ? 0xff_ff : 1,
  SO_RCVBUF = mac ? 0x10_02 : 8;
const { symbols: c } = dlopen(
  mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  {
    clock_gettime: { args: [T.i32, T.ptr], returns: T.i32 },
    socketpair: { args: [T.i32, T.i32, T.i32, T.ptr], returns: T.i32 },
    fcntl: {
      args: new Array<T>(stackVararg ? 9 : 3).fill(T.i32),
      returns: T.i32,
    },
    setsockopt: { args: [T.i32, T.i32, T.i32, T.ptr, T.u32], returns: T.i32 },
    getsockopt: { args: [T.i32, T.i32, T.i32, T.ptr, T.ptr], returns: T.i32 },
    send: { args: [T.i32, T.ptr, T.u64, T.i32], returns: T.i64 },
    recv: { args: [T.i32, T.ptr, T.u64, T.i32], returns: T.i64 },
    close: { args: [T.i32], returns: T.i32 },
  }
);
// Apple arm64 passes the variadic argument on the stack. Fill the eight
// integer registers in the fixed FFI signature to place it there.
function fcntl(fd: number, command: number, value = 0) {
  return stackVararg
    ? c.fcntl(fd, command, 0, 0, 0, 0, 0, 0, value)
    : c.fcntl(fd, command, value);
}
/** A disconnected launcher or a full queue must never stall the owner. */
export function sendTimingLine(fd: number, line: string): void {
  const bytes = Buffer.from(line);
  c.send(fd, ptr(bytes), bytes.length, MSG_DONTWAIT);
}

export function protectTimingFd(fd: number): boolean {
  return (
    fcntl(fd, F_SETFD, FD_CLOEXEC) === 0 && fcntl(fd, F_GETFD) === FD_CLOEXEC
  );
}

export function hostMonotonicUs(): number | undefined {
  // All supported CLI targets have a 64-bit timespec (two 64-bit longs).
  const time = new BigInt64Array(2);
  if (c.clock_gettime(HOST_CLOCK, ptr(time)) !== 0) {
    return;
  }
  const us = Number((time[0] ?? 0n) * 1000000n + (time[1] ?? 0n) / 1000n);
  return Number.isSafeInteger(us) && us >= 0 ? us : undefined;
}
export function timingChannel() {
  const fds = new Int32Array(2);
  if (c.socketpair(AF_UNIX, SOCK_DGRAM, 0, ptr(fds)) !== 0) {
    throw new Error("Timing socket creation failed; values omitted.");
  }
  const receiver = fds[0] as number,
    sender = fds[1] as number;
  let sent = false,
    closed = false;
  const closeSender = () => {
    if (!sent) {
      sent = true;
      c.close(sender);
    }
  };
  const close = () => {
    if (!closed) {
      closed = true;
      closeSender();
      c.close(receiver);
    }
  };
  try {
    const flags = fcntl(receiver, F_GETFL);
    if (
      flags < 0 ||
      !protectTimingFd(receiver) ||
      !protectTimingFd(sender) ||
      fcntl(receiver, F_SETFL, flags | O_NONBLOCK) < 0 ||
      fcntl(receiver, F_GETFL) !== (flags | O_NONBLOCK)
    ) {
      throw new Error("Timing socket setup failed.");
    }
    const size = new Int32Array([256 * 1024]);
    if (c.setsockopt(receiver, SOL_SOCKET, SO_RCVBUF, ptr(size), 4) !== 0) {
      throw new Error("Timing receive buffer setup failed; values omitted.");
    }
    const length = new Uint32Array([4]);
    if (
      c.getsockopt(receiver, SOL_SOCKET, SO_RCVBUF, ptr(size), ptr(length)) !==
        0 ||
      (size[0] ?? 0) < 64 * 1024
    ) {
      throw new Error("Timing receive buffer too small; values omitted.");
    }
  } catch (error) {
    close();
    throw error;
  }
  const bytes = new Uint8Array(16_384),
    decoder = new TextDecoder();
  return {
    sender,
    close,
    closeSender,
    drain(consume: (line: string) => void) {
      if (closed) {
        return;
      }
      for (let i = 0; i < 4096; i++) {
        const count = Number(
          c.recv(receiver, ptr(bytes), bytes.length, MSG_DONTWAIT)
        );
        if (count <= 0) {
          break;
        }
        consume(decoder.decode(bytes.subarray(0, count)));
      }
    },
  };
}
