import { resolve } from "node:path";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  LegacyComposeAdoptedGenerationError,
  openLegacyComposeAdoptedGenerationStore,
} from "../lib/native-compose-adoption-generation.ts";
import { previewLegacyComposeAdoption } from "../lib/native-compose-adoption-preview.ts";

const spec = defineCommand({
  name: "adopt",
  summary: "Explicitly adopt a stopped, verified existing Compose instance",
  group: "Project",
  description:
    "Qualifies a strict static legacy subset with exact existing data volumes. --dry-run reports fields without writes. Adoption journals the stopped format switch and holds original files for rollback; retained-container commands never create replacement data. Requires an upgraded launcher. Linked Git/local inheritance and container recreation remain unsupported.",
  options: [
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
    optPath,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

async function dryRun(
  projectRoot: string,
  signal: AbortSignal,
  json?: boolean
) {
  const report = await previewLegacyComposeAdoption({
    projectRoot,
    signal,
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

async function apply(opts: {
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly rollback?: boolean;
  readonly recover?: boolean;
  readonly json?: boolean;
}) {
  const saved = opts.rollback || opts.recover,
    store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: opts.projectRoot,
      mode: saved ? "saved" : "prepare",
      signal: opts.signal,
    });
  try {
    if (opts.recover) {
      await store.recoverInterruptedLock();
      await store.repairPublication({
        action: opts.rollback ? "rollback" : "complete",
      });
    } else if (opts.rollback) {
      await store.rollback();
    } else {
      const generation = await store.prepare();
      await store.publish({ generation });
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
  if (args.options.dryRun && (args.options.rollback || args.options.recover)) {
    throw new CliUsageError(
      "Use --dry-run separately from --rollback or --recover."
    );
  }
  const projectRoot = resolve(ctx.cwd, args.options.path ?? "."),
    controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (args.options.dryRun) {
      return await dryRun(projectRoot, controller.signal, args.options.json);
    }
    return await apply({
      projectRoot,
      signal: controller.signal,
      rollback: args.options.rollback,
      recover: args.options.recover,
      json: args.options.json,
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
