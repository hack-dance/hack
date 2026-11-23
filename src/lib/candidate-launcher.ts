import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { resolveUserHomeDir } from "./home-dir.ts";
import { quoteShellWord } from "./logs.ts";

/**
 * Which command a user runs to reach this CLI again, by install kind
 * (HACK-2251).
 *
 * During the prerelease, v5 runs through a candidate launcher while stable v4
 * stays `hack` on PATH, so text that tells the user what to run must name the
 * launcher they actually have:
 *
 * - `stable`: no candidate marker; the command is `hack`.
 * - `hack-next`: the channel manager's launcher at
 *   `<root>/bin/hack-next` of the channel root holding the running bundle
 *   (default root `~/.hack-next`; not on PATH).
 * - `bundle`: the bundle's own `hack-v5` script, run by path. It sits next to
 *   the bundle's `hack-cli`, which is the running executable. When that file
 *   cannot be found (a source run with the marker set by hand), the name
 *   `hack-v5` is the best available answer.
 *
 * This only names commands. Whether a run is a candidate run, and so whether
 * hackd may autostart, is `isCandidateRun` in `src/daemon/client.ts`: any
 * non-empty marker counts, whatever this function makes of it.
 */
export type CandidateLauncher =
  | { readonly kind: "stable"; readonly command: "hack" }
  | {
      readonly kind: "hack-next";
      readonly command: string;
      /** The selected bundle's `hack-v5`, for what `hack-next` refuses. */
      readonly bundle: string;
    }
  | { readonly kind: "bundle"; readonly command: string };

/** The marker the launchers set; see `scripts/hack-v5.sh`. */
const CANDIDATE_ENTRYPOINT_ENV = "HACK_CANDIDATE_ENTRYPOINT";

/** The channel manager's launcher under a home directory. */
export function hackNextLauncherPath(homeDir: string): string {
  return join(homeDir, ".hack-next", "bin", "hack-next");
}

/**
 * The `hack-next` launcher of the channel root that holds the running
 * bundle, if there is one. The manager runs `<root>/versions/<v>/bundle/
 * hack-cli` on both backends, and `--root` installs live anywhere, so the
 * root comes from the running executable, not from HOME.
 */
export function bundleChannelLauncher(execPath: string): string | null {
  const bundle = dirname(execPath);
  if (basename(bundle) !== "bundle") {
    return null;
  }
  const versions = dirname(dirname(bundle));
  if (basename(versions) !== "versions") {
    return null;
  }
  const path = join(dirname(versions), "bin", "hack-next");
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** The bundle's `hack-v5` next to the running `hack-cli`, if it is a file. */
export function adjacentBundleLauncher(execPath: string): string | null {
  const path = join(dirname(execPath), "hack-v5");
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

export function resolveCandidateLauncher(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /** The running executable (default `process.execPath`). */
  readonly execPath?: string;
}): CandidateLauncher {
  const entry = (opts.env[CANDIDATE_ENTRYPOINT_ENV] ?? "").trim();
  if (entry === "") {
    return { kind: "stable", command: "hack" };
  }
  const execPath = opts.execPath ?? process.execPath;
  const bundle = adjacentBundleLauncher(execPath) ?? "hack-v5";
  if (entry === "hack-next") {
    return {
      kind: "hack-next",
      // The installation's own launcher; the default root only when the
      // running bundle is not inside a channel root (a source run).
      command:
        bundleChannelLauncher(execPath) ?? hackNextLauncherPath(opts.homeDir),
      bundle,
    };
  }
  return { kind: "bundle", command: bundle };
}

/** The launcher for this process, from its environment and the user's home. */
export function currentCandidateLauncher(): CandidateLauncher {
  return resolveCandidateLauncher({
    env: process.env,
    homeDir: resolveUserHomeDir(),
  });
}

/** A command line for `launcher`: optional env assignments, then each word quoted. */
export function launcherCommand(
  launcher: CandidateLauncher,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
): string {
  return [
    ...Object.entries(env).map(
      ([key, value]) => `${key}=${quoteShellWord(value)}`
    ),
    ...[launcher.command, ...args].map((word) => quoteShellWord(word)),
  ].join(" ");
}

/** The part of a path after the home that a shell passes through unquoted. */
const UNQUOTED_PATH = /^[A-Za-z0-9._/-]+$/;
const TRAILING_SLASHES = /\/+$/;

/** The user's home directory, or nothing when the system cannot name one. */
function systemHomeDir(): string | undefined {
  try {
    return homedir();
  } catch {
    return;
  }
}

/**
 * `~/<rest>` for a launcher under the home, when `<rest>` needs no quoting.
 * A tilde expands only at the start of an unquoted word, so a path that must
 * be quoted, or that steps out of the home with `..`, has no such form.
 */
export function homeRelativeLauncher(
  command: string,
  homeDir: string | undefined
): string | undefined {
  if (homeDir === undefined || !isAbsolute(homeDir)) {
    return;
  }
  const home = homeDir.replace(TRAILING_SLASHES, "");
  if (home === "" || !command.startsWith(`${home}/`)) {
    return;
  }
  const rest = command.slice(home.length + 1);
  const parts = rest.split("/");
  if (
    !UNQUOTED_PATH.test(rest) ||
    parts.some((part) => part === "" || part === "..")
  ) {
    return;
  }
  return `~/${rest}`;
}

/**
 * A command line for `launcher` that runs as pasted and does not show the
 * user's home directory:
 *
 * - the stable `hack` on PATH stays `hack`;
 * - a launcher whose absolute path is under `homeDir`, with nothing after the
 *   home that needs shell quoting (letters, digits, `/`, `.`, `_`, `-`), is
 *   written `~/<rest>`;
 * - any other launcher (a path outside the home, or one that needs quotes)
 *   keeps the quoted rendering of {@link launcherCommand}.
 *
 * `launcherCommand` and the messages that use it are unchanged; this form is
 * for messages that are also stored or passed on.
 */
export function homeRelativeLauncherCommand(opts: {
  readonly launcher: CandidateLauncher;
  readonly args: readonly string[];
  /** The user's home directory (default: `os.homedir()`). */
  readonly homeDir?: string;
}): string {
  const shown = homeRelativeLauncher(
    opts.launcher.command,
    opts.homeDir ?? systemHomeDir()
  );
  if (shown === undefined) {
    return launcherCommand(opts.launcher, opts.args);
  }
  return [shown, ...opts.args.map((word) => quoteShellWord(word))].join(" ");
}

/**
 * The command that sets up a fresh native home. A custom `HACK_NATIVE_HOME`
 * needs the bundle's `hack-v5`: `hack-next` refuses one, because it keeps its
 * receipt-owned home for safe upgrades. `<new private home>` is a placeholder
 * the user replaces.
 */
export function freshNativeHomeSetupCommand(
  launcher: CandidateLauncher
): string {
  const runner =
    launcher.kind === "hack-next" ? launcher.bundle : launcher.command;
  return `HACK_NATIVE_HOME=<new private home> ${quoteShellWord(runner)} native setup`;
}
