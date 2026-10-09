import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { isRecord } from "../lib/guards.ts";
import {
  type HeldDirectory,
  hasCode,
  keys,
  readPrivate,
  sameFile,
  synchronizeDirectories,
  writeExclusive,
} from "../lib/native-compose-private-state.ts";
import {
  type NativeAuthoredReceipt,
  nativeAuthoredReceiptBinding,
} from "./native-authored-graph-protocol.ts";
import {
  requestNativeHookStop,
  serveNativeHookStop,
} from "./native-authored-hook-stop.ts";

const LIMIT = 64 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[a-f0-9]{32}$/;
type Pin = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly sha256: string;
};
export type NativeAuthoredLiveStop = {
  readonly retire: (cleaned: NativeAuthoredReceipt) => Promise<void>;
  readonly close: (force?: boolean) => Promise<void>;
};
type Store = {
  readonly scope: string;
  readonly path: string;
  readonly ready: string;
  readonly start: string;
  readonly source: string;
  readonly hookOwner: string;
  readonly hookStop: string;
  readonly blockers: readonly string[];
  readonly held: readonly HeldDirectory[];
  readonly check: () => Promise<void>;
};
type Record = {
  readonly version: 1;
  readonly kind: "native-authored-live-stop";
  readonly mode: "no-host";
  readonly scope: string;
  readonly run: string;
  readonly ready: Pin;
  readonly start: Pin;
  readonly source: Pin;
  readonly port: number;
  readonly token: string;
};
function refused(): never {
  throw new Error(
    "Native live stop ownership is retained or unconfirmed; values omitted. No stop was replayed."
  );
}
function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  refused();
}
async function capture(path: string, limit = LIMIT) {
  const value = await readPrivate(path, limit);
  return {
    ...value,
    pin: {
      path,
      dev: value.info.dev,
      ino: value.info.ino,
      sha256: digest(value.text),
    },
  };
}
type Captured = Awaited<ReturnType<typeof capture>>;
async function unchanged(saved: Captured, limit = LIMIT) {
  const fresh = await readPrivate(saved.pin.path, limit);
  if (
    !sameFile(saved.info, fresh.info) ||
    saved.info.mtimeMs !== fresh.info.mtimeMs ||
    saved.info.ctimeMs !== fresh.info.ctimeMs ||
    saved.text !== fresh.text
  ) {
    refused();
  }
}
function pin(value: unknown, path: string): Pin {
  if (
    !(isRecord(value) && keys(value, "dev,ino,path,sha256")) ||
    value.path !== path ||
    typeof value.dev !== "number" ||
    !Number.isSafeInteger(value.dev) ||
    value.dev < 0 ||
    typeof value.ino !== "number" ||
    !Number.isSafeInteger(value.ino) ||
    value.ino < 1 ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !SHA.test(value.sha256)
  ) {
    return refused();
  }
  return { path, dev: value.dev, ino: value.ino, sha256: value.sha256 };
}
function parse(value: unknown, store: Store, run: string): Record {
  if (
    !(
      isRecord(value) &&
      keys(value, "kind,mode,port,ready,run,scope,source,start,token,version")
    ) ||
    value.version !== 1 ||
    value.kind !== "native-authored-live-stop" ||
    value.mode !== "no-host" ||
    value.scope !== store.scope ||
    value.run !== run ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    typeof value.token !== "string" ||
    value.token.length !== 64 ||
    !SHA.test(value.token)
  ) {
    return refused();
  }
  return {
    version: 1,
    kind: "native-authored-live-stop",
    mode: "no-host",
    scope: store.scope,
    run,
    ready: pin(value.ready, store.ready),
    start: pin(value.start, store.start),
    source: pin(value.source, store.source),
    port: value.port,
    token: value.token,
  };
}
async function available(store: Store) {
  await store.check();
  for (const path of [...store.blockers, store.hookOwner, store.hookStop]) {
    await absent(path);
  }
  await store.check();
}

/** Private original-admission capability. The endpoint only asks its existing
 * foreground owner to stop; saved bytes never grant dead-owner cleanup authority. */
