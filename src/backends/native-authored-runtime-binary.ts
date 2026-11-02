import {
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { sameFile } from "../lib/native-compose-private-state.ts";
import type { NativeAuthoredReceipt } from "./native-authored-graph-protocol.ts";
import {
  type NativeAuthoredProjectRunScope,
  type NativeAuthoredProjectRunSelection,
  nativeAuthoredProjectNamespace,
} from "./native-authored-project-run.ts";

/** Re-admission of the pinned runtime binary after any awaited owner admission. */
export type PinnedRuntimeBinary = {
  /** Awaited recheck of the named path, the held descriptor and the realpath. */
  readonly check: () => Promise<void>;
  /** The same recheck without yielding, for the window between the last await and spawn. */
  readonly checkSync: () => void;
};

/**
 * The shared admission contract for authored ps, logs and exec: the opened
 * incarnation must be a regular, singly linked, non-group/world-writable
 * executable whose named path and held descriptor still match it exactly.
 */
function replaced(original: Stats, named: Stats, held: Stats): boolean {
  return (
    !original.isFile() ||
    original.nlink !== 1 ||
    (original.mode & 0o022) !== 0 ||
    (original.mode & 0o111) === 0 ||
    !named.isFile() ||
    !sameFile(original, named) ||
    !sameFile(original, held) ||
    [named, held].some(
      (info) =>
        info.size !== original.size ||
        info.mtimeMs !== original.mtimeMs ||
        info.ctimeMs !== original.ctimeMs ||
        info.mode !== original.mode ||
        info.uid !== original.uid ||
        info.gid !== original.gid ||
        info.nlink !== 1
    )
  );
}

/**
 * Hold one read-only, non-following descriptor on the selected runtime binary for
 * the duration of `action`. Each check refuses through the caller's closed refusal
 * when the request was canceled or the binary drifted from its opened incarnation;
 * filesystem failures from opening or observing the path propagate unchanged.
 */
export async function withPinnedRuntimeBinary<T>(
  input: {
    readonly binary: string;
    readonly signal?: AbortSignal;
    readonly refused: () => never;
  },
  action: (pin: PinnedRuntimeBinary) => Promise<T>
): Promise<T> {
  const { binary, signal, refused } = input;
  const active = () => {
    if (signal?.aborted) {
      return refused();
    }
  };
  if ((await realpath(binary)) !== binary) {
    return refused();
  }
  const file = await open(
    binary,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const original = await file.stat();
    const check = async () => {
      active();
      const named = await lstat(binary),
        held = await file.stat();
      if (
        replaced(original, named, held) ||
        (await realpath(binary)) !== binary
      ) {
        return refused();
      }
      active();
    };
    const checkSync = () => {
      active();
      const named = lstatSync(binary),
        held = fstatSync(file.fd);
      if (replaced(original, named, held) || realpathSync(binary) !== binary) {
        return refused();
      }
      active();
    };
    return await action({ check, checkSync });
  } finally {
    await file.close();
  }
}

/**
 * The saved ready run must belong to this scope's namespace and own a container
 * for the requested service. Returns null for the caller's own closed refusal.
 */
export function requireReadyServiceReceipt(
  saved: { readonly ready: NativeAuthoredProjectRunSelection | null },
  scope: NativeAuthoredProjectRunScope,
  service: string
): NativeAuthoredReceipt | null {
  if (!saved.ready) {
    return null;
  }
  const receipt = saved.ready.record.receipt;
  if (
    receipt.review.provenance.namespace !==
      nativeAuthoredProjectNamespace(scope) ||
    !Object.hasOwn(receipt.readiness, service) ||
    !receipt.resources[`container:${service}`]?.id
  ) {
    return null;
  }
  return receipt;
}
