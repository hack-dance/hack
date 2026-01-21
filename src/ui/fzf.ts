import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureDir } from "../lib/fs.ts";
import { execOrThrow } from "../lib/shell.ts";

/**
 * Outcome type for fzf operations.
 * Represents success with a value, or failure with a reason.
 */
export type FzfOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unavailable" }
  | { readonly ok: false; readonly reason: "cancelled" }
  | {
      readonly ok: false;
      readonly reason: "failed";
      readonly exitCode: number;
    };

/**
 * Result of installing the bundled fzf binary.
 */
export type BundledFzfInstallOutcome =
  | { readonly ok: true; readonly installed: boolean; readonly fzfPath: string }
  | {
      readonly ok: false;
      readonly reason:
        | "home-not-set"
        | "unsupported-platform"
        | "bundle-not-found"
        | "tar-not-found"
        | "failed";
      readonly message?: string;
    };

const FZF_VERSION = "0.67.0";

let fzfPathCached: string | null | undefined;

/**
 * Get the path to the fzf binary.
 * Resolution order:
 * 1. HACK_FZF_PATH environment variable override
 * 2. Bundled binary at ~/.hack/bin/fzf
 * 3. System fzf via Bun.which
 *
 * @returns Path to fzf binary, or null if not found
 */
export function getFzfPath(): string | null {
  if (fzfPathCached !== undefined) {
    return fzfPathCached;
  }

  const overrideRaw = (process.env.HACK_FZF_PATH ?? "").trim();
  if (overrideRaw.length > 0) {
    fzfPathCached = overrideRaw;
    return fzfPathCached;
  }

  const bundled = getBundledFzfInstallPath();
  if (bundled && existsSync(bundled)) {
    fzfPathCached = bundled;
    return fzfPathCached;
  }

  fzfPathCached = Bun.which("fzf");
  return fzfPathCached;
}

/**
 * Reset the cached fzf path. Used in tests.
 */
export function resetFzfPathCacheForTests(): void {
  fzfPathCached = undefined;
}

/**
 * Check if fzf is available on the system.
 *
 * @returns True if fzf is available
 */
export function isFzfAvailable(): boolean {
  return getFzfPath() !== null;
}

/**
 * Ensure the bundled fzf binary is installed.
 * Extracts from tarball on first run if not already present.
 *
 * @returns Installation outcome with path or error reason
 */
export async function ensureBundledFzfInstalled(): Promise<BundledFzfInstallOutcome> {
  const installPath = getBundledFzfInstallPath();
  if (!installPath) {
    return { ok: false, reason: "home-not-set" };
  }

  if (existsSync(installPath)) {
    fzfPathCached = installPath;
    return { ok: true, installed: false, fzfPath: installPath };
  }

  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported-platform" };
  }

  const bundle = resolveBundledFzfArtifact();
  if (!bundle) {
    return { ok: false, reason: "bundle-not-found" };
  }

  const tar = Bun.which("tar");
  if (!tar) {
    return { ok: false, reason: "tar-not-found" };
  }

  try {
    await ensureDir(dirname(installPath));
    await execOrThrow(
      [tar, "-xzf", bundle.tarballPath, "-C", dirname(installPath), "fzf"],
      { stdin: "ignore" }
    );
    await execOrThrow(["chmod", "+x", installPath], { stdin: "ignore" });
    fzfPathCached = installPath;
    return { ok: true, installed: true, fzfPath: installPath };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, reason: "failed", message };
  }
}

/**
 * Input options for fzf filter operation.
 */
export interface FzfFilterInput {
  /** Items to filter through */
  readonly items: readonly string[];
  /** Prompt text shown to user */
  readonly prompt?: string;
  /** Header text shown above results */
  readonly header?: string;
  /** Preview command (executed with {} as placeholder) */
  readonly preview?: string;
  /** Height of fzf window (e.g., "50%", "20") */
  readonly height?: string;
  /** Enable multi-select mode */
  readonly multi?: boolean;
  /** Disable sorting (preserve input order) */
  readonly noSort?: boolean;
  /** Reverse display order */
  readonly reverse?: boolean;
  /** Enable exact match mode */
  readonly exact?: boolean;
  /** Initial query */
  readonly query?: string;
  /** Border style */
  readonly border?: "rounded" | "sharp" | "bold" | "double" | "none";
  /** Tab stop for column alignment */
  readonly tabstop?: number;
}

