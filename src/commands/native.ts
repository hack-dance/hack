import { nativePlatformRefusal } from "../backends/native-beta.ts";
import {
  invokeNativeRuntime,
  resolveNativeSetupSelection,
} from "../backends/native-runtime-client.ts";
import {
  inspectNativeSetup,
  nativeSetupCanResume,
  nativeSetupGuidance,
  nativeSetupLacksBuilder,
  previewNativeSetup,
  runNativeSetupChild,
} from "../backends/native-runtime-setup.ts";
import { inspectTempAliases } from "../backends/native-temp-aliases.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { confirmSafe } from "../lib/interactivity.ts";
import { nativeDiskUsage } from "./native-disk-usage.ts";

const setupSpec = defineCommand({
  name: "setup",
  summary: "Download and prepare the pinned native runtime for this home",
  group: "Global",
  description:
    "Verifies and resumes pinned downloads without starting a VM: the VM provider, the engine, the guest networking packages and the image builder. Requires Apple Silicon macOS. Non-interactive downloads need --accept-downloads. A home that is already set up is left as it is; with --accept-downloads it gains the image builder if it has none. --json passes the runtime result through unchanged.",
  options: [
    optJson,
    defineOption({
      name: "acceptDownloads",
      type: "boolean",
      long: "--accept-downloads",
      description: "Consent to the displayed pinned downloads",
    } as const),
    defineOption({
      name: "archive",
      type: "string",
      long: "--archive",
      valueHint: "<path>",
      description:
        "Offline pinned provider archive (requires the complete offline input set)",
    } as const),
    defineOption({
      name: "engineArchive",
      type: "string",
      long: "--engine-archive",
      valueHint: "<path>",
      description: "Offline pinned engine archive",
    } as const),
    defineOption({
      name: "networkToolsDirectory",
      type: "string",
      long: "--network-tools-directory",
      valueHint: "<path>",
      description:
        "Private directory containing all pinned networking packages",
    } as const),
    defineOption({
      name: "builder",
      type: "string",
      long: "--builder",
      valueHint: "<path>",
      description:
        "Offline pinned image builder file (optional; with the offline input set)",
    } as const),
  ],
  positionals: [],
  subcommands: [],
} as const);

const setup = withHandler(setupSpec, async ({ ctx, args }) => {
  const platformRefusal = nativePlatformRefusal({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  });
  if (platformRefusal !== null) {
    throw new HackCliError({
      code: "E_UNSUPPORTED_PLATFORM",
      message: platformRefusal,
      detail: { platform: process.platform, arch: process.arch },
    });
  }
  const { archive, engineArchive, networkToolsDirectory, builder } =
    args.options;
  const hasOffline = [
    archive,
    engineArchive,
    networkToolsDirectory,
    builder,
  ].some((value) => value !== undefined);
  if (
    hasOffline &&
    !(
      archive &&
      engineArchive &&
      networkToolsDirectory &&
      !args.options.acceptDownloads
    )
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "Offline setup needs --archive, --engine-archive and --network-tools-directory together, without --accept-downloads; --builder adds the pinned image builder file to them.",
    });
  }
  const runtime = resolveNativeSetupSelection();
  const inspection = await inspectNativeSetup({ runtime, cwd: ctx.cwd });
  if (!(inspection.state === "ready" || nativeSetupCanResume(inspection))) {
    throw new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: nativeSetupGuidance(inspection),
      detail: { runtime_setup: inspection.state, native_code: inspection.code },
    });
  }
  // A set-up home is never downloaded to again, except for an image builder it
  // lacks, and that only on the consent given with --accept-downloads.
  const lacksBuilder = nativeSetupLacksBuilder(inspection);
  if (inspection.state !== "ready") {
    previewNativeSetup({ runtime, inspection });
  } else if (
    lacksBuilder &&
    inspection.builder &&
    args.options.acceptDownloads
  ) {
    previewNativeSetup({
      runtime,
      inspection,
      pins: [inspection.builder.pin],
    });
  }
  let accepted = args.options.acceptDownloads === true;
  if (
    !hasOffline &&
    inspection.state !== "ready" &&
    !args.options.acceptDownloads
  ) {
    // JSON never prompts: its stdout must remain the runtime's JSON alone.
    if (args.options.json) {
      throw new HackCliError({
        code: "E_INTERACTIVE_REQUIRED",
        message:
          "Native setup needs download consent; pass --accept-downloads.",
      });
    }
    accepted = await confirmSafe({
      message: "Download and prepare these pinned files?",
      initialValue: false,
      nonInteractive: "fail",
      hint: "Pass --accept-downloads.",
    });
    if (!accepted) {
      process.stderr.write(
        "Pinned downloads declined; no files downloaded or installed.\n"
      );
      return 1;
    }
  }
  const offline =
    archive && engineArchive && networkToolsDirectory
      ? [
          "--archive",
          archive,
          "--engine-archive",
          engineArchive,
          "--network-tools-directory",
          networkToolsDirectory,
          ...(builder ? ["--builder", builder] : []),
        ]
      : undefined;
  return await runNativeSetupChild({
    runtime,
    cwd: ctx.cwd,
    json: args.options.json === true,
    acceptDownloads: accepted,
    offline,
    // For the summary's notice when the run leaves the home without the image
    // builder, or with one that does not match the pinned release.
    builder: inspection.builder?.paths,
  });
});

