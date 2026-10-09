import { randomBytes } from "node:crypto";
import type { LogOutputFormat } from "../backends/log-backend.ts";
import type { RuntimeBaseOptions } from "../backends/runtime-backend.ts";
import { CliUsageError } from "../cli/command.ts";
import {
  emitCliResult,
  errorResult,
  HackCliError,
  okResult,
} from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import { isRecord } from "./guards.ts";
import { tryNativeAuthoredCommand } from "./native-authored-command.ts";
import { tryLegacyComposeAdoptedCommand } from "./native-compose-adoption-command.ts";
import {
  assertNativeComposeAfterInputsUnchanged,
  prepareNativeComposeAfterHooks,
} from "./native-compose-after-hooks.ts";
import {
  assertNativeComposeBuildExecution,
  buildNativeComposeImages,
  NativeComposeBuildError,
  type NativeComposeBuildIntent,
  planNativeComposeBuilds,
  prepareNativeComposeBuildExecution,
} from "./native-compose-build.ts";
import {
  type NativeComposeCommandStorage,
  nativeComposePlanStorage,
  nativeComposeSavedExecUsesReadLease,
  prepareNativeComposeCommandStorage,
  reconcileNativeComposeCommandStorage,
  runNativeComposeStorageVerifiedExec,
  nativeComposeDocumentStorage as volumeSelections,
} from "./native-compose-command-storage.ts";
import {
  nativeComposeCompletedOneoff,
  nativeComposeOnFailureServices,
  nativeComposeRunDependenciesReady,
  nativeComposeWorkloadsReady as ready,
} from "./native-compose-completion.ts";
import {
  bindNativeComposeDownHooks,
  prepareNativeComposeDownHooks,
  readNativeComposeDownHookBinding,
} from "./native-compose-down-hooks.ts";
import {
  assertNativeComposeFileRunSupported,
  assertNativeComposeSavedFileEngines,
  type NativeComposeCommandFiles,
  prepareNativeComposeCommandFiles,
  prepareNativeComposeSavedFileStop,
  retireNativeComposeSavedFiles,
  runNativeComposeOwnedFileChild,
} from "./native-compose-file-command.ts";
import {
  type NativeComposeGeneration,
  NativeComposeGenerationError,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  type NativeComposeReservation,
  type NativeComposeRunProjection,
  openNativeComposeGenerationStore,
  readNativeComposeNetworkTopology,
} from "./native-compose-generation.ts";
import {
  NativeComposeHostHookError,
  selectNativeComposeAfterHooks,
  selectNativeComposeBeforeHooks,
  selectNativeComposeDownHooks,
} from "./native-compose-host-contract.ts";
import {
  assertNativeComposeBeforeHookBindings,
  runNativeComposeBeforeHooks,
} from "./native-compose-host-hooks.ts";
import {
  acquireNativeComposeFilePlanningInputs,
  type NativeComposeExecutionInputs,
} from "./native-compose-inputs.ts";
import {
  assertNativeComposeOwned,
  mergeNativeComposeNetworkPolicies,
  NativeComposeOwnershipError,
  type NativeComposeOwnershipObservation,
  type NativeComposeOwnershipOptions,
  observeNativeComposeStartupOwned,
  observeSavedNativeComposeOwned,
} from "./native-compose-ownership.ts";
import {
  measureNativeComposePhase,
  withNativeComposePhaseTrace,
} from "./native-compose-phase-trace.ts";
import { NativeComposeProxyAccessError } from "./native-compose-proxy-routes.ts";
import {
  assertNativeComposeSupported,
  NativeComposeRenderError,
  renderNativeCompose,
} from "./native-compose-renderer.ts";
import {
  mergeNativeComposeRetainedVolumes,
  type NativeComposeRetainedVolume,
  selectNativeComposeVolumePolicies,
} from "./native-compose-retained-storage.ts";
import { NativeComposeRouteClaimError } from "./native-compose-route-claims.ts";
import {
  type NativeComposeRoutingOwner,
  type NativeComposeSavedRunRouting,
  prepareNativeComposeRouteOwner,
  prepareNativeComposeSavedRunRouting,
  readNativeComposeRouteMetadata,
  releaseNativeComposeSavedRoutes,
  verifyNativeComposeSavedRoutesAbsent,
} from "./native-compose-route-owner.ts";
import { NativeComposeRoutingError } from "./native-compose-routing.ts";
import {
  assertNativeComposeOneOffUnexposed,
  nativeComposeRunContainerIdentity,
  nativeComposeRunSourceMatches,
} from "./native-compose-run-projection.ts";
import {
  requireNativeComposeBackend,
  selectNativeComposeProject,
} from "./native-compose-selection.ts";
import { waitNativeComposeReady } from "./native-compose-wait-ready.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import { nativeFilePlanningRequired } from "./native-file-plan-protocol.ts";
import { parseEnvConfigSelection } from "./project.ts";
import { run } from "./shell.ts";

type Operation = "up" | "restart" | "down" | "ps" | "logs" | "exec" | "run";
export type NativeComposeCommandOptions = {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly operation: Operation;
  readonly instance?: string;
  readonly profiles?: readonly string[];
  readonly overlay?: string | null;
  readonly json?: boolean;
  readonly detach?: boolean;
  readonly recover?: boolean;
  readonly services?: readonly string[];
  readonly service?: string;
  readonly command?: readonly string[];
  readonly workdir?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly logFormat?: LogOutputFormat;
  readonly unsupportedOptions?: boolean;
};

type PrivateDocument = Readonly<Record<string, unknown>>;
function invalid(): never {
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message: "The saved native Compose selection is invalid; values omitted.",
  });
}
function serviceMap(document: PrivateDocument): Record<string, unknown> {
  return isRecord(document.services) ? document.services : invalid();
}
async function savedRouteDocuments(store: NativeComposeGenerationStore) {
  const state = await store.loadCurrent();
  const pending = await store.loadPending();
  const generations = [state.generation, pending].filter(
    (value): value is NativeComposeGeneration => value !== null
  );
  return await Promise.all(
    generations.map(async (generation) => ({
      generation,
      generationId: generation.generationId,
      document: await store.readGenerationDocument(generation),
    }))
  );
}

function refuseRoutedRun(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Routed native Compose run requires an already-ready saved instance. Run up first; no hook or engine operation ran.",
  });
}
function assertRoutedRunAvailable(
  options: NativeComposeCommandOptions,
  current: Awaited<ReturnType<NativeComposeGenerationStore["loadCurrent"]>>,
  previous: Awaited<ReturnType<typeof savedRouteDocuments>>,
  selected: boolean
): void {
  const retained = previous.some(
    (saved) => readNativeComposeRouteMetadata(saved) !== null
  );
  if (
    options.operation === "run" &&
    (selected || retained) &&
    (current.stopped || current.generation === null || !retained)
  ) {
    refuseRoutedRun();
  }
}

function retainedStorageCapture() {
  let storage: readonly NativeComposeRetainedVolume[] | null = null;
  return {
    captureStorage: () => storage ?? invalid(),
    observeStorage(observed: NativeComposeOwnershipObservation) {
      try {
        storage = mergeNativeComposeRetainedVolumes({
          retained: storage ?? [],
          observed: observed.volumes,
        });
      } catch {
        return invalid();
      }
    },
  };
}

