import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  createNativeComposePrivateMutationLock,
  hasCode,
  keys,
  type NativeComposeInterruptedLockSelection,
  type NativeComposeMutationLease,
  parseNativeComposeInterruptedLockSelection,
  readPrivate,
  sameFile,
  synchronizeDirectories,
  writeExclusive,
} from "../lib/native-compose-private-state.ts";
import {
  type NativeAuthoredReceipt,
  parseNativeAuthoredSnapshot,
} from "./native-authored-graph-protocol.ts";
import {
  type NativeAuthoredProjectRunScope,
  type NativeAuthoredProjectRunSelection,
  type NativeAuthoredProjectStartSelection,
  parseNativeAuthoredProjectRunSelection,
  parseNativeAuthoredProjectStartSelection,
  withNativeAuthoredProjectRecoveryStorage,
} from "./native-authored-project-run.ts";
import {
  type NativeAuthoredRecoveryResult,
  type NativeAuthoredRecoverySelection,
  parseNativeAuthoredRecoveryResult,
  parseNativeAuthoredRecoverySelection,
} from "./native-authored-recovery-protocol.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const LIMIT = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const PHASES = [
  "prepared",
  "native-removed",
  "ready-retirement",
  "ready-retired",
  "start-retirement",
  "start-retired",
  "source-retirement",
  "source-retired",
  "admission-retirement",
  "complete",
] as const;
type Phase = (typeof PHASES)[number];
type Identity = NativeAuthoredProjectRunSelection["identity"];
type Intent = {
  readonly version: 1;
  readonly kind: "native-authored-project-recovery";
  readonly phase: Phase;
  readonly ready: NativeAuthoredProjectRunSelection;
  readonly start: NativeAuthoredProjectStartSelection;
  readonly source: Identity;
  readonly admission: NativeComposeInterruptedLockSelection;
  readonly native: NativeAuthoredRecoverySelection;
  readonly lease: NativeComposeInterruptedLockSelection;
  readonly mutation: NativeComposeInterruptedLockSelection;
  readonly lease_releasing: boolean;
  readonly mutation_retirement: boolean;
};
type Store = Parameters<
  Parameters<typeof withNativeAuthoredProjectRecoveryStorage>[1]