const recoverSpec = defineCommand({
  name: "recover",
  summary:
    "Recover this home's native runtime after an interrupted or failed start",
  group: "Global",
  description:
    "Runs the runtime's own recovery for this native home: it proves what a failed or interrupted start left behind, records the stopped state, and then a normal hack up starts again. It never adopts or deletes data it cannot prove. --json passes the runtime result through unchanged.",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

/** Recovery can stop a silent provider and wait for its disks to close. */
const RECOVER_TIMEOUT_MS = 300_000;

const recover = withHandler(recoverSpec, async ({ ctx, args }) => {
  const platformRefusal = nativePlatformRefusal({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  });
  if (platformRefusal !== null) {
    throw new HackCliError({
      code: "E_UNSUPPORTED_PLATFORM",
      message: platformRefusal,
      detail: { platform: process.platform, arch: process.arch },
    });
  }
  return await runNativeRecover({
    runtime: resolveNativeSetupSelection(),
    cwd: ctx.cwd,
    json: args.options.json === true,
    invoke: invokeNativeRuntime,
    write: (text) => process.stdout.write(text),
  });
});

/** `hack native recover`: the runtime's recovery, and a line saying what it left. */
export async function runNativeRecover(opts: {
  readonly runtime: Parameters<typeof invokeNativeRuntime>[0]["runtime"];
  readonly cwd: string;
  readonly json: boolean;
  readonly invoke: typeof invokeNativeRuntime;
  readonly write: (text: string) => void;
}): Promise<number> {
  // Read-only and best-effort, to say afterwards whether recovery changed anything. A
  // home recovery is for may refuse status (a missing provider HOME, for example); that
  // never stops the recovery itself.
  const before = opts.json
    ? undefined
    : await opts
        .invoke({
          runtime: opts.runtime,
          cwd: opts.cwd,
          args: ["runtime", "status", "--json"],
          timeoutMs: 60_000,
        })
        .then(phaseOf, () => undefined);
  const result = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.cwd,
    args: ["runtime", "recover", "--json"],
    timeoutMs: RECOVER_TIMEOUT_MS,
  });
  if (opts.json) {
    opts.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const phase = phaseOf(result) ?? "unknown";
  if (phase === "uninitialized") {
    opts.write("Native runtime has nothing to recover in this home.\n");
  } else if (before === phase && STOPPED_PHASES.has(phase)) {
    opts.write(
      `Native runtime has nothing to recover; its state is ${phase}. Run hack up to start.\n`
    );
  } else {
    opts.write(
      `Native runtime recovered; its state is now ${phase}. Run hack up to start again.\n`
    );
  }
  return 0;
}

/** Stopped states recovery leaves unchanged (the runtime's own stopped phases). */
const STOPPED_PHASES = new Set([
  "stopped",
  "stopped-before-engine",
  "stopped-after-engine-failure",
  "recovered-unclean",
]);

function phaseOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.phase === "string"
    ? value.phase
    : undefined;
}

const tempAliasesSpec = defineCommand({
  name: "temp-aliases",
  summary: "List dangling native provider HOME aliases",
  description:
    "List old aliases whose native home is gone, or remove them with --fix.",
  group: "Global",
  options: [
    optJson,
    defineOption({
      name: "fix",
      type: "boolean",
      long: "--fix",
      description: "Remove verified dangling aliases",
    } as const),
    defineOption({
      name: "includeUnverifiedVolumes",
      type: "boolean",
      long: "--include-unverified-volumes",
      description: "With --fix, include aliases whose volume may be unmounted",
    } as const),
  ],
  positionals: [],
  subcommands: [],
} as const);

const tempAliases = withHandler(tempAliasesSpec, async ({ ctx, args }) => {
  if (args.options.includeUnverifiedVolumes && !args.options.fix) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "--include-unverified-volumes requires --fix.",
    });
  }
  const report = await inspectTempAliases({
    runtime: resolveNativeSetupSelection(),
    cwd: ctx.cwd,
    fix: args.options.fix === true,
    includeUnverifiedVolumes: args.options.includeUnverifiedVolumes === true,
  });
  if (args.options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }
  for (const name of report.dangling) {
    process.stdout.write(
      `${report.removed.includes(name) ? "Removed" : "Dangling"} ${name}\n`
    );
  }
  for (const name of report.uncertainVolume) {
    process.stdout.write(
      report.removed.includes(name)
        ? `Removed ${name}\n`
        : `Cannot tell for ${name} (volume not mounted, or home deleted).\n`
    );
  }
  if (report.incomplete) {
    process.stdout.write("Temporary alias scan was incomplete.\n");
  } else if (report.dangling.length + report.uncertainVolume.length === 0) {
    process.stdout.write("No old dangling provider HOME aliases found.\n");
  }
  return 0;
});

/** Explicit native operations never change the project's Compose backend. */
export const nativeCommand = defineCommand({
  name: "native",
  summary: "Set up or recover the opt-in native runtime",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [setup, recover, tempAliases, nativeDiskUsage],
  expandInRootHelp: true,
} as const);
