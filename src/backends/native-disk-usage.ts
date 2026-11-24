import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  resolveNativeSetupSelection,
} from "./native-runtime-client.ts";

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

export async function readNativeDiskUsage(cwd: string) {
  const report = await invokeNativeRuntime({
    runtime: resolveNativeSetupSelection(),
    cwd,
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
  return {
    scope: "native-home-host-files",
    complete: report.complete,
    allocatedBytes: report.total_allocated_file_bytes,
    logicalBytes: report.total_logical_file_bytes,
    reclaimableBytes: null,
    categories,
  };
}

export function describeNativeDiskBytes(usage: {
  readonly allocatedBytes: number;
  readonly logicalBytes: number;
}): string {
  return `${usage.allocatedBytes} B allocated · ${usage.logicalBytes} B logical`;
}
