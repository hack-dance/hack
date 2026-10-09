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
import { previewLegacyComposeAdoption } from "../lib/native-compose-adoption-preview.ts";
import { legacyComposeRetainedOrdered } from "../lib/native-compose-adoption-readiness.ts";
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
        if (
          legacyComposeRetainedOrdered(input.retainedPlan) ||
          input.retainedBuild
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
  const saved = opts.rollback || opts.recover,
    store = await openLegacyComposeAdoptedGenerationStore({
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
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        error instanceof LegacyComposeAdoptedGenerationError
          ? error.message
          : "Legacy adoption refused; original data and recovery evidence retained. Values omitted.",
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
});
