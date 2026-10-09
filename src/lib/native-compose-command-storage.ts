import { HackCliError } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import { isRecord } from "./guards.ts";
import { observeNativeComposeFileEngine } from "./native-compose-file-inventory.ts";
import {
  type NativeComposeGeneration,
  NativeComposeGenerationError,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
} from "./native-compose-generation.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { nativeComposeStorageVolumeName } from "./native-compose-renderer.ts";
import {
  enrollNativeComposeStorageXattrWitness,
  prepareNativeComposeStorageXattrWitness,
  reconcileNativeComposeStorageWitnessCarrier,
  verifyNativeComposeStorageXattrWitness,
} from "./native-compose-storage-witness.ts";
import { createNativeComposeDockerStorageXattrCarrier } from "./native-compose-storage-witness-docker.ts";
import type { NativeComposeStorageXattrCarrier } from "./native-compose-storage-witness-xattr-carrier.ts";

type Selection = { readonly name: string; readonly storage: string };
type Document = Readonly<Record<string, unknown>>;
type Ports = {
  readonly engine: typeof observeNativeComposeFileEngine;
  readonly carrier: typeof createNativeComposeDockerStorageXattrCarrier;
  readonly volumeNames: (signal: AbortSignal) => Promise<readonly string[]>;
};
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

/** Image-only saved exec retains its read lease. Any content history or unknown
 * storage intent requires the mutation owner; a missing declaration is insufficient. */
export function nativeComposeSavedExecUsesReadLease(opts: {
  readonly selected: readonly Selection[];
  readonly current: Pick<
    Awaited<ReturnType<NativeComposeGenerationStore["loadCurrent"]>>,
    | "pending"
    | "beforeHooksPending"
    | "retainedStorage"
    | "storageWitnesses"
    | "storageWitnessesPending"
  >;
}): boolean {
  const { current, selected } = opts;
  return (
    selected.length === 0 &&
    (current.retainedStorage?.length ?? 0) === 0 &&
    (current.storageWitnesses?.length ?? 0) === 0 &&
    !current.storageWitnessesPending &&
    !current.beforeHooksPending &&
    current.pending === null
  );
}

function refuse(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native storage requires known enrolled content or an originally absent cold volume. Existing or interrupted storage is never enrolled or repaired automatically. Values omitted.",
  });
}

export function nativeComposeDocumentStorage(
  document: Document
): readonly Selection[] {
  if (!isRecord(document.volumes)) {
    return refuse();
  }
  return Object.entries(document.volumes).map(([storage, value]) => {
    if (!(isRecord(value) && typeof value.name === "string")) {
      return refuse();
    }
    return Object.freeze({ name: value.name, storage });
  });
}

export function nativeComposePlanStorage(opts: {
  readonly storage: unknown;
  readonly runtimeIdentity: string;
}): readonly Selection[] {
  if (opts.storage === undefined) {
    return [];
  }
  if (!isRecord(opts.storage)) {
    return refuse();
  }
  return Object.keys(opts.storage)
    .sort()
    .map((storage) =>
      Object.freeze({
        storage,
        name: nativeComposeStorageVolumeName({
          runtimeIdentity: opts.runtimeIdentity,
          storage,
        }),
      })
    );
}

async function volumeNames(signal: AbortSignal): Promise<readonly string[]> {
  const text = await createNativeComposeProbe({ signal })([
    "volume",
    "ls",
    "--format",
    "{{json .Name}}",
  ]);
  const names =
    text.trim() === ""
      ? []
      : text
          .trim()
          .split("\n")
          .map((line) => {
            const value: unknown = JSON.parse(line);
            return typeof value === "string" && VOLUME_NAME.test(value)
              ? value
              : refuse();
          });
  if (new Set(names).size !== names.length) {
    return refuse();
  }
  return names;
}

/** Command admission owns no helper process. Each proof gets a fresh finite carrier;
 * only the original startup effect can publish Expected and consume cold enrollment. */
