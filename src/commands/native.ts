import { resolveNativeSetupSelection } from "../backends/native-runtime-client.ts";
import {
  inspectNativeSetup,
  nativeSetupCanResume,
  nativeSetupGuidance,
  previewNativeSetup,
  runNativeSetupChild,
} from "../backends/native-runtime-setup.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { confirmSafe } from "../lib/interactivity.ts";

const setupSpec = defineCommand({
  name: "setup",
  summary: "Download and prepare the pinned native runtime for this home",
  group: "Global",
  description:
    "Verifies and resumes pinned downloads without starting a VM. Requires Apple Silicon macOS. Non-interactive downloads need --accept-downloads. --json passes the runtime result through unchanged.",
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
  ],
  positionals: [],
  subcommands: [],
} as const);

const setup = withHandler(setupSpec, async ({ ctx, args }) => {
  const { archive, engineArchive, networkToolsDirectory } = args.options;
  const hasOffline = [archive, engineArchive, networkToolsDirectory].some(
    (value) => value !== undefined
  );
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
        "Offline setup needs --archive, --engine-archive and --network-tools-directory together, without --accept-downloads.",
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
  if (inspection.state !== "ready") {
    previewNativeSetup({ runtime, inspection });
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
        ]
      : undefined;
  return await runNativeSetupChild({
    runtime,
    cwd: ctx.cwd,
    json: args.options.json === true,
    acceptDownloads: accepted,
    offline,
  });
});

/** Explicit native operations never change the project's Compose backend. */
export const nativeCommand = defineCommand({
  name: "native",
  summary: "Set up the opt-in native runtime",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [setup],
  expandInRootHelp: true,
} as const);
