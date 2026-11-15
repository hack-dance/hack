import { resolve } from "node:path";
import { detectHackInstall, type HackInstallState } from "./self-update.ts";

type PresentInstall = Extract<HackInstallState, { status: "present" }>;

/** Local identity of this running CLI, without PATH discovery or runtime probes. */
export async function buildVersionReport(opts: {
  readonly version: string;
  readonly executable: string;
  readonly compiled: boolean;
}): Promise<{
  readonly version: string;
  readonly channel: "stable" | "next" | "prerelease";
  readonly install_kind: PresentInstall["kind"] | "source" | "unknown";
  readonly binary_path: string;
}> {
  const binaryPath = resolve(opts.executable);
  const install = opts.compiled
    ? await detectHackInstall({ path: binaryPath })
    : null;
  let channel: "stable" | "next" | "prerelease" = "stable";
  if (opts.version.includes("-next.")) {
    channel = "next";
  } else if (opts.version.includes("-")) {
    channel = "prerelease";
  }
  const installKind = install?.status === "present" ? install.kind : "unknown";
  return {
    version: opts.version,
    channel,
    install_kind: opts.compiled ? installKind : "source",
    binary_path: binaryPath,
  };
}