>[0];
type Saved = { readonly record: Intent; readonly identity: Identity };
function refused(): never {
  throw new Error(
    "Native frontend recovery is retained or changed; values omitted. No startup was replayed."
  );
}
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function copyIdentity(value: unknown): Identity {
  if (
    !(isRecord(value) && keys(value, "dev,ino,sha256")) ||
    typeof value.dev !== "number" ||
    !Number.isSafeInteger(value.dev) ||
    value.dev < 0 ||
    typeof value.ino !== "number" ||
    !Number.isSafeInteger(value.ino) ||
    value.ino < 1 ||
    typeof value.sha256 !== "string" ||
    !HASH.test(value.sha256)
  ) {
    return refused();
  }
  return { dev: value.dev, ino: value.ino, sha256: value.sha256 };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      freeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
function parseIntent(value: unknown): Intent {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "admission,kind,lease,lease_releasing,mutation,mutation_retirement,native,phase,ready,source,start,version"
      )
    ) ||
    value.version !== 1 ||
    value.kind !== "native-authored-project-recovery" ||
    typeof value.phase !== "string" ||
    !PHASES.includes(value.phase as Phase) ||
    typeof value.lease_releasing !== "boolean" ||
    typeof value.mutation_retirement !== "boolean"
  ) {
    return refused();
  }
  const ready = parseNativeAuthoredProjectRunSelection(value.ready);
  const start = parseNativeAuthoredProjectStartSelection(value.start);
  const admission = parseNativeComposeInterruptedLockSelection(value.admission);
  const lease = parseNativeComposeInterruptedLockSelection(value.lease);
  const mutation = parseNativeComposeInterruptedLockSelection(value.mutation);
  if (
    JSON.stringify(start.record.review) !==
      JSON.stringify(ready.record.receipt.review) ||
    lease.owner.bootId !== admission.owner.bootId ||
    mutation.owner.bootId !== admission.owner.bootId
  ) {
    return refused();
  }
  return freeze({
    version: 1,
    kind: "native-authored-project-recovery",
    phase: value.phase as Phase,
    ready,
    start,
    source: copyIdentity(value.source),
    admission,
    native: parseNativeAuthoredRecoverySelection({
      value: value.native,
      admitted: ready.record.receipt,
    }),
    lease,
    mutation,
    lease_releasing: value.lease_releasing,
    mutation_retirement: value.mutation_retirement,
  });
}
function rank(record: Intent): number {
  return PHASES.indexOf(record.phase);
}
function phaseAt(index: number): Phase {
  return PHASES[index] ?? refused();
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}
function intentPath(store: Store) {
  return `${store.ready}.recovery.json`;
}
function pendingPath(store: Store) {
  return `${intentPath(store)}.pending`;
}
async function linkedArchive(
  store: Store,
  archive: string,
  expected: Identity
): Promise<void> {
  const file = await open(
    intentPath(store),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 2 ||
      before.size < 1 ||
      before.size > LIMIT ||
      !sameFile(before, expected)
    ) {
      return refused();
    }
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const original = await lstat(intentPath(store));
    const copied = await lstat(archive);
    if (
      bytesRead !== before.size ||
      !sameFile(after, before) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !sameFile(original, before) ||
      !sameFile(copied, before) ||
      original.nlink !== 2 ||
      copied.nlink !== 2 ||
      createHash("sha256")
        .update(bytes.subarray(0, bytesRead))
        .digest("hex") !== expected.sha256
    ) {
      return refused();
    }
  } finally {
    await file.close();
  }
}
async function readIntent(store: Store): Promise<Saved | null> {
  if (!(await absent(pendingPath(store)))) {
    return refused();
  }
  let read: Awaited<ReturnType<typeof readPrivate>>;
  try {
    read = await readPrivate(intentPath(store), LIMIT);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const value: unknown = JSON.parse(read.text);
  if (
    !(isRecord(value) && keys(value, "record,scope")) ||
    value.scope !== store.scope
  ) {
    return refused();
  }
  return {
    record: parseIntent(value.record),
    identity: {
      dev: read.info.dev,
      ino: read.info.ino,
      sha256: hash(read.text),
    },
  };
}
function lock(store: Store, path: string, recoveryPath: string) {
  return createNativeComposePrivateMutationLock({
    lockPath: path,
    recoveryPath,
    parent: store.root,
    check: store.check,
  });
}
async function expectedFile(
  path: string,
  expected: Identity,
  optional: boolean
): Promise<boolean> {
  const read = await readPrivate(path, 1024 * 1024).catch((error: unknown) => {
    if (optional && hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (read === undefined) {
    return false;
  }
  if (!sameFile(read.info, expected) || hash(read.text) !== expected.sha256) {
    return refused();
  }
  return true;
}
async function bindings(store: Store, record: Intent): Promise<void> {
  const phase = rank(record);
  for (const [path, expected, retirement] of [
    [store.ready, record.ready.identity, 2],
    [store.start, record.start.identity, 4],
    [store.sourcePath(record.native.run), record.source, 6],
  ] as const) {
    if (phase > retirement) {
      if (!(await absent(path))) {
        return refused();
      }
    } else {
      await expectedFile(path, expected, phase === retirement);
    }
  }
  if (phase < 8) {
    const selected = await lock(
      store,
      store.admission,
      `${store.admission}.verification`
    ).selectInterruptedLock();
    if (JSON.stringify(selected) !== JSON.stringify(record.admission)) {
      return refused();
    }
  } else if (phase === 9 && !(await absent(store.admission))) {
    return refused();
  }
}

type Retirement = {
  readonly record: () => Intent;
  readonly commit: (record: Intent) => Promise<void>;
  readonly check: () => Promise<void>;
  readonly active: () => undefined;
  readonly inspect: () => Promise<NativeAuthoredReceipt>;
};
async function retireFiles(
  store: Store,
  retirement: Retirement
): Promise<void> {
  const selected = retirement.record();
  for (const [path, expected, phase] of [
    [store.ready, selected.ready.identity, 2],
    [store.start, selected.start.identity, 4],
    [store.sourcePath(selected.native.run), selected.source, 6],
  ] as const) {
    if (rank(retirement.record()) < phase) {
      await retirement.commit({
        ...retirement.record(),
        phase: phaseAt(phase),
      });
    }
    if (rank(retirement.record()) !== phase) {
      continue;
    }
    await retirement.inspect();
    await retirement.check();
    if (await expectedFile(path, expected, true)) {
      retirement.active();
      await unlink(path);
      await synchronizeDirectories(store.held);
    }
    if (!(await absent(path))) {
      return refused();
    }
    await retirement.commit({
      ...retirement.record(),
      phase: phaseAt(phase + 1),
    });
  }
}
async function retireAdmission(
  store: Store,
  retirement: Retirement,
  lease: NativeComposeMutationLease
): Promise<void> {
  if (rank(retirement.record()) < 8) {
    await retirement.commit({
      ...retirement.record(),
      phase: "admission-retirement",
    });
  }
  if (rank(retirement.record()) !== 8) {
    return;
  }
  await retirement.inspect();
  await retirement.check();
  if (!(await absent(store.admission))) {
    await lock(
      store,
      store.admission,
      store.recovery
    ).retireSelectedUnderRecoveryLease({
      selected: retirement.record().admission,
      lease,
      allowOwnerAbsent: true,
    });
  }
  await retirement.check();
  if (!(await absent(store.admission))) {
    return refused();
  }
  await retirement.commit({ ...retirement.record(), phase: "complete" });
}

/** Explicit stored-generation cleanup only. No compilation, value acquisition,
 * serve, allocation or automatic startup takeover exists in this owner. */
export async function recoverNativeAuthoredProject(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Exact public native-request seam for isolated owner tests. */
  readonly request?: typeof invokeNativeRuntime;
}): Promise<NativeAuthoredRecoveryResult> {
  const runtime = { ...opts.runtime };
  const timeoutMs = opts.timeoutMs;
  const signal = opts.signal;
  const request = opts.request ?? invokeNativeRuntime;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    signal?.aborted ||
    runtime.home !== opts.scope.nativeHome
  ) {
    return refused();
  }
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value < 1 || signal?.aborted) {
      return refused();
    }
    return value;
  };
  return await withNativeAuthoredProjectRecoveryStorage(
    opts.scope,
    async (store) => {
      let saved = await readIntent(store);
      const recovery = lock(
        store,
        store.recovery,
        `${store.recovery}.recovery`
      );
      if (!(await absent(store.recovery))) {
        if (!saved) {
          return refused();
        }
        const current = await recovery.selectInterruptedLock();
        if (JSON.stringify(current) !== JSON.stringify(saved.record.lease)) {
          return refused();
        }
        await recovery.recoverSelectedInterruptedLock(current);
      } else if (saved && !saved.record.lease_releasing) {
        return refused();
      }
      return await recovery.withLock(async (lease) => {
        const check = async () => {
          await lease.assertHeld();
          await store.check();
          const current = await readIntent(store);
          if (JSON.stringify(current) !== JSON.stringify(saved)) {
            return refused();
          }
        };
        const commit = async (
          value: Intent,
          mutation?: NativeComposeMutationLease
        ) => {
          const active = () => {
            lease.assertActive();
            mutation?.assertActive();
          };
          const record = parseIntent(value);
          const text = JSON.stringify({ scope: store.scope, record });
          if (Buffer.byteLength(text) > LIMIT) {
            return refused();
          }
          await check();
          await mutation?.assertHeld();
          const info = await writeExclusive(pendingPath(store), text);
          // This attempt's own pending file is allowed only at this publication boundary.
          await lease.assertHeld();
          await mutation?.assertHeld();
          await store.check();
          const current = await readPrivate(pendingPath(store), LIMIT);
          if (!sameFile(current.info, info) || current.text !== text) {
            return refused();
          }
          if (saved) {
            const old = await readPrivate(intentPath(store), LIMIT);
            if (
              !sameFile(old.info, saved.identity) ||
              hash(old.text) !== saved.identity.sha256
            ) {
              return refused();
            }
            active();
            await rename(pendingPath(store), intentPath(store));
          } else {
            active();
            await link(pendingPath(store), intentPath(store));
            active();
            await unlink(pendingPath(store));
          }
          await synchronizeDirectories(store.held);
          saved = await readIntent(store);
          if (
            !saved ||
            JSON.stringify(saved.record) !== JSON.stringify(record)
          ) {
            return refused();
          }
        };
        const mutation = lock(
          store,
          store.mutation,
          `${store.mutation}.recovery`
        );
        if (!(await absent(store.mutation))) {
          if (!saved) {
            return refused();
          }
          if (!saved.record.mutation_retirement) {
            const selected = await mutation.selectInterruptedLock();
            if (
              JSON.stringify(selected) !== JSON.stringify(saved.record.mutation)
            ) {
              return refused();
            }
          }
          await commit({
            ...saved.record,
            lease: lease.selection,
            mutation_retirement: true,
          });
          await lock(
            store,
            store.mutation,
            store.recovery
          ).retireSelectedUnderRecoveryLease({
            selected: saved.record.mutation,
            lease,
            allowOwnerAbsent: true,
          });
        } else if (
          saved &&
          !saved.record.lease_releasing &&
          !saved.record.mutation_retirement
        ) {
          return refused();
        }
        return await mutation.withLock(async (mutationLease) => {
          const record = () => saved?.record ?? refused();
          const both = async () => {
            remaining();
            await check();
            await mutationLease.assertHeld();
          };
          try {
            if (saved) {
              await commit(
                {
                  ...saved.record,
                  lease: lease.selection,
                  mutation: mutationLease.selection,
                  lease_releasing: false,
                  mutation_retirement: false,
                },
                mutationLease
              );
            } else {
              const ready = await store.readReady();
              const start = await store.readStart();
              const source = await store.readSource(
                ready.record.receipt.review.provenance.run
              );
              const admission = await lock(
                store,
                store.admission,
                `${store.admission}.verification`
              ).selectInterruptedLock();
              const native = parseNativeAuthoredRecoverySelection({
                value: await request({
                  runtime,
                  cwd: store.projectRoot,
                  args: [
                    "graph",
                    "native",
                    "recovery-selection",
                    "--run-id",
                    ready.record.receipt.review.provenance.run,
                    "--json",
                  ],
                  timeoutMs: remaining(),
                  signal,
                  boundNativeAuthoredRecoveryDrain: "selection",
                }),
                admitted: ready.record.receipt,
              });
              remaining();
              await commit(
                {
                  version: 1,
                  kind: "native-authored-project-recovery",
                  phase: "prepared",
                  ready,
                  start,
                  source,
                  admission,
                  native,
                  lease: lease.selection,
                  mutation: mutationLease.selection,
                  lease_releasing: false,
                  mutation_retirement: false,
                },
                mutationLease
              );
            }
            if (!saved) {
              return refused();
            }
            await both();
            await bindings(store, saved.record);
            await both();
            const selected = saved.record.native;
            if (saved.record.phase === "prepared") {
              parseNativeAuthoredRecoveryResult({
                expected: selected,
                value: await request({
                  runtime,
                  cwd: store.projectRoot,
                  args: [
                    "graph",
                    "native",
                    "recover-live-owner",
                    "--run-id",
                    selected.run,
                    "--expect-receipt",
                    selected.receipt_sha256,
                    "--expect-owner",
                    selected.owner_sha256,
                    "--json",
                  ],
                  timeoutMs: remaining(),
                  signal,
                  boundNativeAuthoredRecoveryDrain: "cleanup",
                }),
              });
              await both();
              await bindings(store, saved.record);
              await both();
              await commit(
                { ...saved.record, phase: "native-removed" },
                mutationLease
              );
            }
            const inspect = async () => {
              const snapshot = parseNativeAuthoredSnapshot({
                value: await request({
                  runtime,
                  cwd: store.projectRoot,
                  args: [
                    "graph",
                    "native",
                    "inspect",
                    "--run-id",
                    selected.run,
                    "--json",
                  ],
                  timeoutMs: remaining(),
                  signal,
                  boundNativeAuthoredReadDrain: true,
                }),
                expectedReview: selected.receipt.review,
                admitted: selected.receipt,
              });
              if (
                snapshot.receipt.phase !== "removed" ||
                Object.values(snapshot.observations).some(
                  (item) => item !== null
                )
              ) {
                return refused();
              }
              await both();
              await bindings(store, record());
              await both();
              return snapshot.receipt;
            };
            await inspect();
            const retirement: Retirement = {
              record,
              commit: (value) => commit(value, mutationLease),
              check: both,
              active: () => {
                remaining();
                lease.assertActive();
                mutationLease.assertActive();
                return undefined;
              },
              inspect,
            };
            await retireFiles(store, retirement);
            await retireAdmission(store, retirement, lease);
            const removed = await inspect();
            await bindings(store, saved.record);
            await both();
            return {
              version: 1,
              kind: "native-graph-live-owner-recovered",
              run: selected.run,
              same_boot: true,
              publication_retired: true,
              receipt: removed,
            };
          } finally {
            if (saved) {
              await commit(
                { ...saved.record, lease_releasing: true },
                mutationLease
              );
            }
          }
        });
      });
    }
  );
}