function routedRunEffectOwnership(opts: {
  readonly selection: NativeComposeOwnershipOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly service: string;
  readonly routing: NativeComposeSavedRunRouting;
}) {
  let before: string | null = null;
  const storage = retainedStorageCapture();
  return {
    ...storage,
    assertOwned: async () => {
      const observed = await assertNativeComposeOwned(opts.selection);
      storage.observeStorage(observed);
      if (
        !(
          ready(opts.document, observed, opts.generation) &&
          nativeComposeRunDependenciesReady(
            opts.document,
            observed,
            opts.generation,
            opts.service
          )
        )
      ) {
        throw new HackCliError({
          code: "E_STARTUP_INCOMPLETE",
          message:
            "The routed native instance or run dependencies are not ready; values omitted.",
        });
      }
      const identity = nativeComposeRunContainerIdentity(observed);
      if (before !== null && before !== identity) {
        throw new HackCliError({
          code: "E_STARTUP_INCOMPLETE",
          message:
            "Retained native containers changed during the one-off command; values omitted.",
        });
      }
      before = identity;
      await opts.routing.assertContinuity({
        deadline: Date.now() + resolveComposeStartupTimeoutMs(),
      });
    },
  };
}

/**
 * Active selection contains only proposed bridges after preserving every prior
 * physical policy. Generation finalization rechecks that exact inventory before
 * and after route completion; extra old networks cannot be forgotten.
 * Released old hostnames may now have a new owner.
 */
function preparedEffectOwnership(opts: {
  readonly selection: NativeComposeOwnershipOptions;
  readonly routing: NativeComposeRoutingOwner | null;
  readonly afterReadiness?: () => Promise<void>;
  readonly assertFiles?: () => Promise<void>;
  readonly assertFilesAfterCompletion?: () => Promise<void>;
  readonly retireFiles?: () => Promise<void>;
}) {
  let completed = false;
  const storage = retainedStorageCapture();
  return {
    ...storage,
    assertOwned: async () => {
      storage.observeStorage(await assertNativeComposeOwned(opts.selection));
      if (completed) {
        await opts.assertFilesAfterCompletion?.();
      } else {
        await opts.assertFiles?.();
      }
      if (!completed) {
        await opts.routing?.assertBeforeEffects();
      }
    },
    ...(opts.routing || opts.afterReadiness || opts.retireFiles
      ? {
          beforeComplete: async () => {
            await opts.afterReadiness?.();
            await opts.retireFiles?.();
            await opts.routing?.complete({
              deadline: Date.now() + resolveComposeStartupTimeoutMs(),
            });
            completed = true;
          },
        }
      : {}),
  };
}

/** Only a verified private document may select engine resources. */
async function ownershipSelection(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly signal: AbortSignal;
  readonly operation: Operation;
  readonly recover?: boolean;
}): Promise<NativeComposeOwnershipOptions> {
  const state = await opts.store.loadCurrent();
  const pending = await opts.store.loadPending();
  const generations = [opts.generation, state.generation, pending].filter(
    (value): value is NativeComposeGeneration => value !== null
  );
  const documents = [{ document: opts.document, generation: opts.generation }];
  const loaded = new Set([opts.generation.generationId]);
  for (const generation of generations) {
    if (!loaded.has(generation.generationId)) {
      documents.push({
        document: await opts.store.readGenerationDocument(generation),
        generation,
      });
      loaded.add(generation.generationId);
    }
  }
  const services = new Set<string>();
  const legacyStorage =
    state.retainedStorage === null && state.generation
      ? new Set(
          volumeSelections(
            await opts.store.readGenerationDocument(state.generation)
          ).map((volume) => volume.name)
        )
      : new Set<string>();
  const topologies = documents
    .filter(
      ({ generation }) =>
        !(
          state.stopped &&
          generation.generationId === state.generation?.generationId &&
          generation.generationId !== opts.generation.generationId
        )
    )
    .map(({ document, generation }) => ({
      document,
      generation,
      topology: readNativeComposeNetworkTopology(document, opts.store.identity),
    }));
  const proposed = topologies.find(
    ({ generation }) => generation.generationId === opts.generation.generationId
  );
  if (!proposed) {
    return invalid();
  }
  const expectedNetworks = mergeNativeComposeNetworkPolicies({
    proposed: proposed.topology.networks,
    retained: topologies
      .filter((value) => value !== proposed)
      .map((value) => value.topology.networks),
    retiring: opts.operation === "down",
  });
  const expectedWorkloadNetworks = topologies.flatMap(
    ({ document, generation, topology }) => {
      const routing = readNativeComposeRouteMetadata({
        document,
        generationId: generation.generationId,
      });
      return topology.workloads.map((workload) => ({
        generationId: generation.generationId,
        service: workload.service,
        networks: workload.networks.map((attachment) => {
          if (attachment.external && !routing) {
            return invalid();
          }
          return {
            name: attachment.name,
            aliases: attachment.aliases,
            ...(attachment.external
              ? { externalId: routing?.binding.networkId }
              : {}),
          };
        }),
      }));
    }
  );
  for (const { document } of documents) {
    for (const name of Object.keys(serviceMap(document))) {
      services.add(name);
    }
  }
  const expectedVolumes = selectNativeComposeVolumePolicies({
    declared: documents.flatMap(({ document }) => volumeSelections(document)),
    retained: state.retainedStorage ?? [],
    legacyNames: legacyStorage,
  });
  return {
    composeProject: opts.store.identity.composeProject,
    runtimeIdentity: opts.store.identity.composeProject,
    ownerToken: opts.store.identity.ownerToken,
    generationIds: [...new Set(generations.map((value) => value.generationId))],
    expectedServices: [...services],
    expectedVolumes,
    expectedNetworks,
    expectedWorkloadNetworks,
    ...(opts.operation === "down" && opts.recover
      ? { recovery: "down" as const }
      : {}),
    signal: opts.signal,
  };
}

function runtimeOptions(
  generation: NativeComposeGeneration
): RuntimeBaseOptions {
  return {
    composeFiles: [generation.composeFile],
    composeProject: generation.identity.composeProject,
    profiles: generation.profiles,
    cwd: generation.identity.checkoutRoot,
    env: {
      COMPOSE_DISABLE_ENV_FILE: "1",
      COMPOSE_ENV_FILES: "",
      COMPOSE_PROFILES: generation.profiles.join(","),
      COMPOSE_REMOVE_ORPHANS: "0",
    },
  };
}
function composeArgs(
  generation: NativeComposeGeneration,
  projection?: NativeComposeRunProjection
): string[] {
  return [
    "docker",
    "compose",
    "-p",
    generation.identity.composeProject,
    "-f",
    projection?.composeFile ?? generation.composeFile,
    ...generation.profiles.flatMap((profile) => ["--profile", profile]),
  ];
}

async function waitReady(opts: {
  readonly document: PrivateDocument;
  readonly ownership: NativeComposeOwnershipOptions;
  readonly deadline: number;
  readonly generation: NativeComposeGeneration;
  readonly observeStorage: (
    observed: NativeComposeOwnershipObservation
  ) => void;
}): Promise<NativeComposeOwnershipObservation | null> {
  const services = nativeComposeOnFailureServices(opts.document);
  return await waitNativeComposeReady({
    deadline: opts.deadline,
    signal: opts.ownership.signal,
    observe: async () => {
      const state = await observeNativeComposeStartupOwned(
        opts.ownership,
        services
      );
      if (state) {
        opts.observeStorage(state);
      }
      return state;
    },
    ready: (state) => ready(opts.document, state, opts.generation),
  });
}
function requireService(
  document: PrivateDocument,
  name: string | undefined
): string {
  if (!(name && Object.hasOwn(serviceMap(document), name))) {
    throw new HackCliError({
      code: "E_SERVICE_NOT_FOUND",
      message:
        "The selected workload is not in the saved native Compose generation.",
    });
  }
  return name;
}

function assertRunNetworkSupported(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly document: PrivateDocument;
  readonly identity: NativeComposeGenerationStore["identity"];
}): void {
  if (opts.options.operation !== "run") {
    return;
  }
  const service = requireService(opts.document, opts.options.service);
  const topology = readNativeComposeNetworkTopology(
    opts.document,
    opts.identity
  );
  if (
    topology.workloads
      .find((workload) => workload.service === service)
      ?.networks.some(
        (network) => !network.external && network.logicalName !== "default"
      )
  ) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "Native Compose run with custom networks requires qualified one-off attachment behavior. Use up or restart for this project; no engine operation ran. Values omitted.",
    });
  }
}

