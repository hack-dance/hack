import { statSync } from "node:fs";
import { dirname, join } from "node:path";
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
 *   `~/.hack-next/bin/hack-next` (not on PATH).
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
  const bundle =
    adjacentBundleLauncher(opts.execPath ?? process.execPath) ?? "hack-v5";
  if (entry === "hack-next") {
    return {
      kind: "hack-next",
      command: hackNextLauncherPath(opts.homeDir),
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
