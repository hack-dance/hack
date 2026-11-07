import type { NativePlatformMode } from "../backends/native-project-platform.ts";

/** Doctor check id for native `linux/amd64` emulation. */
export const AMD64_EMULATION_CHECK = "amd64 emulation";

/** Value-free JSON payload: counts only, never service names or image references. */
export type Amd64EmulationReport = {
  /** Services that always run `linux/amd64` under emulation (`amd64`). */
  readonly amd64: number;
  /** Services emulated only when their image publishes no arm64 variant. */
  readonly preferNative: number;
  /** Whether the host provides the Rosetta 2 Linux runtime. */
  readonly hostRosetta: boolean;
};

/**
 * Doctor result for the native `amd64Emulation` selection. Messages are value-free
 * like the Compose-backend report: they never repeat an authored platform string.
 * Emulation is always a warning: emulated services are slower and can behave
 * differently from arm64 builds.
 * A missing Rosetta 2 runtime is a warning that names the fix, because native up
 * refuses opted-in services on that host before any VM effect.
 */
export function amd64EmulationCheckResult(opts: {
  readonly modes: ReadonlyMap<string, NativePlatformMode>;
  readonly hostRosetta: boolean;
}): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly amd64Emulation: Amd64EmulationReport;
} {
  const modes = [...opts.modes.values()];
  const report = {
    amd64: modes.filter((mode) => mode === "amd64").length,
    preferNative: modes.filter((mode) => mode === "prefer-native").length,
    hostRosetta: opts.hostRosetta,
  };
  const total = report.amd64 + report.preferNative;
  if (total === 0) {
    return {
      name: AMD64_EMULATION_CHECK,
      status: "ok",
      message:
        "No service opts in to amd64 (x86_64) emulation; native services run Linux arm64.",
      amd64Emulation: report,
    };
  }
  const services = total === 1 ? "1 service opts" : `${total} services opt`;
  const scope = `${services} in to amd64 (x86_64) emulation (${report.amd64} always, ${report.preferNative} only when the image has no arm64 variant)`;
  if (!opts.hostRosetta) {
    return {
      name: AMD64_EMULATION_CHECK,
      status: "warn",
      message: `${scope}, but Rosetta 2 is not installed, so native up refuses them. Install it with \`softwareupdate --install-rosetta\` on an Apple silicon Mac, or remove the amd64Emulation selection to use arm64 images.`,
      amd64Emulation: report,
    };
  }
  return {
    name: AMD64_EMULATION_CHECK,
    status: "warn",
    message: `${scope}. They run under Rosetta 2 in the native VM, which is slower and can differ from arm64 builds; prefer images that publish an arm64 variant.`,
    amd64Emulation: report,
  };
}
