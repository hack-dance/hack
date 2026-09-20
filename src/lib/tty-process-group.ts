import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";

/** POSIX job control without a proxy PTY: all three command streams stay intact. */
export function openTerminalControl() {
  const symbols = {
    setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    getpgrp: { args: [], returns: FFIType.i32 },
    tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
    tcsetpgrp: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    tcsetattr: {
      args: [FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  } as const;
  const library =
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const libc = dlopen(library, symbols);
  const controllingDescriptor = openControllingTerminal();
  const descriptor = controllingDescriptor ?? 0;
  function withoutBackgroundStop<T>(operation: () => T): T {
    const previous = libc.symbols.signal(
      constants.signals.SIGTTOU,
      1 as Pointer
    );
    try {
      return operation();
    } finally {
      libc.symbols.signal(constants.signals.SIGTTOU, previous);
    }
  }
  return {
    createGroup: () => libc.symbols.setpgid(0, 0) === 0,
    group: () => libc.symbols.getpgrp(),
    foreground: () => libc.symbols.tcgetpgrp(descriptor),
    setForeground: (group: number) =>
      withoutBackgroundStop(
        () => libc.symbols.tcsetpgrp(descriptor, group) === 0
      ),
    attributes: () => {
      // Opaque termios storage, larger than both Darwin and Linux structures.
      const value = new Uint8Array(256);
      return libc.symbols.tcgetattr(descriptor, value) === 0 ? value : null;
    },
    restoreAttributes: (value: Uint8Array | null) => {
      if (value) {
        withoutBackgroundStop(() =>
          libc.symbols.tcsetattr(descriptor, 0, value)
        );
      }
    },
    close: () => {
      if (controllingDescriptor !== null) {
        closeSync(controllingDescriptor);
      }
      libc.close();
    },
  };
}

export function signalOwnedGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The owned group may already have exited.
  }
}

function openControllingTerminal(): number | null {
  try {
    return openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
}

export function hasControllingTerminal(): boolean {
  const descriptor = openControllingTerminal();
  if (descriptor === null) {
    return false;
  }
  closeSync(descriptor);
  return true;
}