export async function prepareNativeComposeCommandStorage(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly mutation: NativeComposeMutation;
  readonly operation: "up" | "restart" | "run" | "exec";
  readonly selected: readonly Selection[];
  readonly signal: AbortSignal;
  readonly assertFresh?: () => Promise<void>;
  readonly ports?: Ports;
}) {
  const { store, mutation, operation, signal, assertFresh } = opts;
  const selected = opts.selected.map((value) =>
    Object.freeze({ name: value.name, storage: value.storage })
  );
  const engine = opts.ports?.engine ?? observeNativeComposeFileEngine;
  const createCarrier =
    opts.ports?.carrier ?? createNativeComposeDockerStorageXattrCarrier;
  const names = opts.ports?.volumeNames ?? volumeNames;
  const initial = await store.loadCurrent();
  if (
    initial.pending !== null ||
    initial.storageWitnessesPending ||
    initial.beforeHooksPending
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  const history = [
    ...(initial.retainedStorage ?? []),
    ...(initial.generation
      ? nativeComposeDocumentStorage(
          await store.readGenerationDocument(initial.generation)
        )
      : []),
  ];
  const enrolled = initial.storageWitnesses ?? [];
  if (!(selected.length || history.length || enrolled.length)) {
    return null;
  }
  if (
    enrolled.some(
      (entry) => entry.state !== "enrolled" || entry.reference.version !== 3
    ) ||
    history.some(
      (volume) =>
        !enrolled.some(
          (entry) =>
            entry.name === volume.name && entry.storage === volume.storage
        )
    )
  ) {
    return refuse();
  }
  const engineId = await engine({ signal });
  const carrier = (): Promise<NativeComposeStorageXattrCarrier> =>
    createCarrier({
      store,
      authority: mutation.materialAuthority,
      engineId,
      signal,
      deadline: Date.now() + resolveComposeStartupTimeoutMs(),
      originalCommandRecords: true,
    });
  // Check the explicit dependency before any authored hook, intent or volume effect.
  await carrier();
  const newVolumes = selected.filter(
    (volume) =>
      !enrolled.some(
        (entry) =>
          entry.name === volume.name && entry.storage === volume.storage
      )
  );
  if (
    (operation === "exec" && (initial.stopped || newVolumes.length > 0)) ||
    (operation === "run" &&
      newVolumes.length > 0 &&
      initial.generation !== null)
  ) {
    return refuse();
  }
  const assertColdAbsent = async () => {
    if (newVolumes.length === 0) {
      return;
    }
    await assertFresh?.();
    await engine({ expected: engineId, signal });
    const observedNames = await names(signal);
    if (newVolumes.some((volume) => observedNames.includes(volume.name))) {
      return refuse();
    }
    await engine({ expected: engineId, signal });
    await assertFresh?.();
  };
  const verify = async (generation: NativeComposeGeneration) => {
    await assertFresh?.();
    const before = await store.loadCurrent();
    if (before.storageWitnessesPending) {
      throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
    }
    for (const entry of before.storageWitnesses ?? []) {
      if (
        entry.state !== "enrolled" ||
        entry.reference.version !== 3 ||
        entry.engineId !== engineId
      ) {
        return refuse();
      }
      await verifyNativeComposeStorageXattrWitness({
        authority: mutation.materialAuthority,
        generation,
        engineId,
        reference: entry.reference,
        carrier: await carrier(),
      });
    }
    const after = await store.loadCurrent();
    if (
      after.storageWitnessesPending ||
      JSON.stringify(before.storageWitnesses) !==
        JSON.stringify(after.storageWitnesses)
    ) {
      throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
    }
    await assertFresh?.();
  };
  await assertColdAbsent();
  if (initial.generation) {
    await verify(initial.generation);
  } else if (enrolled.length > 0) {
    return refuse();
  }
  return {
    effectWitnesses: Object.freeze({
      kind: "directory-xattr" as const,
      engineId,
      carrier,
    }),
    verify,
    async enroll(generation: NativeComposeGeneration, document: Document) {
      const actual = nativeComposeDocumentStorage(document);
      if (
        JSON.stringify(
          actual.slice().sort((a, b) => a.storage.localeCompare(b.storage))
        ) !==
        JSON.stringify(
          selected.slice().sort((a, b) => a.storage.localeCompare(b.storage))
        )
      ) {
        return refuse();
      }
      await assertColdAbsent();
      if (operation === "exec") {
        return;
      }
      for (const volume of newVolumes) {
        const enrollment = await prepareNativeComposeStorageXattrWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId,
          volume,
          admission: "initial-create",
          assertAdmission: async () => {
            await assertFresh?.();
          },
          carrier: await carrier(),
        });
        await enrollNativeComposeStorageXattrWitness({ enrollment });
      }
      // A one-off run immediately verifies through its pre-spawn ownership
      // guard. Up and restart can arm other effects before that guard.
      if (operation !== "run") {
        await verify(generation);
      }
    },
  };
}

export type NativeComposeCommandStorage = Awaited<
  ReturnType<typeof prepareNativeComposeCommandStorage>
>;

/** Saved exec does not publish a ready receipt. Cancellation preserves its known
 * exit and starts no late helper; every future admission re-verifies content. */
export async function runNativeComposeStorageVerifiedExec(opts: {
  readonly signal: AbortSignal;
  readonly assertSaved: () => Promise<void>;
  readonly run: () => Promise<number>;
}): Promise<number> {
  const { signal, assertSaved, run } = opts;
  await assertSaved();
  const code = await run();
  if (!signal.aborted) {
    await assertSaved();
  }
  return code;
}

/** Saved down+recover only, after known compute absence. Reconciles only a
 * complete removed readonly original attempt. No effect replay or data removal. */
export async function reconcileNativeComposeCommandStorage(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly mutation: NativeComposeMutation;
  readonly generation: NativeComposeGeneration;
  readonly signal: AbortSignal;
}): Promise<void> {
  const current = await opts.store.loadCurrent();
  if (!current.storageWitnessesPending) {
    return;
  }
  const engineId = await observeNativeComposeFileEngine({
    signal: opts.signal,
  });
  const deadline = Date.now() + resolveComposeStartupTimeoutMs();
  for (const state of current.storageWitnesses ?? []) {
    if (state.state !== "enrolled" || state.reference.version !== 3) {
      return refuse();
    }
    // A completed sibling journal is skipped without weakening the selected unknown one.
    const { nativeComposeStorageCarriersPending } = await import(
      "./native-compose-storage-carrier-journal.ts"
    );
    if (
      !(await nativeComposeStorageCarriersPending({
        identity: opts.store.identity,
        states: [state],
      }))
    ) {
      continue;
    }
    await reconcileNativeComposeStorageWitnessCarrier({
      ...opts,
      authority: opts.mutation.materialAuthority,
      engineId,
      reference: state.reference,
      deadline,
    });
  }
}
