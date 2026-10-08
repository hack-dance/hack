import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import {
  assertNativeComposeFileMounts,
  assertNativeComposeFileMountsAbsent,
  NATIVE_COMPOSE_FILE_ENGINE_EXTENSION,
  observeNativeComposeFileEngine,
  readNativeComposeFileEngine,
} from "./native-compose-file-inventory.ts";
import {
  createNativeComposeFileOwner,
  type NativeComposeFileStopAttempt,
} from "./native-compose-file-owner.ts";
import {
  acquireNativeComposeFileDeliveryInputs,
  acquireNativeComposeFileSources,
  closeNativeComposeFileSources,
} from "./native-compose-file-sources.ts";
import { NATIVE_COMPOSE_FILES_EXTENSION } from "./native-compose-file-state.ts";
import type {
  NativeComposeGeneration,
  NativeComposeGenerationStore,
  NativeComposeMutation,
  NativeComposeReservation,
} from "./native-compose-generation.ts";
import type { NativeComposeExecutionInputs } from "./native-compose-inputs.ts";
import {
  assertNativeComposeOwned,
  type NativeComposeOwnershipOptions,
} from "./native-compose-ownership.ts";
import { nativeFilePlanningRequired } from "./native-file-plan-protocol.ts";
import type { RunOptions } from "./shell.ts";

type Document = Readonly<Record<string, unknown>>;
type Saved = {
  readonly generation: NativeComposeGeneration;
  readonly document: Document;
};
function uniqueSaved(saved: readonly Saved[]): readonly Saved[] {
  return [
    ...new Map(
      saved.map((selected) => [
        selected.generation.generationId,
        { ...selected },
      ])
    ).values(),
  ];
}
export async function assertNativeComposeSavedFileEngines(opts: {
  readonly saved: readonly Saved[];
  readonly store: NativeComposeGenerationStore;
  readonly signal: AbortSignal;
}): Promise<void> {
  const saved = uniqueSaved(opts.saved);
  const store = opts.store;
  const signal = opts.signal;
  for (const selected of saved) {
    const document = await store.readGenerationDocument(selected.generation);
    if (Object.hasOwn(document, NATIVE_COMPOSE_FILES_EXTENSION)) {
      await observeNativeComposeFileEngine({
        expected: readNativeComposeFileEngine(document),
        signal,
      });
    }
  }
}
function fileRunRefused(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native Compose one-off run with file material is not qualified. Use up or restart; no hook or engine operation ran. Values omitted.",
  });
}
export function assertNativeComposeFileRunSupported(opts: {
  readonly operation: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly previous?: readonly Saved[];
}): void {
  if (
    opts.operation === "run" &&
    (nativeFilePlanningRequired(opts.plan) ||
      opts.previous?.some((saved) =>
        Object.hasOwn(saved.document, NATIVE_COMPOSE_FILES_EXTENSION)
      ))
  ) {
    fileRunRefused();
  }
}
async function groupAbsent(group: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-group, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") {
        return true;
      }
    }
    await Bun.sleep(50);
  }
  return false;
}
/** Natural exit and exact owned-group absence qualify only this live child. */
function observeOwnedFileChild(
  onReaped: (assertReaped: () => Promise<void>) => Promise<void>
) {
  let group: number | undefined;
  let reaped = false;
  const hooks: Pick<RunOptions, "onSpawn" | "onExit"> = {
    onSpawn: (event) => {
      const selected = event.processGroupId ?? event.pid;
      if (
        !event.ownsProcessGroup ||
        group !== undefined ||
        !Number.isSafeInteger(selected) ||
        selected <= 0
      ) {
        refuseNativeComposeFile();
      }
      group = selected;
      return Promise.resolve();
    },
    onExit: async (event) => {
      const exited = Object.freeze({ ...event });
      if (
        exited.timedOut ||
        exited.cancelled ||
        group === undefined ||
        !(await groupAbsent(group))
      ) {
        return;
      }
      const selected = group;
      await onReaped(async () => {
        if (!(await groupAbsent(selected))) {
          refuseNativeComposeFile();
        }
      });
      reaped = true;
    },
  };
  return Object.freeze({ hooks: Object.freeze(hooks), known: () => reaped });
}

/** Arm every retained reference before stopping. A copied/reopened attempt never
 * completes an older unknown stop; stopping remains allowed and retirement vetoed. */
export async function prepareNativeComposeSavedFileStop(opts: {
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly saved: readonly Saved[];
}) {
  const { mutation, store } = opts;
  const saved = uniqueSaved(opts.saved);
  const owned: ReturnType<typeof createNativeComposeFileOwner>[] = [];
  try {
    const entries: {
      readonly owner: ReturnType<typeof createNativeComposeFileOwner>;
      readonly attempt: NativeComposeFileStopAttempt | null;
    }[] = [];
    for (const selected of saved) {
      const document = await store.readGenerationDocument(selected.generation);
      if (!Object.hasOwn(document, NATIVE_COMPOSE_FILES_EXTENSION)) {
        continue;
      }
      const reference = document[NATIVE_COMPOSE_FILES_EXTENSION];
      if (!(isRecord(reference) && typeof reference.root === "string")) {
        refuseNativeComposeFile();
      }
      const owner = createNativeComposeFileOwner({
        root: reference.root,
        authority: mutation.materialAuthority,
      });
      owned.push(owner);
      entries.push({
        owner,
        attempt: await owner.armStop(selected.generation),
      });
    }
    if (entries.length === 0) {
      return null;
    }
    const child = observeOwnedFileChild(async (assertReaped) => {
      for (const entry of entries) {
        if (entry.attempt !== null) {
          await entry.owner.recordStopReaped({
            attempt: entry.attempt,
            assertReaped,
          });
        }
      }
    });
    return Object.freeze({
      hooks: child.hooks,
      known: () =>
        child.known() && entries.every((entry) => entry.attempt !== null),
      close: async () => {
        await Promise.all(owned.map((owner) => owner.close()));
      },
    });
  } catch (error) {
    await Promise.all(owned.map((owner) => owner.close()));
    throw error;
  }
}
export type NativeComposeCommandFiles = Awaited<
  ReturnType<typeof prepareNativeComposeCommandFiles>