async function runSavedProcess(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly base: RuntimeBaseOptions;
  readonly signal: AbortSignal;
}) {
  const { options, generation, document, base } = opts;
  if (options.operation === "exec") {
    return await run(
      [
        ...composeArgs(generation),
        "exec",
        ...(process.stdin.isTTY === true && process.stdout.isTTY === true
          ? []
          : ["-T"]),
        ...(options.workdir ? ["-w", options.workdir] : []),
        requireService(document, options.service),
        ...(options.command ?? []),
      ],
      {
        cwd: base.cwd,
        env: base.env,
        stdin: "inherit",
        forwardSignals: true,
        signal: opts.signal,
      }
    );
  }
  if (options.service) {
    requireService(document, options.service);
  }
  return await run(
    [
      ...composeArgs(generation),
      "logs",
      ...((options.follow ?? true) ? ["--follow"] : []),
      "--tail",
      String(options.tail ?? 200),
      "--timestamps",
      "--no-color",
      ...(options.service ? [options.service] : []),
    ],
    {
      cwd: base.cwd,
      env: base.env,
      stdin: "ignore",
      forwardSignals: true,
      ...((options.follow ?? true) ? {} : { timeoutMs: 15_000 }),
    }
  );
}

async function savedCommand(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly store: NativeComposeGenerationStore;
  readonly signal: AbortSignal;
}): Promise<number> {
  const { options, store, signal } = opts;
  if (options.recover) {
    await store.recoverInterruptedLock();
  }
  const state = await store.loadCurrent();
  const pending = await store.loadPending();
  const generation =
    options.operation === "down" && options.recover && pending
      ? pending
      : (state.generation ??
        (options.operation === "ps" || options.operation === "logs"
          ? pending
          : null));
  if (!generation) {
    if (state.beforeHooksPending) {
      if (options.operation === "ps" && options.json) {
        emitCliResult({
          result: okResult({
            data: {
              composeProject: store.identity.composeProject,
              stopped: true,
              pending: true,
              beforeHooksPending: true,
              hostHookPhase: state.hostHookPhase,
              services: [],
            },
          }),
        });
        return 0;
      }
      throw new HackCliError({
        code: "E_LIFECYCLE_FAILED",
        message:
          "Native host hook completion is uncertain; no saved engine generation is available. Hook recovery is not supported in this slice. Values omitted.",
      });
    }
    throw new HackCliError({
      code: "E_PROJECT_NOT_FOUND",
      message:
        "This native Compose instance has no saved generation. Run hack up first.",
    });
  }
  const document = await store.readGenerationDocument(generation);
  const selection = await ownershipSelection({
    store,
    generation,
    document,
    signal,
    operation: options.operation,
    recover: options.recover,
  });
  const base = {
    ...runtimeOptions(generation),
    routeStdoutToStderr: options.json === true,
  };
  if (options.operation === "down") {
    return await store.withMutation(async (mutation) => {
      const recoveryState = await store.loadCurrent();
      const saved = await savedRouteDocuments(store);
      const prepared = await prepareSavedStop({
        store,
        generation,
        document,
        selection,
        saved,
        options,
        signal,
      });
      const { assertAbsent, hooks, hasDownHooks } = prepared;
      const assertOwned = async () => {
        await prepared.assertOwned();
        await assertNativeComposeSavedFileEngines({ saved, store, signal });
      };
      let finalizationError: HackCliError | null = null;
      const result = await mutation
        .runEffect({
          generation,
          operation: "down",
          recoverPending:
            options.recover === true &&
            (pending !== null || recoveryState.storageWitnessesPending),
          assertOwned,
          captureStorage: prepared.captureStorage,
          assertFresh: hooks?.assertFresh,
          downHooks: hooks?.downHooks,
          beforeComplete: async () => {
            try {
              if (hooks) {
                await hooks.assertSelectionUnchanged();
                await assertAbsent();
              }
              await retireNativeComposeSavedFiles({
                mutation,
                store,
                saved,
                selection,
                signal,
              });
              await finalizeNativeComposeStop({
                store,
                saved,
                signal,
                recover: options.recover,
              });
            } catch (error) {
              if (error instanceof HackCliError) {
                finalizationError = error;
              }
              throw error;
            }
          },
          effect: async () => {
            const stopping: {
              files: Awaited<
                ReturnType<typeof prepareNativeComposeSavedFileStop>
              >;
            } = { files: null };
            try {
              const code = await runNativeComposeOwnedFileChild({
                command: [
                  ...composeArgs(generation),
                  "down",
                  "--remove-orphans",
                ],
                signal,
                deadline: Date.now() + resolveComposeStartupTimeoutMs(),
                arm: async () => {
                  stopping.files = await prepareNativeComposeSavedFileStop({
                    mutation,
                    store,
                    saved,
                  });
                },
                assertOwned,
                options: {
                  cwd: base.cwd,
                  env: base.env,
                  forwardSignals: true,
                  stdout: options.json ? "stderr" : "inherit",
                },
                hooks: () => stopping.files?.hooks ?? {},
              });
              const observed = await assertNativeComposeOwned(selection);
              prepared.setStopped(
                code === 0 &&
                  (stopping.files === null || stopping.files.known()) &&
                  observed.containers.length === 0 &&
                  observed.networks.length === 0
              );
              if (
                options.recover === true &&
                code === 0 &&
                (stopping.files === null || stopping.files.known()) &&
                observed.containers.length === 0 &&
                observed.networks.length === 0
              ) {
                await reconcileNativeComposeCommandStorage({
                  store,
                  mutation,
                  generation,
                  signal,
                });
              }
              return {
                value: code,
                outcome:
                  code === 0 &&
                  (stopping.files === null || stopping.files.known()) &&
                  observed.containers.length === 0 &&
                  observed.networks.length === 0
                    ? ("complete" as const)
                    : ("uncertain" as const),
              };
            } finally {
              await stopping.files?.close();
            }
          },
        })
        .catch((error: unknown) => {
          throw finalizationError ?? error;
        });
      if (result.outcome !== "complete") {
        return reportNativeStopIncomplete(hooks?.code(), options.json === true);
      }
      if (options.json) {
        emitCliResult({
          result: okResult({
            data: {
              status: "stopped",
              composeProject: generation.identity.composeProject,
              dataRetained: true,
              ...(hasDownHooks && options.recover
                ? { hostHooksSkipped: true }
                : {}),
            },
          }),
        });
      }
      if (hasDownHooks && options.recover && !options.json) {
        process.stderr.write(
          "Saved native Compose resources stopped; authored down hooks were skipped by explicit recovery.\n"
        );
      }
      return result.value;
    });
  }
  if (options.operation === "exec") {
    const selected = volumeSelections(document);
    if (nativeComposeSavedExecUsesReadLease({ selected, current: state })) {
      return await store.withLease({
        generation,
        run: async () => {
          const assertImageOnly = async () => {
            const current = await store.loadCurrent();
            assertStartupAvailable(current);
            if (
              current.stopped ||
              current.generation?.generationId !== generation.generationId ||
              !nativeComposeSavedExecUsesReadLease({ selected, current })
            ) {
              throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
            }
          };
          await assertImageOnly();
          await store.readGenerationDocument(generation);
          await assertNativeComposeOwned(selection);
          await assertImageOnly();
          return await runSavedProcess({
            options,
            generation,
            document,
            base,
            signal,
          });
        },
      });
    }
    return await store.withMutation(async (mutation) => {
      const before = await store.loadCurrent();
      assertStartupAvailable(before);
      if (
        before.stopped ||
        before.generation?.generationId !== generation.generationId
      ) {
        throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
      }
      const storage = await prepareNativeComposeCommandStorage({
        store,
        mutation,
        operation: "exec",
        selected,
        signal,
      });
      const assertSaved = async () => {
        const latest = await store.loadCurrent();
        assertStartupAvailable(latest);
        if (
          latest.stopped ||
          latest.generation?.generationId !== generation.generationId
        ) {
          throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
        }
        await store.readGenerationDocument(generation);
        await assertNativeComposeOwned(selection);
        await storage?.verify(generation);
      };
      return await runNativeComposeStorageVerifiedExec({
        signal,
        assertSaved,
        run: () =>
          runSavedProcess({ options, generation, document, base, signal }),
      });
    });
  }
  return await store.withLease({
    generation,
    run: async () => {
      const observed =
        options.operation === "ps" || options.operation === "logs"
          ? await observeSavedNativeComposeOwned(selection)
          : await assertNativeComposeOwned(selection);
      if (options.operation === "ps") {
        if (options.json) {
          emitCliResult({
            result: okResult({
              data: {
                composeProject: generation.identity.composeProject,
                stopped: state.stopped,
                pending:
                  state.pending !== null || state.storageWitnessesPending,
                beforeHooksPending: state.beforeHooksPending,
                hostHookPhase: state.hostHookPhase,
                services: observed.containers.map(
                  ({ service, state: status, exitCode, health, oneoff }) => ({
                    service,
                    status,
                    exitCode,
                    health,
                    oneoff,
                  })
                ),
              },
            }),
          });
          return 0;
        }
        if (state.beforeHooksPending) {
          process.stderr.write(
            "Native host hook completion remains uncertain; hook recovery is not supported in this slice.\n"
          );
        }
        if (state.storageWitnessesPending) {
          process.stderr.write(
            "Native storage continuity or helper completion remains uncertain; saved recovery retains its anchors. Values omitted.\n"
          );
        }
        return await run([...composeArgs(generation), "ps"], {
          cwd: base.cwd,
          env: base.env,
          forwardSignals: true,
          timeoutMs: 15_000,
        });
      }
      return await runSavedProcess({
        options,
        generation,
        document,
        base,
        signal,
      });
    },
  });
}