/** Startup may archive an authenticated completed frontend intent under its
 * fresh admission. Incomplete recovery never becomes automatic takeover. */
export async function archiveCompletedNativeAuthoredRecovery(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly admission: NativeComposeMutationLease;
}): Promise<void> {
  const admission = opts.admission;
  await withNativeAuthoredProjectRecoveryStorage(opts.scope, async (store) => {
    const saved = await readIntent(store);
    if (!saved) {
      return;
    }
    if (saved.record.phase !== "complete" || !saved.record.lease_releasing) {
      return refused();
    }
    const mutation = lock(store, store.mutation, `${store.mutation}.recovery`);
    await mutation.withLock(async (lease) => {
      await admission.assertHeld();
      await lease.assertHeld();
      await store.check();
      if (
        !(
          (await absent(store.recovery)) &&
          (await absent(store.ready)) &&
          (await absent(store.start)) &&
          (await absent(store.sourcePath(saved.record.native.run)))
        )
      ) {
        return refused();
      }
      const current = await readIntent(store);
      if (JSON.stringify(current) !== JSON.stringify(saved)) {
        return refused();
      }
      const info = await lstat(store.admission);
      if (!sameFile(info, admission.directory)) {
        return refused();
      }
      const archive = join(
        store.root.path,
        `${saved.record.native.run}.frontend-recovered.json`
      );
      admission.assertActive();
      lease.assertActive();
      await link(intentPath(store), archive);
      // Only this exact archive transition admits nlink=2. Ordinary private
      // readers remain single-link and refuse an interrupted archive publication.
      await admission.assertHeld();
      await lease.assertHeld();
      await store.check();
      await linkedArchive(store, archive, saved.identity);
      admission.assertActive();
      lease.assertActive();
      await unlink(intentPath(store));
      await synchronizeDirectories(store.held);
      const completed = await readPrivate(archive, LIMIT);
      if (
        !sameFile(completed.info, saved.identity) ||
        hash(completed.text) !== saved.identity.sha256 ||
        !(await absent(intentPath(store)))
      ) {
        return refused();
      }
    });
  });
}
