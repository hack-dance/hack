import { basename } from "node:path";
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

/** A builder that is there but is not the pinned release, in the same words everywhere. */
export const NATIVE_BUILDER_CHANGED =
  "the image builder in this native home does not match the pinned release";

/**
 * How a printed command names the launcher.
 *
 * - `path`: as every other printed command does (`launcherCommand`): `hack`
 *   for a stable install, the launcher's full path for a candidate install,
 *   because that launcher is not on PATH. By default that path is under the
 *   user's home, so it shows the home directory.
 * - `name`: the launcher's base name only (`hack`, `hack-next`, `hack-v5`).
 *   For text that is stored or passed on, such as doctor's check detail and
 *   its JSON, which must not carry a home path or a user name.
 */
export type NativeBuilderCommandStyle = "path" | "name";

/** The image builder's prepared directory and record, as paths under the native home. */
export type NativeBuilderPaths = {
  readonly directory: string;
  readonly record: string;
};

/** `native setup --accept-downloads`, the one command that downloads the builder. */
function setupWithConsent(
  launcher: CandidateLauncher,
  style: NativeBuilderCommandStyle
): string {
  return launcherCommand(
    style === "name"
      ? { kind: "bundle", command: basename(launcher.command) }
      : launcher,
    ["native", "setup", "--accept-downloads"]
  );
}

/**
 * How to add the image builder to a native home that is already set up, naming
 * the command for this install kind. The same sentence in `hack up`, `hack
 * native setup` and `hack doctor`. Nothing downloads without this consent.
 */
export function nativeBuilderRemedy(
  launcher: CandidateLauncher = currentCandidateLauncher(),
  style: NativeBuilderCommandStyle = "path"
): string {
  return `Run ${setupWithConsent(launcher, style)} to add it; offline, add --builder <pinned builder file> to the offline setup inputs.`;
}

/**
 * How to replace an image builder that does not match the pinned release.
 * Setup never deletes or overwrites it, so the user removes its directory and
 * record, named by their paths under the native home, and then runs setup
 * with download consent. Without the paths (a runtime that did not report
 * them) the sentence names where they are.
 */
export function nativeBuilderChangedRemedy(opts: {
  readonly paths?: NativeBuilderPaths;
  readonly launcher?: CandidateLauncher;
  readonly style?: NativeBuilderCommandStyle;
}): string {
  const remove = opts.paths
    ? `Remove ${opts.paths.directory} and ${opts.paths.record} from the native home`
    : "Remove the image builder's directory and record from .hack-local/providers in the native home";
  return `${remove}, then run ${setupWithConsent(opts.launcher ?? currentCandidateLauncher(), opts.style ?? "path")}.`;
}