export async function publishNativeAuthoredLiveStop(input: {
  readonly store: Store;
  readonly run: string;
  readonly receipt: NativeAuthoredReceipt;
  readonly assertOwner: () => Promise<void>;
  readonly stop: () => Promise<boolean>;
  readonly onRefusal?: (stage: "request" | "owner" | "stop") => void;
}): Promise<NativeAuthoredLiveStop> {
  const { run, receipt, assertOwner, stop, onRefusal } = input;
  const store = {
    ...input.store,
    blockers: [...input.store.blockers],
    held: [...input.store.held],
  };
  if (
    run.length !== 32 ||
    !RUN.test(run) ||
    receipt.review.provenance.run !== run
  ) {
    return refused();
  }
  await available(store);
  await absent(store.path);
  const ready = await capture(store.ready),
    start = await capture(store.start),
    source = await capture(store.source, 1024 * 1024);
  let selected: Captured | undefined;
  let active = false;
  const assertFresh = async () => {
    if (!(active && selected)) {
      return refused();
    }
    await assertOwner();
    await available(store);
    await unchanged(ready);
    await unchanged(start);
    await unchanged(source, 1024 * 1024);
    await unchanged(selected);
    await assertOwner();
  };
  const endpoint = await serveNativeHookStop({
    run,
    stop,
    assertFresh,
    onRefusal,
  });
  try {
    const value: Record = {
      version: 1,
      kind: "native-authored-live-stop",
      mode: "no-host",
      scope: store.scope,
      run,
      ready: ready.pin,
      start: start.pin,
      source: source.pin,
      port: endpoint.port,
      token: endpoint.token,
    };
    const text = JSON.stringify(value);
    parse(value, store, run);
    await assertOwner();
    await available(store);
    await unchanged(ready);
    await unchanged(start);
    await unchanged(source, 1024 * 1024);
    const created = await writeExclusive(store.path, text);
    await synchronizeDirectories(store.held);
    selected = await capture(store.path);
    if (!sameFile(created, selected.info) || selected.text !== text) {
      return refused();
    }
    active = true;
    await assertFresh();
    return Object.freeze({
      close: endpoint.close,
      async retire(cleaned: NativeAuthoredReceipt) {
        if (
          cleaned.phase !== "removed" ||
          Object.values(cleaned.resources).some(
            (resource) => resource.phase !== "removed"
          ) ||
          nativeAuthoredReceiptBinding(cleaned) !==
            nativeAuthoredReceiptBinding(receipt)
        ) {
          return refused();
        }
        // Retire this endpoint first: a failed unlink/sync still leaves the exact
        // start/ready/source attempt blocking another startup. Its original graph
        // must already have settled and authenticated Removed before this call.
        await assertFresh();
        await unlink(store.path);
        await synchronizeDirectories(store.held);
        active = false;
      },
    });
  } catch (error) {
    active = false;
    await endpoint.close(true);
    throw error;
  }
}

/** Returns false only for a missing new-format record, allowing the unchanged
 * hook-owner client. Incomplete/malformed/foreign no-host records never fall back. */
export async function requestNativeAuthoredLiveStop(input: {
  readonly store: Store;
  readonly run: string;
  readonly remaining: () => number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const { run, remaining, signal } = input;
  const store = {
    ...input.store,
    blockers: [...input.store.blockers],
    held: [...input.store.held],
  };
  if (run.length !== 32 || !RUN.test(run)) {
    return refused();
  }
  let current: Captured;
  try {
    current = await capture(store.path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  const value = parse(JSON.parse(current.text), store, run);
  const ready = await capture(store.ready),
    start = await capture(store.start),
    source = await capture(store.source, 1024 * 1024);
  for (const [expected, selected] of [
    [value.ready, ready],
    [value.start, start],
    [value.source, source],
  ] as const) {
    if (JSON.stringify(expected) !== JSON.stringify(selected.pin)) {
      return refused();
    }
  }
  remaining();
  await available(store);
  await unchanged(ready);
  await unchanged(start);
  await unchanged(source, 1024 * 1024);
  await unchanged(current);
  await available(store);
  await requestNativeHookStop({
    run,
    port: value.port,
    token: value.token,
    timeoutMs: remaining(),
    signal,
  });
  remaining();
  await available(store);
  for (const path of [store.path, store.ready, store.start, store.source]) {
    await absent(path);
  }
  await store.check();
  return true;
}
