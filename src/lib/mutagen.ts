import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir } from "./fs.ts";
import { execOrThrow } from "./shell.ts";

const DEFAULT_MUTAGEN_VERSION = "0.18.1";
const MUTAGEN_RELEASE_BASE_URL =
  "https://github.com/mutagen-io/mutagen/releases/download";
// Upstream v0.18.1 SHA256SUMS, verified against each release archive.
const MUTAGEN_SHA256 = {
  darwin_amd64:
    "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
  darwin_arm64:
    "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
  linux_amd64:
    "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  linux_arm64:
    "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
} as const;
const MUTAGEN_AGENT_BUNDLE_FILENAME = "mutagen-agents.tar.gz";

type MutagenPlatform = "darwin" | "linux";
type MutagenArch = "amd64" | "arm64";

type MutagenArtifact = {
  readonly version: string;
  readonly platform: MutagenPlatform;
  readonly arch: MutagenArch;
  readonly filename: string;
  readonly downloadUrl: string;
  readonly sha256: string;
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
        | "unpinned-version"
        | "checksum-mismatch"
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

  const version =
    (process.env.HACK_MUTAGEN_VERSION ?? "").trim() || DEFAULT_MUTAGEN_VERSION;
  if (version !== DEFAULT_MUTAGEN_VERSION) {
    return {
      ok: false,
      reason: "unpinned-version",
      message: "HACK_MUTAGEN_VERSION has no release checksum pinned by Hack.",
    };
  }

  const artifact = resolveMutagenArtifact({
    platform: process.platform,
    arch: process.arch,
    version,
  });
  if (!artifact) {
    return { ok: false, reason: "unsupported-platform" };
  }

  const tar = Bun.which("tar");
  if (!tar) {
    return { ok: false, reason: "tar-not-found" };
  }

  const tmpRoot = await mkdtemp(resolve(tmpdir(), "hack-mutagen-"));
  const tarballPath = resolve(tmpRoot, artifact.filename);
  const localTarballPath = resolveBundledMutagenTarball({
    filename: artifact.filename,
  });

  try {
    if (localTarballPath) {
      // Verify and extract the same private copy, even if the asset is replaced.
      await copyFile(localTarballPath, tarballPath);
    } else {
      const downloaded = await downloadMutagenTarball({
        url: artifact.downloadUrl,
        outPath: tarballPath,
      });
      if (!downloaded.ok) {
        return downloaded;
      }
    }

    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(tarballPath).arrayBuffer())
      .digest("hex");
    if (digest !== artifact.sha256) {
      return {
        ok: false,
        reason: "checksum-mismatch",
        message: "Mutagen archive does not match its pinned release checksum.",
      };
    }
    await ensureDir(dirname(installPath));
    await ensureDir(dirname(agentBundlePath));

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

function resolveMutagenArtifact(input: {
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
}): MutagenArtifact | null {
  if (input.version !== DEFAULT_MUTAGEN_VERSION) {
    return null;
  }
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
    sha256: MUTAGEN_SHA256[`${platform}_${arch}`],
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
