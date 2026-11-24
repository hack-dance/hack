import {
  invokeNativeRuntime,
  resolveNativeSetupSelection,
} from "../backends/native-runtime-client.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

const stores = {
  "directory/artifacts": "Artifacts",
  "directory/run": "Runtime state and VM disks",
  "directory/setup": "Setup",
  shared_hardlinks: "Shared hard links",
} as const;

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidReport(): never {
  throw new HackCliError({
    code: "E_UNEXPECTED",
    message: "Native runtime returned an invalid disk usage report.",
  });
}

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
  const report = await invokeNativeRuntime({
    runtime: resolveNativeSetupSelection(),
    cwd: ctx.cwd,
    args: ["runtime", "disk-usage", "--json"],
    timeoutMs: 15_000,
  });
  if (
    !isRecord(report) ||
    report.scope !== "candidate-state-metadata-only" ||
    !isByteCount(report.total_allocated_file_bytes) ||
    !isByteCount(report.total_logical_file_bytes) ||
    typeof report.complete !== "boolean" ||
    !isRecord(report.categories)
  ) {
    invalidReport();
  }
  const sourceCategories = report.categories;
  const categories = Object.entries(stores).flatMap(([key, label]) => {
    const usage = sourceCategories[key];
    if (usage === undefined) {
      return [];
    }
    if (
      !(
        isRecord(usage) &&
        isByteCount(usage.allocated_file_bytes) &&
        isByteCount(usage.logical_file_bytes)
      )
    ) {
      invalidReport();
    }
    return [
      {
        label,
        allocatedBytes: usage.allocated_file_bytes,
        logicalBytes: usage.logical_file_bytes,
      },
    ];
  });
  const data = {
    scope: "native-home-host-files",
    complete: report.complete,
    allocatedBytes: report.total_allocated_file_bytes,
    logicalBytes: report.total_logical_file_bytes,
    reclaimableBytes: null,
    categories,
  };
  if (args.options.json) {
    emitCliResult({ result: okResult({ data }) });
    return 0;
  }
  for (const entry of [
    { label: "Native home total", ...data },
    ...categories,
  ]) {
    process.stdout.write(
      `${entry.label} · ${entry.allocatedBytes} B allocated · ${entry.logicalBytes} B logical\n`
    );
  }
  if (!data.complete) {
    process.stdout.write("Disk usage scan was incomplete.\n");
  }
  process.stdout.write("Reclaimable bytes: unknown\n");
  return 0;
});