async function prepareSavedStop(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly selection: NativeComposeOwnershipOptions;
  readonly saved: Awaited<ReturnType<typeof savedRouteDocuments>>;
  readonly options: NativeComposeCommandOptions;
  readonly signal: AbortSignal;
}) {
  const { store, generation, document, selection, saved, options, signal } =
    opts;
  const current = await store.loadCurrent();
  if (current.storageWitnessesPending && !options.recover) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  const hasDownHooks = Object.hasOwn(document, "x-hack-native-down-hooks");
  let engineStopped = false;
  let storage: readonly NativeComposeRetainedVolume[] | null = null;
  const assertOwned = async () => {
    const observed = await assertNativeComposeOwned(selection);
    storage = observed.volumes;
    if (
      engineStopped &&
      (observed.containers.length !== 0 || observed.networks.length !== 0)
    ) {
      throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
    }
  };
  const assertAbsent = async () => {
    const observed = await assertNativeComposeOwned(selection);
    if (observed.containers.length !== 0 || observed.networks.length !== 0) {
      throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
    }
    for (const value of saved) {
      await store.readGenerationDocument(value.generation);
    }
    await verifyNativeComposeSavedRoutesAbsent({
      owner: store.identity,
      saved,
      signal,
      deadline: Date.now() + resolveComposeStartupTimeoutMs(),
    });
  };
  let hooks:
    | Awaited<ReturnType<typeof prepareNativeComposeDownHooks>>
    | undefined;
  if (
    hasDownHooks &&
    !options.recover &&
    !(
      current.stopped &&
      current.pending === null &&
      !current.beforeHooksPending
    )
  ) {
    // This check precedes compiler/environment acquisition and cannot replay an interrupted phase.
    assertStartupAvailable(current);
    if (current.generation?.generationId !== generation.generationId) {
      return invalid();
    }
    const binding = readNativeComposeDownHookBinding({
      generation,
      document,
    });
    if (!binding) {
      return invalid();
    }
    await assertOwned();
    hooks = await prepareNativeComposeDownHooks({
      binding,
      projectRoot: store.identity.checkoutRoot,
      signal,
      json: options.json === true,
      assertAbsent,
    });
  }
  return {
    assertOwned,
    captureStorage: () => storage ?? invalid(),
    assertAbsent,
    hooks,
    hasDownHooks,
    setStopped: (stopped: boolean) => {
      engineStopped = stopped;
    },
  };
}

function reportNativeStopIncomplete(
  code: number | undefined,
  json: boolean
): number {
  if (code === undefined || code === 0) {
    throw new HackCliError({
      code: "E_COMPOSE_FAILED",
      message:
        "Native Compose stop is incomplete; saved ownership and persistent data are retained.",
    });
  }
  const message =
    "Native host down hook failed; stop remains incomplete and saved ownership is retained. Values omitted.";
  if (json) {
    emitCliResult({
      result: errorResult({ code: "E_LIFECYCLE_FAILED", message }),
    });
  } else {
    process.stderr.write(`${message}\n`);
  }
  return code;
}

/** Retire routes before the stop receipt can forget its recovery generation. */
async function finalizeNativeComposeStop(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly saved: Awaited<ReturnType<typeof savedRouteDocuments>>;
  readonly signal: AbortSignal;
  readonly recover?: boolean;
}): Promise<void> {
  const current = await opts.store.loadCurrent();
  if (current.storageWitnessesPending) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  if (current.beforeHooksPending) {
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Owned native Compose containers stopped; host hook completion remains uncertain and recovery is not supported in this slice. Persistent data, routing claims and the recovery generation are retained. Values omitted.",
    });
  }
  try {
    for (const value of opts.saved) {
      await opts.store.readGenerationDocument(value.generation);
    }
    await releaseNativeComposeSavedRoutes({
      owner: opts.store.identity,
      saved: opts.saved,
      signal: opts.signal,
      deadline: Date.now() + resolveComposeStartupTimeoutMs(),
      recover: opts.recover,
    });
  } catch {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Owned native Compose containers stopped; routing claims and the recovery generation remain retained because prior route effects or the exact ingress could not be verified. Retry down --recover after restoring the verified ingress. Values omitted.",
    });
  }
}

export async function assertNativeComposeEffectOwned(opts: {
  readonly assertFresh: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly verifyStorage?: () => Promise<void>;
}) {
  await measureNativeComposePhase("guard.fresh-before", opts.assertFresh);
  await measureNativeComposePhase("guard.ownership", opts.assertOwned);
  await measureNativeComposePhase("guard.storage", async () =>
    opts.verifyStorage?.()
  );
  await measureNativeComposePhase("guard.fresh-after", opts.assertFresh);
}

function startupOperation(
  operation: NativeComposeCommandOptions["operation"]
): operation is "up" | "restart" | "run" {
  return operation === "up" || operation === "restart" || operation === "run";
}

