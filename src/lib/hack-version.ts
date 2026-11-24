import pkg from "../../package.json";

/**
 * Set by release builds through Bun's `--define` flag. Ordinary builds and
 * source runs use package.json.
 */
declare const __HACK_BUILD_VERSION__: string | undefined;

/**
 * The version of this Hack build: the one string `hack version`, the CLI
 * spec, hackd's API (`/v1/status`) and the daemon compatibility check all
 * use (HACK-2263). A release bundle reports its packaged version (for
 * example `5.0.0-next.18`), never the package.json version it was built
 * from, so its CLI and its own hackd always agree.
 */
export const HACK_VERSION: string =
  typeof __HACK_BUILD_VERSION__ === "string"
    ? __HACK_BUILD_VERSION__
    : (pkg as { readonly version: string }).version;