/**
 * Run fzf filter and return selected item(s).
 *
 * @param input - Filter configuration options
 * @returns Selected items or failure reason
 */
export async function fzfFilter(
  input: FzfFilterInput
): Promise<FzfOutcome<readonly string[]>> {
  const fzf = getFzfPath();
  if (!fzf) {
    return { ok: false, reason: "unavailable" };
  }

  const cmd = [
    fzf,
    ...(input.prompt ? ["--prompt", input.prompt] : []),
    ...(input.header ? ["--header", input.header] : []),
    ...(input.preview ? ["--preview", input.preview] : []),
    ...(input.height ? ["--height", input.height] : []),
    ...(input.multi ? ["--multi"] : []),
    ...(input.noSort ? ["--no-sort"] : []),
    ...(input.reverse ? ["--reverse"] : []),
    ...(input.exact ? ["--exact"] : []),
    ...(input.query ? ["--query", input.query] : []),
    ...(input.border ? ["--border", input.border] : []),
    ...(input.tabstop ? ["--tabstop", String(input.tabstop)] : []),
  ];

  const inputText = input.items.join("\n");
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(inputText));
      controller.close();
    },
  });

  const proc = Bun.spawn(cmd, {
    env: process.env,
    stdin: inputStream,
    stdout: "pipe",
    stderr: "inherit",
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode === 0) {
    const selected = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    return { ok: true, value: selected };
  }

  if (exitCode === 1) {
    return { ok: true, value: [] };
  }

  if (exitCode === 130) {
    return { ok: false, reason: "cancelled" };
  }

  return { ok: false, reason: "failed", exitCode };
}

/**
 * Run fzf filter and return a single selected item.
 *
 * @param input - Filter configuration options (multi is ignored)
 * @returns Selected item or failure reason
 */
export async function fzfFilterOne(
  input: Omit<FzfFilterInput, "multi">
): Promise<FzfOutcome<string | null>> {
  const result = await fzfFilter({ ...input, multi: false });
  if (!result.ok) {
    return result;
  }
  const first = result.value[0] ?? null;
  return { ok: true, value: first };
}

/**
 * Get the path where bundled fzf should be installed.
 *
 * @returns Installation path, or null if HOME is not set
 */
function getBundledFzfInstallPath(): string | null {
  const home = process.env.HOME;
  if (!home) {
    return null;
  }
  return `${home}/.hack/bin/fzf`;
}

type BundledFzfArtifact = {
  readonly tarballPath: string;
};

/**
 * Find the bundled fzf tarball for the current platform.
 *
 * @returns Tarball path or null if not found
 */
function resolveBundledFzfArtifact(): BundledFzfArtifact | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const arch = process.arch;
  const archSuffix = arch === "arm64" ? "arm64" : "amd64";
  const filename = `fzf-${FZF_VERSION}-darwin_${archSuffix}.tar.gz`;

  for (const p of bundledFzfTarballCandidates(filename)) {
    if (existsSync(p)) {
      return { tarballPath: p };
    }
  }

  return null;
}

/**
 * Generate candidate paths for finding the bundled fzf tarball.
 *
 * @param filename - Tarball filename to search for
 * @returns Array of candidate paths to check
 */
function bundledFzfTarballCandidates(filename: string): readonly string[] {
  const out: string[] = [];

  const envDir = (process.env.HACK_ASSETS_DIR ?? "").trim();
  if (envDir.length > 0) {
    out.push(resolve(envDir, filename));
    out.push(resolve(envDir, "binaries", "fzf", filename));
  }

  const home = process.env.HOME;
  if (home) {
    const defaultAssets = resolve(home, ".hack", "assets");
    out.push(resolve(defaultAssets, filename));
    out.push(resolve(defaultAssets, "binaries", "fzf", filename));
  }

  // Dev/source layout: <repo>/src/ui/fzf.ts → <repo>/binaries/fzf/<tarball>
  out.push(resolve(import.meta.dir, "../../binaries/fzf", filename));

  const argv1 = process.argv[1];
  if (typeof argv1 === "string" && argv1.length > 0) {
    out.push(resolve(dirname(argv1), "binaries", "fzf", filename));
    out.push(resolve(dirname(argv1), "..", "binaries", "fzf", filename));
  }

  const execPath = process.execPath;
  if (typeof execPath === "string" && execPath.length > 0) {
    out.push(resolve(dirname(execPath), "binaries", "fzf", filename));
    out.push(resolve(dirname(execPath), "..", "binaries", "fzf", filename));
  }

  return out;
}
