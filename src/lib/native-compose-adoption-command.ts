import { dirname, resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import { parseProjectSelectorOption } from "../cli/project-selector.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import { legacyComposeOrderedRefusal } from "./native-compose-adoption-diagnostics.ts";
import { runLegacyComposeRetainedOperation } from "./native-compose-adoption-execution.ts";
import {
  LegacyComposeAdoptedGenerationError,
  legacyAdoptionProbePhaseMs,
  openLegacyComposeAdoptedGenerationStore,
} from "./native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "./native-compose-adoption-marker.ts";
import { legacyComposeRetainedOrdered } from "./native-compose-adoption-readiness.ts";
import { runLegacyComposeRetainedRoutingOperation } from "./native-compose-adoption-routing-execution.ts";
import { inspectLegacyComposeContainerStates } from "./native-compose-adoption-runtime.ts";
import type { NativeComposeCommandOptions } from "./native-compose-command.ts";
import { requireNativeComposeBackend } from "./native-compose-selection.ts";
import { inspectProjectInputsAtRoot } from "./project-input-selection.ts";
import {
  readProjectsRegistry,
  selectRegisteredProjectByName,
} from "./projects-registry.ts";
import { run } from "./shell.ts";

/**
 * Fixed, value-free messages an adopted command ends with when it cancels or
 * rewraps an unexpected refusal as `E_CONFIG_INVALID`. Diagnostics map these
 * exact strings to closed tokens, so they import them instead of copying them
 * (HACK-1432).
 */
export const LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES = Object.freeze({
  refused:
    "Adopted Compose ownership or execution refused; original data is retained. Values omitted.",
  cancelled:
    "Adopted Compose operation cancelled; pending ownership is retained. Values omitted.",
});

function unsupported(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Adopted Compose supports retained-container start, restart, stop, ps, logs and exec only. Recreation, run and changed selections are unsupported; original data is retained. Values omitted.",
  });
}
/**
 * Closed public refusal of an adopted command. A caller-deadline expiry is a
 * timeout, not a config fault (HACK-1458); the fixed store message is kept
 * for closed diagnostics.
 */
function throwAdoptedCommandRefusal(error: unknown): never {
  if (error instanceof HackCliError || error instanceof CliUsageError) {
    throw error;
  }
  const ordered = legacyComposeOrderedRefusal(error);
  throw new HackCliError({
    code:
      error instanceof LegacyComposeAdoptedGenerationError &&
      error.code === "E_LEGACY_ADOPTION_DEADLINE"
        ? "E_STARTUP_TIMEOUT"
        : "E_CONFIG_INVALID",
    message:
      error instanceof LegacyComposeAdoptedGenerationError
        ? error.message
        : LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES.refused,
    ...(ordered ? { detail: { legacy_adoption_refusal: ordered } } : {}),
  });
}
/** Time left before the command deadline; an expired deadline refuses as one. */
function remainingMs(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) {
    throw new LegacyComposeAdoptedGenerationError("E_LEGACY_ADOPTION_DEADLINE");
  }
  return remaining;
}
function cancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES.cancelled,
    });
  }
}
async function registeredAdoptedRoot(project: string) {
  const { name } = parseProjectSelectorOption({ projectOpt: project });
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

/**
 * Check private adoption ownership before ordinary authored discovery can
 * allocate a fresh native namespace. Returns the adopted project root, or null
 * when there is no active or pending adoption on the way to the nearest
 * project root or the filesystem root. Unsafe adoption state throws the
 * marker's closed, value-free refusal (`E_CONFIG_INVALID`).
 *
 * Invariant: this walk covers every ancestor that ordinary discovery
 * (`discoverProjectInputs`) covers. That discovery reads an active adoption as
 * native input, so an adoption this walk missed would reach the native
 * authored path. The walk is therefore unbounded, like that discovery: it
 * ends at a project root or the filesystem root, since `dirname` of an
 * absolute path always reaches `/`. It once stopped after 64 directories and
 * then refused every command, even with no project at all, as an unsupported
 * adopted command (HACK-1380).
 */
export async function selectLegacyComposeAdoptedRoot(
  options: Pick<NativeComposeCommandOptions, "cwd" | "path" | "project">
): Promise<string | null> {
  if (options.path && options.project !== undefined) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }
  if (options.project !== undefined) {
    return await registeredAdoptedRoot(options.project);
  }
  let current = resolve(options.cwd, options.path ?? ".");
  let nearestLegacy = false;
  while (true) {
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
}
function validate(options: NativeComposeCommandOptions) {
  if (
    (options.project !== undefined && options.instance !== undefined) ||
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
  readonly deadline: number;
}) {
  const { options, binding, signal, timeoutMs } = opts;
  cancelled(signal);
  const containers = selectContainers(options, binding);
  if (options.operation === "ps") {
    const states = await inspectLegacyComposeContainerStates({
      binding,
      signal,
      timeoutMs: legacyAdoptionProbePhaseMs({
        deadline: opts.deadline,
        now: Date.now(),
      }),
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
  const projectRoot = await selectLegacyComposeAdoptedRoot(options);
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
    // One caller deadline spans the whole command: store inspection, the
    // retained operation and its final proof (HACK-1458).
    const signal = controller.signal,
      timeoutMs = resolveComposeStartupTimeoutMs(),
      deadline = Date.now() + timeoutMs,
      store = await openLegacyComposeAdoptedGenerationStore({
        projectRoot,
        requestedBranch: options.instance,
        mode: "saved",
        signal,
        deadline,
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
          deadline,
          run: async (privateInput) => {
            cancelled(signal);
            if (privateInput.retainedRouting) {
              return await runLegacyComposeRetainedRoutingOperation({
                input: privateInput,
                operation,
                deadline,
                signal,
              });
            }
            if (
              legacyComposeRetainedOrdered(privateInput.retainedPlan) ||
              privateInput.retainedBuild ||
              privateInput.retainedSourceBind
            ) {
              return await runLegacyComposeRetainedOperation({
                input: privateInput,
                operation,
                deadline,
                signal,
              });
            }
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
                stdout: "ignore",
                stderr: "ignore",
                forwardSignals: true,
                timeoutMs: remainingMs(deadline),
              }
            );
          },
        });
      }
      return await store.withLease({
        generation,
        material: options.operation === "exec" ? "verify" : "saved",
        run: async (privateInput) =>
          await observe({
            options,
            binding: privateInput.binding,
            signal,
            timeoutMs,
            deadline,
          }),
      });
    } finally {
      await store.close();
    }
  } catch (error: unknown) {
    throwAdoptedCommandRefusal(error);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
