import {
  type CandidateLauncher,
  currentCandidateLauncher,
  launcherCommand,
} from "./candidate-launcher.ts";

/**
 * The native image builder: the pinned build client native `up` runs to build
 * Compose `build:` services. `hack native setup` installs it with the rest of
 * the runtime. A home set up by a build that did not yet install it is still
 * ready for everything except image builds.
 */

/** The runtime's refusal code for a native home that has no image builder. */
export const NATIVE_BUILDER_NOT_PREPARED = "builder_not_prepared";

/** What is wrong, in the same words wherever it is reported. */
export const NATIVE_BUILDER_MISSING =
  "the image builder is not installed in this native home";

/**
 * How to add the image builder to a native home that is already set up, naming
 * the command for this install kind. The same sentence in `hack up`, `hack
 * native setup` and `hack doctor`. Nothing downloads without this consent.
 */
export function nativeBuilderRemedy(
  launcher: CandidateLauncher = currentCandidateLauncher()
): string {
  return `Run ${launcherCommand(launcher, ["native", "setup", "--accept-downloads"])} to add it; offline, add --builder <pinned builder file> to the offline setup inputs.`;
}