export async function runOneOff(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly selection: NativeComposeOwnershipOptions;
  readonly base: RuntimeBaseOptions;
  readonly projection?: NativeComposeRunProjection;
  readonly observeStorage: (
    observed: NativeComposeOwnershipObservation
  ) => void;
  readonly beforeSpawn?: () => void;
  readonly assertOwned: () => Promise<void>;
  readonly assertFresh: () => Promise<void>;
  readonly signal: AbortSignal;
}) {
  const { options, generation, document, selection, base, projection } = opts;
  const service = requireService(document, options.service);
  const name = `${generation.identity.composeProject}-run-${projection?.projectionId ?? randomBytes(16).toString("hex")}`;
  await opts.assertFresh();
  await opts.assertOwned();
  const code = await run(
    [
      ...composeArgs(generation, projection),
      "run",
      ...(projection ? ["--no-deps"] : []),
      "--name",
      name,
      ...(options.workdir ? ["-w", options.workdir] : []),
      service,
      ...(options.command ?? []),
    ],
    {
      cwd: base.cwd,
      env: base.env,
      stdin: "inherit",
      forwardSignals: true,
      signal: opts.signal,
      beforeSpawn: opts.beforeSpawn,
      stdout: options.json ? "stderr" : "inherit",
    }
  );
  const observed = await assertNativeComposeOwned(selection);
  opts.observeStorage(observed);
  const completed = nativeComposeCompletedOneoff({
    observed,
    name,
    generationId: generation.generationId,
    service,
    exitCode: code,
  });
  if (!completed) {
    return { value: code || 1, outcome: "uncertain" as const };
  }
  if (projection) {
    await assertNativeComposeOneOffUnexposed({
      id: completed.id,
      signal: selection.signal,
    });
  }
  // Its exact stopped ID was just verified under the retained owner.
  // Never force removal, match a name alone, or infer completion from absence.
  const removed = await run(["docker", "container", "rm", completed.id], {
    cwd: base.cwd,
    env: base.env,
    forwardSignals: true,
    timeoutMs: 15_000,
    stdout: "stderr",
  });
  const after = await measureNativeComposePhase(
    "oneoff.post-remove-owned",
    () => assertNativeComposeOwned(selection)
  );
  opts.observeStorage(after);
  await measureNativeComposePhase("oneoff.post-remove-fresh", () =>
    opts.assertFresh()
  );
  await measureNativeComposePhase("oneoff.post-remove-guard", () =>
    opts.assertOwned()
  );
  return {
    value: code,
    outcome:
      removed !== 0 ||
      after.containers.some((container) => container.oneoff) ||
      !nativeComposeRunDependenciesReady(document, after, generation, service)
        ? ("uncertain" as const)
        : ("complete" as const),
  };
}

async function startNativeComposeWorkloads(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly selection: NativeComposeOwnershipOptions;
  readonly base: RuntimeBaseOptions;
  readonly routing: NativeComposeRoutingOwner | null;
  readonly files: NativeComposeCommandFiles;
  readonly signal: AbortSignal;
  readonly assertOwned: () => Promise<void>;
  readonly builds: readonly NativeComposeBuildIntent[];
  readonly deadline: number;
  readonly observeStorage: (
    observed: NativeComposeOwnershipObservation
  ) => void;
}) {
  const {
    options,
    generation,
    document,
    selection,
    base,
    routing,
    files,
    signal,
    assertOwned,
    deadline,
  } = opts;
  if (deadline <= Date.now()) {
    return { value: 1, outcome: "uncertain" as const };
  }
  const code = await runNativeComposeOwnedFileChild({
    signal,
    deadline,
    arm: async () => {
      await routing?.markEffectsPossible();
      await files?.arm(generation);
    },
    assertOwned,
    command: [
      ...composeArgs(generation),
      "up",
      ...(opts.builds.length > 0 ? ["--no-build"] : []),
      "-d",
      "--remove-orphans",
      ...(options.operation === "restart" ? ["--force-recreate"] : []),
    ],
    options: {
      cwd: base.cwd,
      env: base.env,
      stdout: options.json ? "stderr" : "inherit",
      forwardSignals: true,
    },
    hooks: () => files?.childHooks(generation) ?? {},
  });
  const observed =
    code === 0 && (files === null || files.childReaped())
      ? await waitReady({
          document,
          ownership: selection,
          deadline,
          generation,
          observeStorage: opts.observeStorage,
        })
      : null;
  if (observed) {
    await files?.assertReady(selection, generation);
    await routing?.verifyTransition({ deadline });
  }
  return {
    value: observed ? 0 : code || 1,
    outcome: observed ? ("complete" as const) : ("uncertain" as const),
  };
}

async function executePreparedNativeWorkloads(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly selection: NativeComposeOwnershipOptions;
  readonly base: RuntimeBaseOptions;
  readonly routing: NativeComposeRoutingOwner | null;
  readonly files: NativeComposeCommandFiles;
  readonly builds: readonly NativeComposeBuildIntent[];
  readonly projection?: NativeComposeRunProjection;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly assertFresh: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly observeStorage: (
    observed: NativeComposeOwnershipObservation
  ) => void;
}) {
  const deadline =
    opts.options.operation === "run"
      ? undefined
      : Date.now() + resolveComposeStartupTimeoutMs();
  if (opts.builds.length > 0) {
    const code = await buildNativeComposeImages({
      intents: opts.builds,
      projectRoot: opts.projectRoot,
      deadline,
      signal: opts.signal,
      env: opts.base.env,
      json: opts.options.json === true,
      assertFresh: opts.assertFresh,
      assertOwned: opts.assertOwned,
    });
    if (code !== 0) {
      return { value: code, outcome: "uncertain" as const };
    }
    await opts.assertFresh();
    await opts.assertOwned();
  }
  if (opts.options.operation === "run") {
    return await runOneOff(opts);
  }
  return await startNativeComposeWorkloads({
    ...opts,
    deadline: deadline ?? Date.now() + resolveComposeStartupTimeoutMs(),
  });
}

async function publishPreparedGeneration(opts: {
  readonly existing: NativeComposeGeneration | null;
  readonly reservation: NativeComposeReservation | null;
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly document: PrivateDocument;
  readonly profiles: readonly string[];
  readonly inputRevision: string;
  readonly assertFresh: () => Promise<void>;
}): Promise<NativeComposeGeneration> {
  if (opts.existing) {
    const saved = await opts.store.readGenerationDocument(opts.existing);
    if (JSON.stringify(saved) !== JSON.stringify(opts.document)) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message:
          "Native Compose inputs differ from the running generation. Run hack up or restart before a one-off command. Values omitted.",
      });
    }
    return opts.existing;
  }
  if (!opts.reservation) {
    return invalid();
  }
  return await opts.mutation.publish({
    reservation: opts.reservation,
    composeJson: JSON.stringify(opts.document),
    profiles: opts.profiles,
    inputRevision: opts.inputRevision,
    assertFresh: opts.assertFresh,
  });
}

type SavedRouteDocuments = Awaited<ReturnType<typeof savedRouteDocuments>>;

async function prepareExecutionRouting(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly store: NativeComposeGenerationStore;
  readonly existingRun: NativeComposeGeneration | null;
  readonly generationId: string;
  readonly document: PrivateDocument;
  readonly inputs: AcquiredComposeInputs;
  readonly previous: SavedRouteDocuments;
  readonly signal: AbortSignal;
}) {
  const {
    options,
    store,
    existingRun,
    generationId,
    document,
    inputs,
    previous,
    signal,
  } = opts;
  let savedRun: PrivateDocument | null = null;
  if (existingRun) {
    savedRun = await store.readGenerationDocument(existingRun);
    if (
      !nativeComposeRunSourceMatches({
        saved: savedRun,
        rendered: document,
        generationId,
      })
    ) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message:
          "Native Compose inputs differ from the saved run generation. Run up or restart first; values omitted.",
      });
    }
  }
  const routing =
    options.operation === "run"
      ? null
      : await prepareNativeComposeRouteOwner({
          owner: store.identity,
          generationId,
          document,
          plan: inputs.result.plan,
          resolution: inputs.result.routing_resolution,
          declared: inputs.result.declared_workloads,
          previous,
          signal,
        });
  const runRouting = savedRun
    ? await prepareNativeComposeSavedRunRouting({
        owner: store.identity,
        generationId,
        document: savedRun,
        signal,
      })
    : null;
  return {
    routing,
    runRouting,
    document: savedRun ?? routing?.document ?? document,
  };
}

