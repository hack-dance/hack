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
import { tryLegacyComposeAdoptedCommand } from "./native-compose-adoption-command.ts";
import {
  assertNativeComposeAfterInputsUnchanged,
  prepareNativeComposeAfterHooks,
} from "./native-compose-after-hooks.ts";
import {
  nativeComposeCompletedOneoff,
  nativeComposeRunDependenciesReady,
  nativeComposeWorkloadsReady as ready,
} from "./native-compose-completion.ts";
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
} from "./native-compose-host-contract.ts";
import {
  assertNativeComposeBeforeHookBindings,
  runNativeComposeBeforeHooks,
} from "./native-compose-host-hooks.ts";
import { acquireNativeComposeInputs } from "./native-compose-inputs.ts";
import {
  assertNativeComposeOwned,
  mergeNativeComposeNetworkPolicies,
  NativeComposeOwnershipError,
  type NativeComposeOwnershipObservation,
  type NativeComposeOwnershipOptions,
  observeSavedNativeComposeOwned,
} from "./native-compose-ownership.ts";
import { NativeComposeProxyAccessError } from "./native-compose-proxy-routes.ts";
import {
  assertNativeComposeSupported,
  NativeComposeRenderError,
  renderNativeCompose,
} from "./native-compose-renderer.ts";
import { NativeComposeRouteClaimError } from "./native-compose-route-claims.ts";
import {
  type NativeComposeRoutingOwner,
  type NativeComposeSavedRunRouting,
  prepareNativeComposeRouteOwner,
  prepareNativeComposeSavedRunRouting,
  readNativeComposeRouteMetadata,
  releaseNativeComposeSavedRoutes,
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
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
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
function volumeSelections(document: PrivateDocument) {
  if (!isRecord(document.volumes)) {
    return invalid();
  }
  return Object.entries(document.volumes).map(([storage, value]) => {
    if (!isRecord(value) || typeof value.name !== "string") {
      return invalid();
    }
    return { storage, name: value.name };
  });
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

function routedRunEffectOwnership(opts: {
  readonly selection: NativeComposeOwnershipOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly service: string;
  readonly routing: NativeComposeSavedRunRouting;
}) {
  let before: string | null = null;
  return {
    assertOwned: async () => {
      const observed = await assertNativeComposeOwned(opts.selection);
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
}) {
  let completed = false;
  return {
    assertOwned: async () => {
      await assertNativeComposeOwned(opts.selection);
      if (!completed) {
        await opts.routing?.assertBeforeEffects();
      }
    },
    ...(opts.routing || opts.afterReadiness
      ? {
          beforeComplete: async () => {
            await opts.afterReadiness?.();
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
  const volumes = new Map<string, { storage: string; name: string }>();
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
    for (const selection of volumeSelections(document)) {
      const existing = volumes.get(selection.name);
      if (existing && existing.storage !== selection.storage) {
        return invalid();
      }
      volumes.set(selection.name, selection);
    }
  }
  return {
    composeProject: opts.store.identity.composeProject,
    runtimeIdentity: opts.store.identity.composeProject,
    ownerToken: opts.store.identity.ownerToken,
    generationIds: [...new Set(generations.map((value) => value.generationId))],
    expectedServices: [...services],
    expectedVolumes: [...volumes.values()],
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
}): Promise<NativeComposeOwnershipObservation | null> {
  while (Date.now() < opts.deadline) {
    const state = await assertNativeComposeOwned(opts.ownership);
    if (ready(opts.document, state, opts.generation)) {
      return state;
    }
    if (opts.ownership.signal?.aborted) {
      return null;
    }
    await Bun.sleep(500);
  }
  return null;
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
      ?.networks.some((network) => network.logicalName !== "default")
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
      const saved = await savedRouteDocuments(store);
      let finalizationError: HackCliError | null = null;
      const result = await mutation
        .runEffect({
          generation,
          operation: "down",
          recoverPending: options.recover === true && pending !== null,
          assertOwned: async () => {
            await assertNativeComposeOwned(selection);
          },
          beforeComplete: async () => {
            try {
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
            const code = await run(
              [...composeArgs(generation), "down", "--remove-orphans"],
              {
                cwd: base.cwd,
                env: base.env,
                forwardSignals: true,
                stdout: options.json ? "stderr" : "inherit",
                timeoutMs: resolveComposeStartupTimeoutMs(),
              }
            );
            const observed = await assertNativeComposeOwned(selection);
            return {
              value: code,
              outcome:
                code === 0 &&
                observed.containers.length === 0 &&
                observed.networks.length === 0
                  ? ("complete" as const)
                  : ("uncertain" as const),
            };
          },
        })
        .catch((error: unknown) => {
          throw finalizationError ?? error;
        });
      if (result.outcome !== "complete") {
        throw new HackCliError({
          code: "E_COMPOSE_FAILED",
          message:
            "Native Compose stop is incomplete; saved ownership and persistent data are retained.",
        });
      }
      if (options.json) {
        emitCliResult({
          result: okResult({
            data: {
              status: "stopped",
              composeProject: generation.identity.composeProject,
              dataRetained: true,
            },
          }),
        });
      }
      return result.value;
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
                pending: state.pending !== null,
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
        return await run([...composeArgs(generation), "ps"], {
          cwd: base.cwd,
          env: base.env,
          forwardSignals: true,
          timeoutMs: 15_000,
        });
      }
      return await runSavedProcess({ options, generation, document, base });
    },
  });
}

/** Retire routes before the stop receipt can forget its recovery generation. */
async function finalizeNativeComposeStop(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly saved: Awaited<ReturnType<typeof savedRouteDocuments>>;
  readonly signal: AbortSignal;
  readonly recover?: boolean;
}): Promise<void> {
  if ((await opts.store.loadCurrent()).beforeHooksPending) {
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

async function runOneOff(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly selection: NativeComposeOwnershipOptions;
  readonly base: RuntimeBaseOptions;
  readonly projection?: NativeComposeRunProjection;
}) {
  const { options, generation, document, selection, base, projection } = opts;
  const service = requireService(document, options.service);
  const name = `${generation.identity.composeProject}-run-${projection?.projectionId ?? randomBytes(16).toString("hex")}`;
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
      stdout: options.json ? "stderr" : "inherit",
    }
  );
  const observed = await assertNativeComposeOwned(selection);
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
  const after = await assertNativeComposeOwned(selection);
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
}) {
  const { options, generation, document, selection, base, routing } = opts;
  const timeout = resolveComposeStartupTimeoutMs();
  const deadline = Date.now() + timeout;
  await routing?.markEffectsPossible();
  const code = await run(
    [
      ...composeArgs(generation),
      "up",
      "-d",
      "--remove-orphans",
      ...(options.operation === "restart" ? ["--force-recreate"] : []),
    ],
    {
      cwd: base.cwd,
      env: base.env,
      stdout: options.json ? "stderr" : "inherit",
      timeoutMs: timeout,
      forwardSignals: true,
    }
  );
  const observed =
    code === 0
      ? await waitReady({
          document,
          ownership: selection,
          deadline,
          generation,
        })
      : null;
  if (observed) {
    await routing?.verifyTransition({ deadline });
  }
  return {
    value: observed ? 0 : code || 1,
    outcome: observed ? ("complete" as const) : ("uncertain" as const),
  };
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
  readonly rendered: ReturnType<typeof renderNativeCompose>;
  readonly inputs: AcquiredComposeInputs;
  readonly previous: SavedRouteDocuments;
  readonly signal: AbortSignal;
}) {
  const {
    options,
    store,
    existingRun,
    generationId,
    rendered,
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
        rendered: rendered.document,
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
          document: rendered.document,
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
    document: savedRun ?? routing?.document ?? rendered.document,
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
  readonly previous: SavedRouteDocuments;
  readonly routing: NativeComposeRoutingOwner | null;
  readonly runRouting: NativeComposeSavedRunRouting | null;
  readonly signal: AbortSignal;
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
    previous,
    routing,
    runRouting,
    signal,
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
  const result = await mutation.runEffect({
    generation,
    operation,
    ...(projection ? { projection } : {}),
    assertFresh: async () => {
      await inputs.assertFresh();
      for (const saved of previous) {
        await store.readGenerationDocument(saved.generation);
      }
    },
    ...(runRouting
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
        })),
    afterHooks: after.afterHooks,
    effect: async () => {
      if (operation === "run") {
        return await runOneOff({
          options,
          generation,
          document,
          selection,
          base,
          projection,
        });
      }
      return await startNativeComposeWorkloads({
        options,
        generation,
        document,
        selection,
        base,
        routing,
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

async function prepareCommand(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const { options, projectRoot, signal } = opts;
  const acquire = () =>
    acquireNativeComposeInputs({
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
    beforeHooksOwned: true,
  });
  const hooks = [
    ...selectNativeComposeBeforeHooks(inputs.result.plan),
    ...selectNativeComposeAfterHooks(inputs.result.plan),
  ];
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
      assertRoutedRunAvailable(
        options,
        current,
        previous,
        inputs.result.plan.routes !== undefined ||
          inputs.result.plan.open !== undefined
      );
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
      const values = await inputs.resolveManagedValues();
      const existingRun =
        options.operation === "run" ? current.generation : null;
      const reservation = existingRun ? null : mutation.reserveGeneration();
      const generationId =
        existingRun?.generationId ?? reservation?.generationId;
      if (!generationId) {
        return invalid();
      }
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
        beforeHooksOwned: true,
      });
      assertRunNetworkSupported({
        options,
        document: rendered.document,
        identity: store.identity,
      });
      const { routing, runRouting, document } = await prepareExecutionRouting({
        options,
        store,
        existingRun,
        generationId,
        rendered,
        inputs,
        previous,
        signal,
      });
      try {
        const generation = await publishPreparedGeneration({
          existing: existingRun,
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
          previous,
          routing,
          runRouting,
          signal,
        });
      } finally {
        await runRouting?.close();
        await routing?.close();
      }
    });
  } finally {
    await store.close();
  }
}

type AcquiredComposeInputs = Awaited<
  ReturnType<typeof acquireNativeComposeInputs>
>;

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
  });
  assertNativeComposeBeforeHookBindings({
    hooks: selectNativeComposeBeforeHooks(inputs.result.plan),
    environmentPlan: inputs.result.environment_plan,
  });
  return { inputs, code: 0 };
}

function hookSelectionIdentity(
  inputs: Awaited<ReturnType<typeof acquireNativeComposeInputs>>
): string {
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
  options: NativeComposeCommandOptions
): Promise<number | null> {
  const adopted = await tryLegacyComposeAdoptedCommand(options);
  if (adopted !== null) {
    return adopted;
  }
  const selected = await selectNativeComposeProject(options);
  if (!selected) {
    return null;
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
    error instanceof NativeComposeOwnershipError
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
  if (
    error instanceof HackCliError ||
    error instanceof CliUsageError ||
    error instanceof NativeConfigCompilerError
  ) {
    throw error;
  }
  throw new HackCliError({
    code: "E_COMPOSE_FAILED",
    message:
      "Native Compose operation failed; saved ownership and persistent data are retained. Values omitted.",
  });
}
