import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir } from "./fs.ts";
import { execOrThrow } from "./shell.ts";

const DEFAULT_MUTAGEN_VERSION = "0.18.1";
const MUTAGEN_RELEASE_BASE_URL =
  "https://github.com/mutagen-io/mutagen/releases/download";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MUTAGEN_AGENT_BUNDLE_FILENAME = "mutagen-agents.tar.gz";

type MutagenPlatform = "darwin" | "linux";
type MutagenArch = "amd64" | "arm64";

type MutagenArtifact = {
  readonly version: string;
  readonly platform: MutagenPlatform;
  readonly arch: MutagenArch;
  readonly filename: string;
  readonly downloadUrl: string;
};

export type BundledMutagenInstallOutcome =
  | {
      readonly ok: true;
      readonly installed: boolean;
      readonly mutagenPath: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "home-not-set"
        | "unsupported-platform"
        | "tar-not-found"
        | "download-failed"
        | "failed";
      readonly message?: string;
    };

let mutagenPathCached: string | null | undefined;

/**
 * Resolve the mutagen binary path for runtime usage.
 */
export function getMutagenPath(): string | null {
  if (mutagenPathCached !== undefined) {
    return mutagenPathCached;
  }

  const overrideRaw = (process.env.HACK_MUTAGEN_PATH ?? "").trim();
  if (overrideRaw.length > 0) {
    mutagenPathCached = overrideRaw;
    return mutagenPathCached;
  }

  const managed = getManagedMutagenInstallPath();
  if (managed && existsSync(managed)) {
    mutagenPathCached = managed;
    return mutagenPathCached;
  }

  mutagenPathCached = Bun.which("mutagen");
  return mutagenPathCached;
}

export function resetMutagenPathCacheForTests(): void {
  mutagenPathCached = undefined;
}

/**
 * Resolve the managed Mutagen agent bundle path used for remote platform sync.
 */
export function getManagedMutagenAgentBundlePath(): string {
  return resolve(
    resolveGlobalHackDir(),
    "libexec",
    MUTAGEN_AGENT_BUNDLE_FILENAME
  );
}

/**
 * Ensure managed mutagen exists at ~/.hack/bin/mutagen.
 */
export async function ensureBundledMutagenInstalled(): Promise<BundledMutagenInstallOutcome> {
  const installPath = getManagedMutagenInstallPath();
  const agentBundlePath = getManagedMutagenAgentBundlePath();
  if (!(installPath && agentBundlePath)) {
    return { ok: false, reason: "home-not-set" };
  }

  if (existsSync(installPath) && existsSync(agentBundlePath)) {
    mutagenPathCached = installPath;
    return { ok: true, installed: false, mutagenPath: installPath };
  }

  const artifact = resolveMutagenArtifact({
    platform: process.platform,
    arch: process.arch,
    version: resolveMutagenVersion(),
  });
  if (!artifact) {
    return { ok: false, reason: "unsupported-platform" };
  }

  const tar = Bun.which("tar");
  if (!tar) {
    return { ok: false, reason: "tar-not-found" };
  }

  const tmpRoot = await mkdtemp(resolve(tmpdir(), "hack-mutagen-"));
  const downloadedTarballPath = resolve(tmpRoot, artifact.filename);
  const localTarballPath = resolveBundledMutagenTarball({
    filename: artifact.filename,
  });
  const tarballPath = localTarballPath ?? downloadedTarballPath;

  try {
    await ensureDir(dirname(installPath));
    await ensureDir(dirname(agentBundlePath));
    if (!localTarballPath) {
      const downloaded = await downloadMutagenTarball({
        url: artifact.downloadUrl,
        outPath: downloadedTarballPath,
      });
      if (!downloaded.ok) {
        return downloaded;
      }
    }

    await execOrThrow(
      [tar, "-xzf", tarballPath, "-C", dirname(installPath), "mutagen"],
      { stdin: "ignore" }
    );
    await execOrThrow(
      [
        tar,
        "-xzf",
        tarballPath,
        "-C",
        dirname(agentBundlePath),
        MUTAGEN_AGENT_BUNDLE_FILENAME,
      ],
      { stdin: "ignore" }
    );
    await execOrThrow(["chmod", "+x", installPath], { stdin: "ignore" });
    mutagenPathCached = installPath;
    return { ok: true, installed: true, mutagenPath: installPath };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, reason: "failed", message };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function getManagedMutagenInstallPath(): string {
  return resolve(resolveGlobalHackDir(), "bin", "mutagen");
}

function resolveMutagenVersion(): string {
  const override = (process.env.HACK_MUTAGEN_VERSION ?? "").trim();
  return SEMVER_PATTERN.test(override) ? override : DEFAULT_MUTAGEN_VERSION;
}

function resolveMutagenArtifact(input: {
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
}): MutagenArtifact | null {
  let platform: MutagenPlatform | null = null;
  if (input.platform === "darwin") {
    platform = "darwin";
  } else if (input.platform === "linux") {
    platform = "linux";
  }
  if (!platform) {
    return null;
  }

  let arch: MutagenArch | null = null;
  if (input.arch === "x64") {
    arch = "amd64";
  } else if (input.arch === "arm64") {
    arch = "arm64";
  }
  if (!arch) {
    return null;
  }

  const filename = `mutagen_${platform}_${arch}_v${input.version}.tar.gz`;
  return {
    version: input.version,
    platform,
    arch,
    filename,
    downloadUrl: `${MUTAGEN_RELEASE_BASE_URL}/v${input.version}/${filename}`,
  };
}

function resolveBundledMutagenTarball(input: {
  readonly filename: string;
}): string | null {
  for (const candidate of bundledMutagenTarballCandidates({
    filename: input.filename,
  })) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function bundledMutagenTarballCandidates(input: {
  readonly filename: string;
}): readonly string[] {
  const out: string[] = [];

  const envDir = (process.env.HACK_ASSETS_DIR ?? "").trim();
  if (envDir.length > 0) {
    out.push(resolve(envDir, input.filename));
    out.push(resolve(envDir, "binaries", "mutagen", input.filename));
  }

  const defaultAssets = resolve(resolveGlobalHackDir(), "assets");
  out.push(resolve(defaultAssets, input.filename));
  out.push(resolve(defaultAssets, "binaries", "mutagen", input.filename));

  // Dev/source layout: <repo>/src/lib/mutagen.ts -> <repo>/binaries/mutagen/<tarball>
  out.push(resolve(import.meta.dir, "../../binaries/mutagen", input.filename));
  return out;
}

async function downloadMutagenTarball(input: {
  readonly url: string;
  readonly outPath: string;
}): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "download-failed";
      readonly message: string;
    }
> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      headers: {
        accept: "application/octet-stream",
        "user-agent": "hack-cli",
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to download mutagen";
    return { ok: false, reason: "download-failed", message };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "download-failed",
      message: `Download failed (${response.status}): ${response.statusText}`,
    };
  }

  try {
    const buf = await response.arrayBuffer();
    await Bun.write(input.outPath, buf);
    return { ok: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to write mutagen tarball";
    return { ok: false, reason: "download-failed", message };
  }
}

export const __testOnlyMutagen = {
  resolveMutagenArtifact,
};