async function executePreparedGeneration(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly inputs: AcquiredComposeInputs;
  readonly acquire: () => Promise<AcquiredComposeInputs>;
  readonly projectRoot: string;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly buildSource: PrivateDocument;
  readonly previous: SavedRouteDocuments;
  readonly routing: NativeComposeRoutingOwner | null;
  readonly runRouting: NativeComposeSavedRunRouting | null;
  readonly files: NativeComposeCommandFiles;
  readonly signal: AbortSignal;
  readonly storage: NativeComposeCommandStorage;
}): Promise<number> {
  const {
    options,
    mutation,
    store,
    inputs,
    acquire,
    projectRoot,
    generation,
    document,
    buildSource,
    previous,
    routing,
    runRouting,
    files,
    signal,
    storage,
  } = opts;
  const selection = await ownershipSelection({
    store,
    generation,
    document,
    signal,
    operation: options.operation,
  });
  const base = {
    ...runtimeOptions(generation),
    routeStdoutToStderr: options.json === true,
  };
  const projection = runRouting
    ? await mutation.publishRunProjection({
        generation,
        service: requireService(document, options.service),
        assertFresh: inputs.assertFresh,
      })
    : undefined;
  const operation = options.operation;
  if (operation !== "up" && operation !== "restart" && operation !== "run") {
    return invalid();
  }
  const after = preparedAfterHookPhase({
    inputs,
    acquire,
    projectRoot,
    signal,
    json: options.json === true,
    document,
    generation,
    selection,
    routing,
  });
  const buildOptions = {
    document: buildSource,
    projectRoot,
    composeProject: store.identity.composeProject,
    ownerToken: store.identity.ownerToken,
    service:
      operation === "run"
        ? requireService(document, options.service)
        : undefined,
    includeDependencies: runRouting === null,
  };
  const builds = planNativeComposeBuilds(buildOptions);
  const assertFresh = async () => {
    await inputs.assertFresh();
    const saved = await store.readGenerationDocument(generation);
    assertNativeComposeBuildExecution({
      ...buildOptions,
      executionDocument: saved,
      intents: builds,
    });
    if (projection) {
      await mutation.assertRunProjection(projection);
    }
    for (const prior of previous) {
      await store.readGenerationDocument(prior.generation);
    }
  };
  const ownership = runRouting
    ? routedRunEffectOwnership({
        selection,
        generation,
        document,
        service: requireService(document, options.service),
        routing: runRouting,
      })
    : preparedEffectOwnership({
        selection,
        routing,
        afterReadiness: after.afterReadiness,
        assertFiles: async () => {
          await files?.assertBeforeEffects(generation);
          await assertNativeComposeSavedFileEngines({
            saved: previous,
            store,
            signal,
          });
        },
        assertFilesAfterCompletion: async () => {
          await files?.assertReady(selection, generation);
          await assertNativeComposeSavedFileEngines({
            saved: previous,
            store,
            signal,
          });
        },
        retireFiles: async () => {
          await files?.assertReady(selection, generation);
          await retireNativeComposeSavedFiles({
            mutation,
            store,
            saved: previous,
            selection,
            signal,
          });
        },
      });
  const result = await mutation.runEffect({
    generation,
    operation,
    ...(projection ? { projection } : {}),
    assertFresh,
    ...ownership,
    afterHooks: after.afterHooks,
    storageWitnesses: storage?.effectWitnesses,
    effect: async () => {
      await measureNativeComposePhase("storage.enroll", async () =>
        storage?.enroll(generation, document)
      );
      return await executePreparedNativeWorkloads({
        options,
        generation,
        document,
        selection,
        base,
        routing,
        files,
        projection,
        builds,
        projectRoot,
        signal,
        assertFresh,
        observeStorage: ownership.observeStorage,
        assertOwned: () =>
          assertNativeComposeEffectOwned({
            assertFresh,
            assertOwned: () => ownership.assertOwned(),
            verifyStorage: storage
              ? () => storage.verify(generation)
              : undefined,
          }),
      });
    },
  });
  if (result.outcome === "uncertain") {
    return reportNativeStartupIncomplete({
      afterHookCode: after.code(),
      json: options.json === true,
    });
  }
  if (options.json) {
    emitCliResult({
      result: okResult({
        data: {
          status: "ready",
          composeProject: store.identity.composeProject,
        },
      }),
    });
  }
  return result.value;
}

async function prepareNativeComposeDelivery(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly inputs: AcquiredComposeInputs;
  readonly acquire: () => Promise<AcquiredComposeInputs>;
  readonly projectRoot: string;
  readonly existing: NativeComposeGeneration | null;
  readonly existingRun: NativeComposeGeneration | null;
  readonly reservation: NativeComposeReservation | null;
  readonly generationId: string;
  readonly files: NativeComposeCommandFiles;
  readonly previous: SavedRouteDocuments;
  readonly signal: AbortSignal;
  readonly storage: NativeComposeCommandStorage;
}): Promise<number> {
  const {
    options,
    mutation,
    store,
    acquire,
    projectRoot,
    existing,
    existingRun,
    reservation,
    generationId,
    files,
    previous,
    signal,
  } = opts;
  const inputs = files?.inputs ?? opts.inputs;
  const values = await inputs.resolveManagedValues();
  const rendered = renderNativeCompose({
    plan: inputs.result.plan,
    environmentPlan: inputs.result.environment_plan,
    projectRoot,
    runtimeIdentity: store.identity.composeProject,
    generationIdentity: generationId,
    ownerToken: store.identity.ownerToken,
    managedValues: values,
    routingResolution: inputs.result.routing_resolution,
    declaredWorkloads: inputs.result.declared_workloads,
    filePlan: inputs.result.file_plan,
    fileProjection: files?.projection,
    beforeHooksOwned: true,
  });
  assertRunNetworkSupported({
    options,
    document: rendered.document,
    identity: store.identity,
  });
  const buildExecution = prepareNativeComposeBuildExecution({
    document: rendered.document,
    projectRoot,
    composeProject: store.identity.composeProject,
    ownerToken: store.identity.ownerToken,
  });
  const {
    routing,
    runRouting,
    document: routedDocument,
  } = await prepareExecutionRouting({
    options,
    store,
    existingRun,
    generationId,
    document: buildExecution.document,
    inputs,
    previous,
    signal,
  });
  try {
    const boundDocument = bindNativeComposeDownHooks({
      inputs,
      profiles: rendered.profiles,
      explicitOverlay: options.overlay,
      document: routedDocument,
    });
    const document = files?.document(boundDocument) ?? boundDocument;
    const generation = await publishPreparedGeneration({
      existing,
      reservation,
      mutation,
      store,
      document,
      profiles: rendered.profiles,
      inputRevision: inputs.inputRevision,
      assertFresh: inputs.assertFresh,
    });
    return await executePreparedGeneration({
      options,
      mutation,
      store,
      inputs,
      acquire,
      projectRoot,
      generation,
      document,
      buildSource: rendered.document,
      previous,
      routing,
      runRouting,
      files,
      signal,
      storage: opts.storage,
    });
  } finally {
    await runRouting?.close();
    await routing?.close();
  }
}

