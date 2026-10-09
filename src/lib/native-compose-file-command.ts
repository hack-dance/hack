import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import {
  nativeComposeEffectReason,
  retainNativeComposeEffectRefusal,
} from "./native-compose-effect-diagnostics.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import {
  assertNativeComposeFileMounts,
  assertNativeComposeFileMountsAbsent,
  assertNativeComposeFileRootUnbound,
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
import { NativeComposeGenerationError } from "./native-compose-generation.ts";
import type { NativeComposeExecutionInputs } from "./native-compose-inputs.ts";
import {
  assertNativeComposeOwned,
  type NativeComposeOwnershipOptions,
} from "./native-compose-ownership.ts";
import {
  assertNativeComposeVmFiles,
  assertPreparedNativeComposeVmFiles,
  stageNativeComposeVmFiles,
} from "./native-compose-vm-file-owner.ts";
import { NATIVE_COMPOSE_VM_FILES_EXTENSION } from "./native-compose-vm-file-protocol.ts";
import { nativeFilePlanningRequired } from "./native-file-plan-protocol.ts";
import { type RunOptions, run } from "./shell.ts";

type Document = Readonly<Record<string, unknown>>;
type Saved = {
  readonly generation: NativeComposeGeneration;
  readonly document: Document;
};
/** Durable arming is followed by current admission and a synchronous spawn fence.
 * Cancellation never grants a later retry authority over an earlier armed child. */
export async function runNativeComposeOwnedFileChild(opts: {
  readonly arm: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly command: readonly string[];
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly options: Omit<
    RunOptions,
    "timeoutMs" | "beforeSpawn" | "onSpawn" | "onExit"
  >;
  readonly hooks?: () => Pick<RunOptions, "onSpawn" | "onExit">;
}): Promise<number> {
  const { arm, assertOwned, signal, deadline } = opts;
  const command = [...opts.command];
  const options = { ...opts.options };
  if (opts.options.env) {
    options.env = { ...opts.options.env };
  }
  if (opts.options.unsetEnvKeys) {
    options.unsetEnvKeys = [...opts.options.unsetEnvKeys];
  }
  const hooks = opts.hooks;
  const requireAdmission = () => {
    if (signal.aborted || Date.now() >= deadline) {
      throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
    }
  };
  requireAdmission();
  await arm();
  requireAdmission();
  await assertOwned();
  requireAdmission();
  return await run(command, {
    ...options,
    ...hooks?.(),
    timeoutMs: deadline - Date.now(),
    beforeSpawn: requireAdmission,
  });
}
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
  const deadline = Date.now() + resolveComposeStartupTimeoutMs();
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
    signal,
  });
  let armed = false;
  let reaped = false;
  let ready: {
    selection: NativeComposeOwnershipOptions;
    generation: NativeComposeGeneration;
  } | null = null;
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
    await assertNativeComposeFileRootUnbound({ root, engineId, signal });
    const attempt = await owner.prepare({ reservation, sources });
    let projection = await owner.projection(attempt);
    const vmRequired = Object.values(
      selected.result.file_plan?.workloads ?? {}
    ).some((grants) =>
      grants.some(
        (grant) =>
          grant.mode !== "0444" ||
          grant.uid !== undefined ||
          grant.gid !== undefined
      )
    );
    if (vmRequired) {
      projection = await stageNativeComposeVmFiles({
        authority: mutation.materialAuthority,
        reservation,
        sources,
        host: projection,
        engineId,
        signal,
        deadline,
      });
      owner.selectVmProjection({ attempt, projection });
    }
    const assertReady = async (
      selection: NativeComposeOwnershipOptions,
      generation: NativeComposeGeneration
    ) => {
      try {
        await owner.assertSavedReady(generation);
        const document = await store.readGenerationDocument(generation);
        const before = await assertNativeComposeOwned(selection);
        if (Object.hasOwn(document, NATIVE_COMPOSE_VM_FILES_EXTENSION)) {
          await assertNativeComposeVmFiles({
            authority: mutation.materialAuthority,
            generation,
            document,
            signal,
            deadline,
            observed: before,
          });
        }
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
        await owner.assertSavedReady(generation);
        if (Object.hasOwn(document, NATIVE_COMPOSE_VM_FILES_EXTENSION)) {
          ready = { selection, generation };
        }
      } catch (error) {
        if (projection.vm) {
          retainNativeComposeEffectRefusal(error, {
            stage: "vm-file-readiness",
            reason: nativeComposeEffectReason(error),
          });
        }
        throw error;
      }
    };
    return Object.freeze({
      inputs: selected,
      projection,
      document: (document: Document): Document => ({
        ...document,
        [NATIVE_COMPOSE_FILE_ENGINE_EXTENSION]: { version: 1, engineId },
      }),
      assertBeforeEffects: async (generation: NativeComposeGeneration) => {
        const assertProjection = async () => {
          const pending = await store.loadPending();
          if (armed || pending?.generationId === generation.generationId) {
            await owner.assertSavedProjection(generation);
          } else {
            await owner.projection(attempt);
          }
        };
        await assertProjection();
        await assertNativeComposeFileRootUnbound({ root, engineId, signal });
        // Earned readiness changes only the file phase. Reobserve the exact app
        // grants at every final ownership fence; routing completion stays separate.
        if (ready?.generation === generation) {
          await assertReady(ready.selection, generation);
          await assertProjection();
          return;
        }
        const document = await store.readGenerationDocument(generation);
        if (Object.hasOwn(document, NATIVE_COMPOSE_VM_FILES_EXTENSION)) {
          const pending = await store.loadPending();
          if (armed || pending?.generationId === generation.generationId) {
            await assertNativeComposeVmFiles({
              authority: mutation.materialAuthority,
              generation,
              document,
              signal,
              deadline,
            });
          } else {
            if (generation.generationId !== reservation.generationId) {
              refuseNativeComposeFile();
            }
            await assertPreparedNativeComposeVmFiles({
              authority: mutation.materialAuthority,
              reservation,
              projection,
              document,
              signal,
              deadline,
            });
          }
        }
        await assertProjection();
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
      assertReady,
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
      signal,
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
