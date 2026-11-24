import {
  type CandidateLauncher,
  currentCandidateLauncher,
  homeRelativeLauncherCommand,
} from "./candidate-launcher.ts";

/**
 * The native image builder: the pinned build client native `up` runs to build
 * Compose `build:` services. `hack native setup` installs it with the rest of
 * the runtime. A home set up by a build that did not yet install it is still
 * ready for everything except image builds.
 *
 * Every message about it names the setup command the same way
 * (`homeRelativeLauncherCommand`): `hack` for a stable install, and for a
 * candidate launcher under the user's home `~/<path>`, which a shell runs as
 * pasted and which shows neither the home directory nor the user name. So
 * the `hack up` refusal, the `hack native setup` hint and warning, and
 * doctor's check message and JSON `detail` all print one command.
 */

/** The runtime's refusal code for a native home that has no image builder. */
export const NATIVE_BUILDER_NOT_PREPARED = "builder_not_prepared";

/** Recovery for a Dockerfile that explicitly copies an excluded Hack file. */
export const NATIVE_BUILD_COPY_PRIVATE_RECOVERY =
  "Remove COPY sources that explicitly name Hack's machine-local files or directories from the Dockerfile, then retry hack up.";

/** What is wrong, in the same words wherever it is reported. */
export const NATIVE_BUILDER_MISSING =
  "the image builder is not installed in this native home";

/** A builder that is there but is not the pinned release, in the same words everywhere. */
export const NATIVE_BUILDER_CHANGED =
  "the image builder in this native home does not match the pinned release";

/** The image builder's prepared directory and record, as paths under the native home. */
export type NativeBuilderPaths = {
  readonly directory: string;
  readonly record: string;
};

/** Who runs the command, and from which home; both default to this process. */
export type NativeBuilderCommandOptions = {
  readonly launcher?: CandidateLauncher;
  /** The user's home directory (default: `os.homedir()`). */
  readonly homeDir?: string;
};

/** `native setup --accept-downloads`, the one command that downloads the builder. */
export function nativeBuilderSetupCommand(
  opts: NativeBuilderCommandOptions = {}
): string {
  return homeRelativeLauncherCommand({
    launcher: opts.launcher ?? currentCandidateLauncher(),
    args: ["native", "setup", "--accept-downloads"],
    homeDir: opts.homeDir,
  });
}

/**
 * How to add the image builder to a native home that is already set up. The
 * same sentence in `hack up`, `hack native setup` and `hack doctor`. Nothing
 * downloads without this consent.
 */
export function nativeBuilderRemedy(
  opts: NativeBuilderCommandOptions = {}
): string {
  return `Run ${nativeBuilderSetupCommand(opts)} to add it; offline, add --builder <pinned builder file> to the offline setup inputs.`;
}

/**
 * The `hack up -d` refusal for a native home that has no image builder. A
 * detached start reports its failure by code only, so the sentence is built
 * here, with the same remedy as the foreground refusal. The build runs before
 * any service starts, so nothing of the project is running.
 */
export function nativeBuilderMissingDetachedRefusal(
  opts: NativeBuilderCommandOptions = {}
): string {
  return `Native detached startup refused (${NATIVE_BUILDER_NOT_PREPARED}): ${NATIVE_BUILDER_MISSING}, so no image was built and no service was started. ${nativeBuilderRemedy(opts)}`;
}

/**
 * How to replace an image builder that does not match the pinned release.
 * Setup never deletes or overwrites it, so the user removes its directory and
 * record, named by their paths under the native home, and then runs setup
 * with download consent. Without the paths (a runtime that did not report
 * them) the sentence names where they are.
 */
export function nativeBuilderChangedRemedy(
  opts: NativeBuilderCommandOptions & { readonly paths?: NativeBuilderPaths }
): string {
  const remove = opts.paths
    ? `Remove ${opts.paths.directory} and ${opts.paths.record} from the native home`
    : "Remove the image builder's directory and record from .hack-local/providers in the native home";
  return `${remove}, then run ${nativeBuilderSetupCommand(opts)}.`;
}
