import { dirname, resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import {
  LegacyComposeAdoptedGenerationError,
  openLegacyComposeAdoptedGenerationStore,
} from "./native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "./native-compose-adoption-marker.ts";
import { inspectLegacyComposeContainerStates } from "./native-compose-adoption-runtime.ts";
import type { NativeComposeCommandOptions } from "./native-compose-command.ts";
import { requireNativeComposeBackend } from "./native-compose-selection.ts";
import { inspectProjectInputsAtRoot } from "./project-input-selection.ts";
import { normalizeProjectName } from "./project-name.ts";
import {
  readProjectsRegistry,
  selectRegisteredProjectByName,
} from "./projects-registry.ts";
import { run } from "./shell.ts";

function unsupported(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Adopted Compose supports retained-container start, restart, stop, ps, logs and exec only. Recreation, run and changed selections are unsupported; original data is retained. Values omitted.",
  });
}
function cancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Adopted Compose operation cancelled; pending ownership is retained. Values omitted.",
    });
  }
}
async function registeredAdoptedRoot(project: string) {
  const name = normalizeProjectName(project);
  if (!name) {
    throw new CliUsageError("Invalid --project value.");
  }
  const registry = await readProjectsRegistry(),
    registered = selectRegisteredProjectByName({
      projects: registry.projects,
      name,
    });
  if (!registered) {
    throw new HackCliError({
      code: "E_PROJECT_NOT_FOUND",
      message: "The selected project is not registered.",
    });
  }
  const state = await inspectLegacyComposeAdoptionSelection({
    projectRoot: registered.repoRoot,
  });
  return state === "active" || state === "pending" ? registered.repoRoot : null;
}

/** Check private adoption ownership before ordinary authored discovery can allocate a fresh native namespace. */
async function adoptedRoot(options: NativeComposeCommandOptions) {
  if (options.path && options.project !== undefined) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }
  if (options.project !== undefined) {
    return await registeredAdoptedRoot(options.project);
  }
  let current = resolve(options.cwd, options.path ?? ".");
  let nearestLegacy = false;
  for (let depth = 0; depth < 64; depth++) {
    const state = await inspectLegacyComposeAdoptionSelection({
      projectRoot: current,
    });
    if (state === "active" || state === "pending") {
      return state === "active" && nearestLegacy ? null : current;
    }
    const inputs = await inspectProjectInputsAtRoot({ projectRoot: current });
    if (
      inputs.kind === "native" ||
      inputs.kind === "conflict" ||
      inputs.composeDirectories.includes(".hack")
    ) {
      return null;
    }
    nearestLegacy ||= inputs.composeDirectories.includes(".dev");
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  unsupported();
}
function validate(options: NativeComposeCommandOptions) {
  if (
    options.instance !== undefined ||
    options.profiles?.length ||
    options.overlay !== undefined ||
    options.unsupportedOptions ||
    options.operation === "run" ||
    (options.operation === "up" && !options.detach) ||
    (options.recover && options.operation !== "down")
  ) {
    unsupported();
  }
  if (
    options.operation === "logs" &&
    options.logFormat &&
    options.logFormat !== "plain"
  ) {
    unsupported();
  }
}