async function prepareCommand(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const { options, projectRoot, signal } = opts;
  const acquire = () =>
    acquireNativeComposeFilePlanningInputs({
      projectRoot,
      profiles: options.profiles,
      explicitOverlay: options.overlay,
      signal,
    });
  let inputs = await acquire();
  assertSelectedWorkloads(inputs);
  assertNativeComposeSupported({
    plan: inputs.result.plan,
    environmentPlan: inputs.result.environment_plan,
    projectRoot,
    runtimeIdentity: "native-preflight",
    generationIdentity: "0".repeat(32),
    ownerToken: "0".repeat(32),
    routingResolution: inputs.result.routing_resolution,
    declaredWorkloads: inputs.result.declared_workloads,
    filePlan: inputs.result.file_plan,
    beforeHooksOwned: true,
  });
  const hooks = [
    ...selectNativeComposeBeforeHooks(inputs.result.plan),
    ...selectNativeComposeAfterHooks(inputs.result.plan),
    ...selectNativeComposeDownHooks(inputs.result.plan).before,
    ...selectNativeComposeDownHooks(inputs.result.plan).after,
  ];
  assertNativeComposeFileRunSupported({
    operation: options.operation,
    plan: inputs.result.plan,
  });
  assertNativeComposeBeforeHookBindings({
    hooks,
    environmentPlan: inputs.result.environment_plan,
  });
  if (options.operation === "run" && hooks.length > 0) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "Native Compose run with authored host hooks is not supported in this slice. No hook or engine operation ran. Values omitted.",
    });
  }
  const store = await openNativeComposeGenerationStore({
    projectRoot,
    instance: options.instance ?? null,
    mode: "prepare",
  });
  try {
    return await store.withMutation(async (mutation) => {
      const current = await store.loadCurrent();
      assertStartupAvailable(current);
      const previous = current.stopped ? [] : await savedRouteDocuments(store);
      assertNativeComposeFileRunSupported({
        operation: options.operation,
        plan: inputs.result.plan,
        previous,
      });
      assertRoutedRunAvailable(
        options,
        current,
        previous,
        inputs.result.plan.routes !== undefined ||
          inputs.result.plan.open !== undefined
      );
      const operation = options.operation;
      if (!startupOperation(operation)) {
        return invalid();
      }
      const storage = await prepareNativeComposeCommandStorage({
        store,
        mutation,
        operation,
        signal,
        selected: nativeComposePlanStorage({
          storage: inputs.result.plan.storage,
          runtimeIdentity: store.identity.composeProject,
        }),
        assertFresh: async () => {
          await inputs.assertFresh();
        },
      });
      const prepared = await prepareBeforeHooks({
        inputs,
        acquire,
        mutation,
        store,
        options,
        projectRoot,
        signal,
      });
      if (prepared.code !== 0) {
        return prepared.code;
      }
      inputs = prepared.inputs;
      const reusableUp = await unchangedUnroutedUp({
        options,
        current,
        inputs,
        store,
        projectRoot,
      });
      const existingRun =
        options.operation === "run" ? current.generation : null;
      const existing = existingRun ?? reusableUp?.generation ?? null;
      const reservation = existing ? null : mutation.reserveGeneration();
      const generationId = existing?.generationId ?? reservation?.generationId;
      if (!generationId) {
        return invalid();
      }
      const files = reservation
        ? await prepareNativeComposeCommandFiles({
            mutation,
            store,
            reservation,
            inputs,
            profiles: options.profiles,
            explicitOverlay: options.overlay,
            signal,
          })
        : null;
      try {
        return await prepareNativeComposeDelivery({
          options,
          mutation,
          store,
          inputs,
          acquire,
          projectRoot,
          existing,
          existingRun,
          reservation,
          generationId,
          files,
          previous,
          signal,
          storage,
        });
      } catch (error) {
        await files?.rollback().catch(() => {
          /* Unproved rollback retains material; preserve the original failure. */
        });
        throw error;
      } finally {
        await files?.close();
      }
    });
  } finally {
    await store.close();
  }
}

type AcquiredComposeInputs = NativeComposeExecutionInputs;

/** Exact private correspondence permits reuse; it never bypasses effects or readiness. */
async function unchangedUnroutedUp(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly current: Awaited<
    ReturnType<NativeComposeGenerationStore["loadCurrent"]>
  >;
  readonly inputs: AcquiredComposeInputs;
  readonly store: NativeComposeGenerationStore;
  readonly projectRoot: string;
}) {
  const generation = opts.current.generation;
  if (
    opts.options.operation !== "up" ||
    opts.current.stopped ||
    !generation ||
    generation.inputRevision !== opts.inputs.inputRevision ||
    nativeFilePlanningRequired(opts.inputs.result.plan) ||
    opts.inputs.result.plan.routes !== undefined ||
    opts.inputs.result.plan.open !== undefined
  ) {
    return null;
  }
  const saved = await opts.store.readGenerationDocument(generation);
  if (
    readNativeComposeRouteMetadata({
      generationId: generation.generationId,
      document: saved,
    })
  ) {
    return null;
  }
  const values = await opts.inputs.resolveManagedValues();
  const rendered = renderNativeCompose({
    plan: opts.inputs.result.plan,
    environmentPlan: opts.inputs.result.environment_plan,
    projectRoot: opts.projectRoot,
    runtimeIdentity: opts.store.identity.composeProject,
    generationIdentity: generation.generationId,
    ownerToken: opts.store.identity.ownerToken,
    managedValues: values,
    routingResolution: opts.inputs.result.routing_resolution,
    declaredWorkloads: opts.inputs.result.declared_workloads,
    filePlan: opts.inputs.result.file_plan,
    beforeHooksOwned: true,
  });
  const buildExecution = prepareNativeComposeBuildExecution({
    document: rendered.document,
    projectRoot: opts.projectRoot,
    composeProject: opts.store.identity.composeProject,
    ownerToken: opts.store.identity.ownerToken,
  });
  const document = bindNativeComposeDownHooks({
    inputs: opts.inputs,
    profiles: rendered.profiles,
    explicitOverlay: opts.options.overlay,
    document: buildExecution.document,
  });
  return JSON.stringify(generation.profiles) ===
    JSON.stringify(rendered.profiles) &&
    JSON.stringify(saved) === JSON.stringify(document)
    ? { generation, rendered }
    : null;
}

function reportNativeStartupIncomplete(opts: {
  readonly afterHookCode: number | undefined;
  readonly json: boolean;
}): number {
  if (opts.afterHookCode === undefined || opts.afterHookCode === 0) {
    throw new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message:
        "Native Compose execution is incomplete; inspect saved state and use explicit owned stop recovery before retrying.",
    });
  }
  const message =
    "Native host after hook failed; startup remains incomplete and saved ownership is retained. Values omitted.";
  if (opts.json) {
    emitCliResult({
      result: errorResult({ code: "E_LIFECYCLE_FAILED", message }),
    });
  } else {
    process.stderr.write(`${message}\n`);
  }
  return opts.afterHookCode;
}

function preparedAfterHookPhase(opts: {
  readonly inputs: AcquiredComposeInputs;
  readonly acquire: () => Promise<AcquiredComposeInputs>;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly json: boolean;
  readonly document: PrivateDocument;
  readonly generation: NativeComposeGeneration;
  readonly selection: NativeComposeOwnershipOptions;
  readonly routing: NativeComposeRoutingOwner | null;
}) {
  let code: number | undefined;
  if (selectNativeComposeAfterHooks(opts.inputs.result.plan).length === 0) {
    return {
      afterHooks: undefined,
      afterReadiness: undefined,
      code: () => code,
    };
  }
  return {
    code: () => code,
    afterHooks: {
      prepare: async () => {
        const execute = await prepareNativeComposeAfterHooks(opts);
        return async () => {
          const result = await execute();
          code = result.value;
          return result;
        };
      },
    },
    afterReadiness: async () => {
      await assertNativeComposeAfterInputsUnchanged(opts);
      const observed = await assertNativeComposeOwned(opts.selection);
      if (!ready(opts.document, observed, opts.generation)) {
        throw new HackCliError({
          code: "E_STARTUP_INCOMPLETE",
          message:
            "Native workloads are no longer ready after host hooks; startup remains incomplete. Values omitted.",
        });
      }
      await opts.routing?.verifyTransition({
        deadline: Date.now() + resolveComposeStartupTimeoutMs(),
      });
    },
  };
}

function assertSelectedWorkloads(inputs: AcquiredComposeInputs): void {
  if (Object.keys(inputs.result.environment_plan.workloads).length === 0) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "The selected native Compose profile has no workloads to execute.",
    });
  }
}

