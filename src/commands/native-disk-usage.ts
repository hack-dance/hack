import {
  describeNativeDiskBytes,
  readNativeDiskUsage,
} from "../backends/native-disk-usage.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";

const spec = defineCommand({
  name: "disk-usage",
  summary: "Show host disk usage for the selected native home",
  description:
    "Report allocated and logical file bytes without starting the pool. The scan can be incomplete. Guest usage and reclaimable bytes are unavailable in this view.",
  group: "Global",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

export const nativeDiskUsage = withHandler(spec, async ({ ctx, args }) => {
  const data = await readNativeDiskUsage(ctx.cwd);
  if (args.options.json) {
    emitCliResult({ result: okResult({ data }) });
    return 0;
  }
  for (const entry of [
    { label: "Native home total", ...data },
    ...data.categories,
  ]) {
    process.stdout.write(
      `${entry.label} · ${describeNativeDiskBytes(entry)}\n`
    );
  }
  if (!data.complete) {
    process.stdout.write("Disk usage scan was incomplete.\n");
  }
  process.stdout.write("Reclaimable bytes: unknown\n");
  return 0;
});
