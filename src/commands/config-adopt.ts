import { resolve } from "node:path";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "../lib/compose-startup-budget.ts";
import { runLegacyComposeRetainedOperation } from "../lib/native-compose-adoption-execution.ts";
import {
  LegacyComposeAdoptedGenerationError,
  type LegacyComposeAdoptedGenerationStore,
  openLegacyComposeAdoptedGenerationStore,
} from "../lib/native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelectionDetail } from "../lib/native-compose-adoption-marker.ts";
import {
  LEGACY_ADOPTION_LITERAL_ENV_OVERRIDE_CODE,
  legacyAdoptionEnvOverrideHoldsValues,
  previewLegacyComposeAdoption,
} from "../lib/native-compose-adoption-preview.ts";
import { legacyComposePublicationRefusal } from "../lib/native-compose-adoption-publication-diagnostics.ts";
import { legacyComposeRetainedOrdered } from "../lib/native-compose-adoption-readiness.ts";
import { runLegacyComposeRetainedRoutingOperation } from "../lib/native-compose-adoption-routing-execution.ts";
import { requireNativeComposeBackend } from "../lib/native-compose-selection.ts";
import { run } from "../lib/shell.ts";

const spec = defineCommand({
  name: "adopt",
  summary: "Explicitly adopt a stopped, verified existing Compose instance",
  group: "Project",
  description:
    "Qualifies a strict static legacy subset with exact existing data volumes. --dry-run reports fields without writes. Adoption journals the stopped format switch and holds original files for rollback; retained-container commands never create replacement data. Requires an upgraded launcher. Verified linked Git checkouts retain explicit existing identities. Local inheritance, generated overrides and container recreation remain unsupported.",
  options: [
    defineOption({
      name: "stop",
      type: "boolean",
      long: "--stop",
      description:
        "Explicitly journal and stop the exact original containers before adopting; never removes data anchors",
    } as const),
    defineOption({
      name: "dryRun",
      type: "boolean",
      long: "--dry-run",
      description: "Read-only field, compiler and existing-resource preview",
    } as const),
    defineOption({
      name: "rollback",
      type: "boolean",
      long: "--rollback",
      description:
        "Restore the exact held legacy inputs after the original containers are stopped",
    } as const),
    defineOption({
      name: "recover",
      type: "boolean",
      long: "--recover",
      description:
        "Explicitly repair interrupted adoption or rollback using the saved original binding",
    } as const),
    defineOption({
      name: "branch",
      type: "string",
      long: "--branch",
      description: "Select the exact existing branch instance",
    } as const),
    optPath,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

/**
 * Adoption pins the generated env override's bytes and inode for the life of
 * the adoption, so binding a literal file from an earlier version would keep
 * decrypted values on disk (HACK-1273). Fixed text; values omitted.
 */
const LITERAL_ENV_OVERRIDE_REFUSAL =
  "Refused adoption: .hack/.internal/compose.env.override.yml holds literal env values written by an earlier Hack version, and adoption would keep them on disk. Run 'hack up' once so Hack rewrites it with references only, then retry 'hack config adopt'. Values omitted.";

/** The one refusal whose fixed guidance survives the handler's redaction. */
class LiteralEnvOverrideRefusal extends HackCliError {
  constructor() {
    super({ code: "E_CONFIG_INVALID", message: LITERAL_ENV_OVERRIDE_REFUSAL });
    this.name = "LiteralEnvOverrideRefusal";
  }
}

/**
 * Next steps appended to `E_LEGACY_ADOPTION_BUSY` when a publication switch
 * is journaled. That code's own text names only "explicit interrupted-lock
 * recovery", and plain `hack config adopt --recover` completes the switch,
 * which refuses a bound literal override, so the step must name the command
 * this state accepts (HACK-1414). Fixed text; values omitted.
 */
export const PENDING_SWITCH_BUSY_NEXT_STEP =
  "A publication switch is pending. If no other adoption command is running, run 'hack config adopt --recover' to complete it or 'hack config adopt --recover --rollback' to restore the originals.";
export const PENDING_LITERAL_SWITCH_BUSY_NEXT_STEP =
  "A publication switch is pending and the bound .hack/.internal/compose.env.override.yml holds literal env values, so completing it refuses. If no other adoption command is running, run 'hack config adopt --recover --rollback' to release it.";
/**
 * The step for a switch whose rollback is journaled (`rolling-back`): plain
 * `--recover` completes only a `switching` publication and refuses this one,
 * whatever the override holds, so only `--recover --rollback` finishes it
 * (HACK-1427). Fixed text; values omitted.
 */
export const PENDING_ROLLBACK_BUSY_NEXT_STEP =
  "A rollback of the publication switch is pending. If no other adoption command is running, run 'hack config adopt --recover --rollback' to finish restoring the originals.";

/** The fixed next step for a busy refusal over a pending switch. */
function pendingSwitchBusyNextStep(opts: {
  readonly switchPhase: "switching" | "rolling-back" | null;
  readonly literal: boolean;
}): string {
  if (opts.switchPhase === "rolling-back") {
    return PENDING_ROLLBACK_BUSY_NEXT_STEP;
  }
  return opts.literal
    ? PENDING_LITERAL_SWITCH_BUSY_NEXT_STEP
    : PENDING_SWITCH_BUSY_NEXT_STEP;
}

/** The store refusal's fixed message, plus the pending-switch step for BUSY. */
async function adoptionRefusalMessage(opts: {
  readonly error: LegacyComposeAdoptedGenerationError;
  readonly projectRoot: string;
}): Promise<string> {
  if (opts.error.code !== "E_LEGACY_ADOPTION_BUSY") {
    return opts.error.message;
  }
  try {
    const detail = await inspectLegacyComposeAdoptionSelectionDetail({
      projectRoot: opts.projectRoot,
    });
    if (detail?.pending !== "switch") {
      return opts.error.message;
    }
    const literal = await legacyAdoptionEnvOverrideHoldsValues({
      projectRoot: opts.projectRoot,
    });
    return `${opts.error.message} ${pendingSwitchBusyNextStep({
      switchPhase: detail.switchPhase,
      literal,
    })}`;
  } catch {
    // Unreadable state keeps the store's fixed message alone.
    return opts.error.message;
  }
}

async function dryRun(
  projectRoot: string,
  signal: AbortSignal,
  json?: boolean,
  stop?: boolean
) {
  const report = await previewLegacyComposeAdoption({
    projectRoot,
    signal,
    stop,
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Legacy adoption preview ${report.complete ? "complete" : "refused"}; no inputs or resources changed.\n`
    );
    for (const field of report.fields) {
      process.stdout.write(
        `${field.document} ${JSON.stringify(field.pointer || "/")} (${field.line}:${field.column}): ${field.status} ${field.code}\n`
      );
    }
    if (
      report.fields.some(
        (field) => field.code === LEGACY_ADOPTION_LITERAL_ENV_OVERRIDE_CODE
      )
    ) {
      process.stdout.write(`${LITERAL_ENV_OVERRIDE_REFUSAL}\n`);
    }
  }
  return report.complete ? 0 : 1;
}

async function adoptPrepared(
  opts: Parameters<typeof apply>[0],
  store: LegacyComposeAdoptedGenerationStore
): Promise<number> {
  if (opts.recover) {
    await store.recoverInterruptedLock();
  }
  const generation = opts.recover
    ? await store.loadPrepared({ recoverOperation: true })
    : await store.prepare();
  if (!generation) {
    throw new Error(
      "Legacy adoption preparation is unavailable; values omitted."
    );
  }
  if (opts.stop) {
    const deadline = Date.now() + resolveComposeStartupTimeoutMs();
    const code = await store.withPreparationStop({
      generation,
      recover: opts.recover,
      deadline,
      run: async (input) => {
        if (opts.signal.aborted) {
          throw new Error("Legacy adoption cancelled; values omitted.");
        }
        if (input.retainedRouting) {
          return await runLegacyComposeRetainedRoutingOperation({
            input,
            operation: "stop",
            deadline,
            signal: opts.signal,
          });
        }
        if (
          legacyComposeRetainedOrdered(input.retainedPlan) ||
          input.retainedBuild ||
          input.retainedSourceBind
        ) {
          return await runLegacyComposeRetainedOperation({
            input,
            operation: "stop",
            deadline,
            signal: opts.signal,
          });
        }
        return await run(
          [
            "docker",
            "container",
            "stop",
            ...input.binding.containers.map((container) => container.id),
          ],
          {
            cwd: opts.projectRoot,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            timeoutMs: resolveComposeStartupTimeoutMs(),
            forwardSignals: true,
          }
        );
      },
    });
    if (code !== 0) {
      return code;
    }
  }
  await store.publish({ generation });
  return 0;
}

async function apply(opts: {
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly rollback?: boolean;
  readonly recover?: boolean;
  readonly json?: boolean;
  readonly stop?: boolean;
  readonly branch?: string;
}) {
  const saved = opts.rollback || opts.recover;
  // A new preparation would pin a literal override for the life of the
  // adoption. Recovery and rollback act on an existing generation's proof:
  // the store refuses to publish or complete one bound to a literal override
  // (HACK-1318), and only `--recover --rollback` releases it.
  if (
    !saved &&
    (await legacyAdoptionEnvOverrideHoldsValues({
      projectRoot: opts.projectRoot,
    }))
  ) {
    throw new LiteralEnvOverrideRefusal();
  }
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: opts.projectRoot,
    requestedBranch: opts.branch,
    mode: saved ? "saved" : "prepare",
    signal: opts.signal,
  });
  try {
    if (opts.recover && !opts.stop) {
      await store.recoverInterruptedLock();
      await store.repairPublication({
        action: opts.rollback ? "rollback" : "complete",
      });
    } else if (opts.rollback) {
      await store.rollback();
    } else {
      const code = await adoptPrepared(opts, store);
      if (code !== 0) {
        return code;
      }
    }
    const status = opts.rollback ? "rolled-back" : "active";
    const report = {
      adoption_version: 1,
      owner: "legacy-compose",
      status,
      original_data: "retained",
    };
    process.stdout.write(
      opts.json
        ? `${JSON.stringify(report)}\n`
        : `Legacy adoption ${status}; original resource identities and data retained.\n`
    );
    return 0;
  } finally {
    await store.close();
  }
}

export const configAdoptCommand = withHandler(spec, async ({ ctx, args }) => {
  requireNativeComposeBackend({ backend: process.env.HACK_RUNTIME_BACKEND });
  if (args.options.stop && args.options.rollback) {
    throw new CliUsageError("Use --stop separately from --rollback.");
  }
  if (args.options.dryRun && (args.options.rollback || args.options.recover)) {
    throw new CliUsageError(
      "Use --dry-run separately from --rollback or --recover."
    );
  }
  if (args.options.dryRun && args.options.branch !== undefined) {
    throw new CliUsageError(
      "Branch-selected adoption preview is unavailable; omit --dry-run for the saved owner."
    );
  }
  const projectRoot = resolve(ctx.cwd, args.options.path ?? "."),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (args.options.dryRun) {
      return await dryRun(
        projectRoot,
        controller.signal,
        args.options.json,
        args.options.stop
      );
    }
    return await apply({
      projectRoot,
      signal: controller.signal,
      rollback: args.options.rollback,
      recover: args.options.recover,
      json: args.options.json,
      stop: args.options.stop,
      branch: args.options.branch,
    });
  } catch (error: unknown) {
    if (error instanceof LiteralEnvOverrideRefusal) {
      throw error;
    }
    const diagnostic = legacyComposePublicationRefusal(error);
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        error instanceof LegacyComposeAdoptedGenerationError
          ? await adoptionRefusalMessage({ error, projectRoot })
          : "Legacy adoption refused; original data and recovery evidence retained. Values omitted.",
      ...(diagnostic
        ? { detail: { legacy_adoption_publication_refusal: diagnostic } }
        : {}),
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
});