function assertStartupAvailable(
  current: Awaited<ReturnType<NativeComposeGenerationStore["loadCurrent"]>>
) {
  if (current.storageWitnessesPending) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  if (current.beforeHooksPending) {
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native host hook completion remains uncertain; startup is blocked without replay. Hook recovery is not supported in this slice. Values omitted.",
    });
  }
  if (current.pending !== null) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
}

async function prepareBeforeHooks(opts: {
  readonly inputs: AcquiredComposeInputs;
  readonly acquire: () => Promise<AcquiredComposeInputs>;
  readonly mutation: NativeComposeMutation;
  readonly store: NativeComposeGenerationStore;
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}) {
  let inputs = opts.inputs;
  const { acquire, mutation, options, projectRoot, signal } = opts;
  const hooks = selectNativeComposeBeforeHooks(inputs.result.plan);
  if (hooks.length === 0) {
    return { inputs, code: 0 };
  }
  const admitted = hookSelectionIdentity(inputs);
  // Credential approval and private delivery precede the effect journal: a rejected
  // approval must not leave ambiguous hook effects when no command could have spawned.
  const managedValues = new Map<string, Readonly<Record<string, string>>>();
  for (const hook of hooks) {
    managedValues.set(hook.name, await inputs.resolveHostValues(hook.name));
  }
  assertNativeComposeBeforeHookBindings({
    hooks,
    environmentPlan: inputs.result.environment_plan,
    managedValues,
  });
  const result = await mutation.runBeforeHooks({
    assertFresh: inputs.assertFresh,
    effect: () =>
      runNativeComposeBeforeHooks({
        hooks,
        projectRoot,
        environmentPlan: inputs.result.environment_plan,
        resolveHostValues: (name) => {
          const values = managedValues.get(name);
          if (!values) {
            throw new NativeComposeHostHookError();
          }
          return Promise.resolve(values);
        },
        signal,
        timeoutMs: resolveComposeStartupTimeoutMs(),
        json: options.json === true,
      }),
  });
  if (result.outcome !== "complete") {
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message:
        "Native host hook completion is uncertain; startup is blocked without replay. Hook recovery is not supported in this slice. Values omitted.",
    });
  }
  if (result.value !== 0) {
    const message =
      "Native host before hook failed; no engine startup ran. Values omitted.";
    if (options.json) {
      emitCliResult({
        result: errorResult({ code: "E_LIFECYCLE_FAILED", message }),
      });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return { inputs, code: result.value };
  }
  // Hooks may deliberately write managed env/local bindings. Reacquire every owner;
  // changed identity or hook selection must not skip a newly authored sequence.
  inputs = await acquire();
  assertSelectedWorkloads(inputs);
  if (hookSelectionIdentity(inputs) !== admitted) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Native project identity or hook selection changed during before hooks; no engine startup ran. Values omitted.",
    });
  }
  assertNativeComposeSupported({
    plan: inputs.result.plan,
    environmentPlan: inputs.result.environment_plan,
    projectRoot,
    runtimeIdentity: opts.store.identity.composeProject,
    generationIdentity: "0".repeat(32),
    ownerToken: opts.store.identity.ownerToken,
    beforeHooksOwned: true,
    routingResolution: inputs.result.routing_resolution,
    declaredWorkloads: inputs.result.declared_workloads,
    filePlan: inputs.result.file_plan,
  });
  assertNativeComposeBeforeHookBindings({
    hooks: selectNativeComposeBeforeHooks(inputs.result.plan),
    environmentPlan: inputs.result.environment_plan,
  });
  return { inputs, code: 0 };
}

function hookSelectionIdentity(inputs: NativeComposeExecutionInputs): string {
  const plan = inputs.result.plan;
  return JSON.stringify({
    name: plan.name,
    source: plan.source,
    worktree: plan.worktree,
    profiles: plan.selected_profiles,
    host: plan.host,
  });
}

function validateNativeOptions(options: NativeComposeCommandOptions): boolean {
  if (
    options.unsupportedOptions ||
    options.services?.length ||
    (options.operation === "logs" &&
      options.logFormat !== undefined &&
      options.logFormat !== "plain") ||
    (options.operation === "up" && !(options.detach || options.json))
  ) {
    throw new CliUsageError(
      "This native Compose slice requires whole-project detached startup and refuses unsupported lifecycle, pruning, browser or log options."
    );
  }
  const prepare = ["up", "restart", "run"].includes(options.operation);
  if (!prepare && (options.overlay !== undefined || options.profiles?.length)) {
    throw new CliUsageError(
      "Saved native Compose operations use the retained generation; env/profile changes require up or restart."
    );
  }
  if (options.recover && options.operation !== "down") {
    throw new CliUsageError(
      "Native Compose interrupted ownership recovery currently requires down --recover."
    );
  }
  return prepare;
}

/** Dispatch native authored inputs before any legacy context or registry mutation. */
export async function tryNativeComposeCommand(
  input: NativeComposeCommandOptions
): Promise<number | null> {
  return await withNativeComposePhaseTrace(() =>
    dispatchNativeComposeCommand(input)
  );
}

async function dispatchNativeComposeCommand(
  input: NativeComposeCommandOptions
): Promise<number | null> {
  // Capture the CLI selection once: explicit base is null, omission inherits.
  // Adoption still checks the original request before authored dispatch.
  const options = {
    ...input,
    overlay:
      input.overlay === null ? null : parseEnvConfigSelection(input.overlay),
  };
  const adopted = await tryLegacyComposeAdoptedCommand(input);
  if (adopted !== null) {
    return adopted;
  }
  const selected = await selectNativeComposeProject(options);
  if (!selected) {
    return null;
  }
  const native = await tryNativeAuthoredCommand({ options, selected });
  if (native !== null) {
    return native;
  }
  requireNativeComposeBackend({ backend: process.env.HACK_RUNTIME_BACKEND });
  const prepare = validateNativeOptions(options);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (prepare) {
      return await prepareCommand({
        options,
        projectRoot: selected.projectRoot,
        signal: controller.signal,
      });
    }
    const store = await openNativeComposeGenerationStore({
      projectRoot: selected.projectRoot,
      instance: options.instance ?? null,
      mode: "saved",
    });
    try {
      return await savedCommand({ options, store, signal: controller.signal });
    } finally {
      await store.close();
    }
  } catch (error: unknown) {
    return throwNativeComposeCommandError(error);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

function throwNativeComposeCommandError(error: unknown): never {
  if (error instanceof NativeConfigCompilerError) {
    throw new HackCliError({
      code:
        error.code === "E_NATIVE_PROJECT_UNSUPPORTED"
          ? error.code
          : "E_CONFIG_INVALID",
      message: error.message,
    });
  }
  if (error instanceof NativeComposeProxyAccessError) {
    throw new HackCliError({ code: error.code, message: error.message });
  }
  if (error instanceof NativeComposeHostHookError) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: error.message,
    });
  }
  if (
    error instanceof NativeComposeGenerationError ||
    error instanceof NativeComposeOwnershipError ||
    error instanceof NativeComposeBuildError
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: error.message,
    });
  }
  if (error instanceof NativeComposeRenderError) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "Native Compose does not yet support this selected workload contract; no engine operation ran. Values omitted.",
    });
  }
  if (
    error instanceof NativeComposeRoutingError ||
    error instanceof NativeComposeRouteClaimError
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Native Compose routing admission or verification failed; routing claims and owned state are preserved as required. Values omitted.",
    });
  }
  if (error instanceof HackCliError || error instanceof CliUsageError) {
    throw error;
  }
  throw new HackCliError({
    code: "E_COMPOSE_FAILED",
    message:
      "Native Compose operation failed; saved ownership and persistent data are retained. Values omitted.",
  });
}
