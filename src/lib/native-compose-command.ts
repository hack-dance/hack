import { randomBytes } from "node:crypto";
import type { LogOutputFormat } from "../backends/log-backend.ts";
import type { RuntimeBaseOptions } from "../backends/runtime-backend.ts";
import { CliUsageError } from "../cli/command.ts";
import { emitCliResult, HackCliError, okResult } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import { isRecord } from "./guards.ts";
import {
  nativeComposeCompletedOneoff,
  nativeComposeRunDependenciesReady,
  nativeComposeWorkloadsReady as ready,
} from "./native-compose-completion.ts";
import {
  type NativeComposeGeneration,
  NativeComposeGenerationError,
  type NativeComposeGenerationStore,
  openNativeComposeGenerationStore,
} from "./native-compose-generation.ts";
import { acquireNativeComposeInputs } from "./native-compose-inputs.ts";
import {
  assertNativeComposeOwned,
  NativeComposeOwnershipError,
  type NativeComposeOwnershipObservation,
  type NativeComposeOwnershipOptions,
} from "./native-compose-ownership.ts";
import {
  assertNativeComposeSupported,
  NativeComposeRenderError,
  renderNativeCompose,
} from "./native-compose-renderer.ts";
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
function networkSelection(document: PrivateDocument): string {
  if (!(isRecord(document.networks) && isRecord(document.networks.default))) {
    return invalid();
  }
  const name = document.networks.default.name;
  return typeof name === "string" ? name : invalid();
}

/** Only a verified private document may select engine resources. */
async function ownershipSelection(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly signal: AbortSignal;
}): Promise<NativeComposeOwnershipOptions> {
  const state = await opts.store.loadCurrent();
  const pending = await opts.store.loadPending();
  const generations = [opts.generation, state.generation, pending].filter(
    (value): value is NativeComposeGeneration => value !== null
  );
  const documents = [opts.document];
  for (const generation of generations) {
    if (generation.generationId !== opts.generation.generationId) {
      documents.push(await opts.store.readGenerationDocument(generation));
    }
  }
  const services = new Set<string>();
  const volumes = new Map<string, { storage: string; name: string }>();
  let network: string | undefined;
  for (const document of documents) {
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
    const selectedNetwork = networkSelection(document);
    if (network !== undefined && network !== selectedNetwork) {
      return invalid();
    }
    network = selectedNetwork;
  }
  return {
    composeProject: opts.store.identity.composeProject,
    runtimeIdentity: opts.store.identity.composeProject,
    ownerToken: opts.store.identity.ownerToken,
    generationIds: [...new Set(generations.map((value) => value.generationId))],
    expectedServices: [...services],
    expectedVolumes: [...volumes.values()],
    expectedNetwork: network,
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
function composeArgs(generation: NativeComposeGeneration): string[] {
  return [
    "docker",
    "compose",
    "-p",
    generation.identity.composeProject,
    "-f",
    generation.composeFile,
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
      : (state.generation ?? (options.operation === "ps" ? pending : null));
  if (!generation) {
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
  });
  const base = {
    ...runtimeOptions(generation),
    routeStdoutToStderr: options.json === true,
  };
  if (options.operation === "down") {
    return await store.withMutation(async (mutation) => {
      const result = await mutation.runEffect({
        generation,
        operation: "down",
        recoverPending: options.recover === true && pending !== null,
        assertOwned: async () => {
          await assertNativeComposeOwned(selection);
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
      const observed = await assertNativeComposeOwned(selection);
      if (options.operation === "ps") {
        if (options.json) {
          emitCliResult({
            result: okResult({
              data: {
                composeProject: generation.identity.composeProject,
                stopped: state.stopped,
                pending: state.pending !== null,
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

async function runOneOff(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly generation: NativeComposeGeneration;
  readonly document: PrivateDocument;
  readonly selection: NativeComposeOwnershipOptions;
  readonly base: RuntimeBaseOptions;
}) {
  const { options, generation, document, selection, base } = opts;
  const service = requireService(document, options.service);
  const name = `${generation.identity.composeProject}-run-${randomBytes(16).toString("hex")}`;
  const code = await run(
    [
      ...composeArgs(generation),
      "run",
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

async function prepareCommand(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const { options, projectRoot, signal } = opts;
  const inputs = await acquireNativeComposeInputs({
    projectRoot,
    profiles: options.profiles,
    explicitOverlay: options.overlay,
    signal,
  });
  if (Object.keys(inputs.result.environment_plan.workloads).length === 0) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "The selected native Compose profile has no workloads to execute.",
    });
  }
  assertNativeComposeSupported({
    plan: inputs.result.plan,
    environmentPlan: inputs.result.environment_plan,
    projectRoot,
    runtimeIdentity: "native-preflight",
    generationIdentity: "0".repeat(32),
    ownerToken: "0".repeat(32),
  });
  const values = await inputs.resolveManagedValues();
  const store = await openNativeComposeGenerationStore({
    projectRoot,
    instance: options.instance ?? null,
    mode: "prepare",
  });
  try {
    return await store.withMutation(async (mutation) => {
      const current = await store.loadCurrent();
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
      });
      let generation: NativeComposeGeneration;
      if (existingRun) {
        const saved = await store.readGenerationDocument(existingRun);
        if (JSON.stringify(saved) !== JSON.stringify(rendered.document)) {
          throw new HackCliError({
            code: "E_CONFIG_INVALID",
            message:
              "Native Compose inputs differ from the running generation. Run hack up or restart before a one-off command. Values omitted.",
          });
        }
        generation = existingRun;
      } else {
        if (!reservation) {
          return invalid();
        }
        generation = await mutation.publish({
          reservation,
          composeJson: rendered.json,
          profiles: rendered.profiles,
          inputRevision: inputs.inputRevision,
          assertFresh: inputs.assertFresh,
        });
      }
      const selection = await ownershipSelection({
        store,
        generation,
        document: rendered.document,
        signal,
      });
      const base = {
        ...runtimeOptions(generation),
        routeStdoutToStderr: options.json === true,
      };
      const operation = options.operation;
      if (
        operation !== "up" &&
        operation !== "restart" &&
        operation !== "run"
      ) {
        return invalid();
      }
      const result = await mutation.runEffect({
        generation,
        operation,
        assertFresh: inputs.assertFresh,
        assertOwned: async () => {
          await assertNativeComposeOwned(selection);
        },
        effect: async () => {
          if (operation === "run") {
            return await runOneOff({
              options,
              generation,
              document: rendered.document,
              selection,
              base,
            });
          }
          const timeout = resolveComposeStartupTimeoutMs();
          const deadline = Date.now() + timeout;
          const code = await run(
            [
              ...composeArgs(generation),
              "up",
              "-d",
              ...(operation === "restart" ? ["--force-recreate"] : []),
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
                  document: rendered.document,
                  ownership: selection,
                  deadline,
                  generation,
                })
              : null;
          return {
            value: observed ? 0 : code || 1,
            outcome: observed ? ("complete" as const) : ("uncertain" as const),
          };
        },
      });
      if (result.outcome === "uncertain") {
        throw new HackCliError({
          code: "E_STARTUP_INCOMPLETE",
          message:
            "Native Compose execution is incomplete; inspect saved state and use explicit owned stop recovery before retrying.",
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
    });
  } finally {
    await store.close();
  }
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
      "This native Compose slice requires whole-project detached startup and refuses unsupported lifecycle, pruning, routing or log options."
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
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