function requestedServices(
  options: NativeComposeCommandOptions
): readonly string[] {
  if (options.service) {
    return [options.service];
  }
  return options.services?.length ? options.services : [];
}
function mutationOperation(
  operation: NativeComposeCommandOptions["operation"]
) {
  switch (operation) {
    case "up":
      return "start";
    case "restart":
      return "restart";
    case "down":
      return "stop";
    default:
      return null;
  }
}
function selectContainers(
  options: NativeComposeCommandOptions,
  binding: LegacyComposeVerifiedBinding
) {
  const requested = requestedServices(options),
    names = binding.containers.map((container) => container.service);
  const selected = requested.length ? requested : names;
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !names.includes(name))
  ) {
    unsupported();
  }
  return binding.containers.filter((container) =>
    selected.includes(container.service)
  );
}
async function logs(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly id: string;
  readonly root: string;
  readonly timeoutMs: number;
}) {
  const { options } = opts;
  if (
    options.tail !== undefined &&
    (!Number.isSafeInteger(options.tail) || options.tail < 0)
  ) {
    unsupported();
  }
  return await run(
    [
      "docker",
      "container",
      "logs",
      ...(options.follow ? ["--follow"] : []),
      ...(options.tail !== undefined ? ["--tail", String(options.tail)] : []),
      opts.id,
    ],
    {
      cwd: opts.root,
      forwardSignals: true,
      timeoutMs: options.follow ? undefined : opts.timeoutMs,
    }
  );
}
async function observe(opts: {
  readonly options: NativeComposeCommandOptions;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) {
  const { options, binding, signal, timeoutMs } = opts;
  cancelled(signal);
  const containers = selectContainers(options, binding);
  if (options.operation === "ps") {
    const states = await inspectLegacyComposeContainerStates({
      binding,
      signal,
    });
    const report = containers.map((container) => ({
      service: container.service,
      status:
        states.find((state) => state.id === container.id)?.status ?? "unknown",
    }));
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ owner: "legacy-compose", services: report })}\n`
        : report.map((entry) => `${entry.service}\t${entry.status}\n`).join("")
    );
    return 0;
  }
  const container = containers[0];
  if (!container || containers.length !== 1) {
    unsupported();
  }
  if (options.operation === "logs") {
    return await logs({
      options,
      id: container.id,
      root: binding.projectRoot,
      timeoutMs,
    });
  }
  if (options.operation !== "exec" || !options.command?.length) {
    unsupported();
  }
  return await run(
    [
      "docker",
      "container",
      "exec",
      "--interactive",
      ...(process.stdin.isTTY ? ["--tty"] : []),
      ...(options.workdir ? ["--workdir", options.workdir] : []),
      container.id,
      ...options.command,
    ],
    { cwd: binding.projectRoot, forwardSignals: true, timeoutMs }
  );
}
/**
 * Retained-ID execution only: no Compose up/down, rm, volume creation or label fabrication.
 * down stops and keeps the original containers as anchors of the existing data.
 * OS cancellation uses the shared runner; uncertain effects retain a pending receipt.
 */
export async function tryLegacyComposeAdoptedCommand(
  input: NativeComposeCommandOptions
): Promise<number | null> {
  const options = {
    ...input,
    services: input.services ? [...input.services] : undefined,
    command: input.command ? [...input.command] : undefined,
    profiles: input.profiles ? [...input.profiles] : undefined,
  };
  const projectRoot = await adoptedRoot(options);
  if (!projectRoot) {
    return null;
  }
  requireNativeComposeBackend({ backend: process.env.HACK_RUNTIME_BACKEND });
  validate(options);
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const signal = controller.signal,
      timeoutMs = resolveComposeStartupTimeoutMs(),
      store = await openLegacyComposeAdoptedGenerationStore({
        projectRoot,
        mode: "saved",
        signal,
      });
    try {
      if (options.recover) {
        await store.recoverInterruptedLock();
      }
      const generation = await store.loadActive({
        recoverOperation: options.recover,
      });
      if (!generation) {
        unsupported();
      }
      const requested = requestedServices(options);
      const operation = mutationOperation(options.operation);
      if (operation) {
        return await store.withMutation({
          generation,
          operation,
          services: requested,
          recover: options.recover,
          run: async (privateInput) => {
            cancelled(signal);
            const containers = selectContainers(options, privateInput.binding);
            return await run(
              [
                "docker",
                "container",
                operation,
                ...containers.map((container) => container.id),
              ],
              {
                cwd: projectRoot,
                stdin: "ignore",
                stdout: "stderr",
                forwardSignals: true,
                timeoutMs,
              }
            );
          },
        });
      }
      return await store.withLease({
        generation,
        run: async (privateInput) =>
          await observe({
            options,
            binding: privateInput.binding,
            signal,
            timeoutMs,
          }),
      });
    } finally {
      await store.close();
    }
  } catch (error: unknown) {
    if (error instanceof HackCliError || error instanceof CliUsageError) {
      throw error;
    }
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        error instanceof LegacyComposeAdoptedGenerationError
          ? error.message
          : "Adopted Compose ownership or execution refused; original data is retained. Values omitted.",
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