>;

/** Stage after known before hooks, using the actual mutation and the same selected managed owner. */
export async function prepareNativeComposeCommandFiles(opts: {
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly reservation: NativeComposeReservation;
  readonly inputs: NativeComposeExecutionInputs;
  readonly profiles?: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly signal: AbortSignal;
}) {
  const { mutation, store, reservation, inputs, signal } = opts;
  const profiles = [...(opts.profiles ?? [])];
  const explicitOverlay = opts.explicitOverlay;
  const root = join(resolveGlobalHackDir(), "compose-files");
  if (!nativeFilePlanningRequired(inputs.result.plan)) {
    return null;
  }
  const sources = await acquireNativeComposeFileSources({
    authority: mutation.materialAuthority,
    reservation,
    profiles,
    explicitOverlay,
    signal,
  });
  const owner = createNativeComposeFileOwner({
    root,
    authority: mutation.materialAuthority,
  });
  let armed = false;
  let reaped = false;
  try {
    const selected = await acquireNativeComposeFileDeliveryInputs({
      sources,
      authority: mutation.materialAuthority,
      reservation,
    });
    await inputs.assertFresh();
    if (
      selected.inputRevision !== inputs.inputRevision ||
      JSON.stringify(selected.result) !== JSON.stringify(inputs.result)
    ) {
      refuseNativeComposeFile();
    }
    const engineId = await observeNativeComposeFileEngine({ signal });
    const attempt = await owner.prepare({ reservation, sources });
    const projection = await owner.projection(attempt);
    return Object.freeze({
      inputs: selected,
      projection,
      document: (document: Document): Document => ({
        ...document,
        [NATIVE_COMPOSE_FILE_ENGINE_EXTENSION]: { version: 1, engineId },
      }),
      assertBeforeEffects: async () => {
        await observeNativeComposeFileEngine({ expected: engineId, signal });
      },
      arm: async (generation: NativeComposeGeneration) => {
        await observeNativeComposeFileEngine({ expected: engineId, signal });
        await owner.arm({ attempt, generation });
        armed = true;
      },
      childHooks: (
        generation: NativeComposeGeneration
      ): Pick<RunOptions, "onSpawn" | "onExit"> => {
        return observeOwnedFileChild(async (assertReaped) => {
          await owner.recordChildReaped({ attempt, generation, assertReaped });
          reaped = true;
        }).hooks;
      },
      childReaped: () => reaped,
      assertReady: async (
        selection: NativeComposeOwnershipOptions,
        generation: NativeComposeGeneration
      ) => {
        await owner.assertSavedReady(generation);
        const document = await store.readGenerationDocument(generation);
        const before = await assertNativeComposeOwned(selection);
        await assertNativeComposeFileMounts({
          document,
          generationId: generation.generationId,
          observed: before,
          signal,
        });
        const after = await assertNativeComposeOwned(selection);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          refuseNativeComposeFile();
        }
      },
      rollback: async () => {
        if (!armed) {
          await owner.rollback(attempt);
        }
      },
      close: async () => {
        await owner.close();
        await closeNativeComposeFileSources(sources);
      },
    });
  } catch (error) {
    await owner.close();
    await closeNativeComposeFileSources(sources);
    throw error;
  }
}

/** Saved cleanup acquires neither authored inputs nor credentials and never infers child reaping. */
export async function retireNativeComposeSavedFiles(opts: {
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly saved: readonly Saved[];
  readonly selection: NativeComposeOwnershipOptions;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { mutation, store, selection, signal } = opts;
  const saved = uniqueSaved(opts.saved);
  for (const selected of saved) {
    const document = await store.readGenerationDocument(selected.generation);
    if (!Object.hasOwn(document, NATIVE_COMPOSE_FILES_EXTENSION)) {
      continue;
    }
    const value = document[NATIVE_COMPOSE_FILES_EXTENSION];
    if (!(isRecord(value) && typeof value.root === "string")) {
      refuseNativeComposeFile();
    }
    const owner = createNativeComposeFileOwner({
      root: value.root,
      authority: mutation.materialAuthority,
    });
    try {
      await owner.retire({
        generation: selected.generation,
        assertAbsent: async () => {
          const observed = await assertNativeComposeOwned(selection);
          if (
            observed.containers.some(
              (container) =>
                container.generationId === selected.generation.generationId
            )
          ) {
            refuseNativeComposeFile();
          }
          await assertNativeComposeFileMountsAbsent({
            document,
            signal,
          });
          const after = await assertNativeComposeOwned(selection);
          if (
            after.containers.some(
              (container) =>
                container.generationId === selected.generation.generationId
            )
          ) {
            refuseNativeComposeFile();
          }
        },
      });
    } finally {
      await owner.close();
    }
  }
}
