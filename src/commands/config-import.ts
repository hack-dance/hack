import { resolve } from "node:path";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath } from "../cli/options.ts";
import { previewNativeConfigImport } from "../lib/native-config-import-preview.ts";

const spec = defineCommand({
  name: "import",
  summary:
    "Preview a bounded legacy config and Compose conversion without writes",
  group: "Project",
  description:
    "Requires --dry-run. Inspects the exact .hack/hack.config.json and docker-compose.yml pair, reports field mappings/refusals, and validates complete private candidates in memory. Does not export a draft, adopt resources, read keys or change project selection.",
  options: [
    defineOption({
      name: "dryRun",
      type: "boolean",
      long: "--dry-run",
      description: "Preview only; adoption and draft export are unavailable",
    } as const),
    optPath,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

export const configImportCommand = withHandler(spec, async ({ ctx, args }) => {
  if (!args.options.dryRun) {
    throw new CliUsageError(
      "config import requires --dry-run; adoption and draft export are unavailable."
    );
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await previewNativeConfigImport({
      projectRoot: resolve(ctx.cwd, args.options.path ?? "."),
      signal: controller.signal,
    });
    if (args.options.json) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Native import preview ${result.report.complete ? "complete" : "refused"}; no inputs or resources changed.\n`
      );
      for (const field of result.report.fields) {
        process.stdout.write(
          `${field.document} ${JSON.stringify(field.pointer || "/")} (${field.line}:${field.column}): ${field.status} ${field.code}\n`
        );
      }
    }
    return result.report.complete ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
});
