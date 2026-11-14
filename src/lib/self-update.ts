import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getString, isRecord } from "./guards.ts";
import { publishRelease } from "./release-install.ts";
import { verifyReleaseDirectory } from "./release-integrity.ts";
import { type ReleaseFetch, transferRelease } from "./release-transfer.ts";
import { compareSemver } from "./semver.ts";
import { execOrThrow } from "./shell.ts";

const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/;
const ARCHIVE_NAME = /^[A-Za-z0-9._/-]+$/;
const ASSET_DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_REPO_OWNER = "hack-dance" as const;
const DEFAULT_REPO_NAME = "hack" as const;
const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local"] as const;
const LINUXBREW_HOME_MARKERS = [
  "/.linuxbrew/bin/hack",
  "/.linuxbrew/Cellar/hack/",
  "/.linuxbrew/opt/hack/",
] as const;

export const DEV_WRAPPER_MARKER = "hack-cli local-dev shim" as const;
const DEV_WRAPPER_SHEBANG_PREFIX = "#!" as const;

export type UpdatePlatform = "darwin" | "linux";
export type UpdateArch = "arm64" | "x86_64";

export type UpdateTarget = {
  readonly platform: UpdatePlatform;
  readonly arch: UpdateArch;
};

export type GithubReleaseAsset = {
  readonly name: string;
  readonly url: string;
  readonly sha256?: string;
};

export type GithubRelease = {
  readonly tag: string;
  readonly assets: readonly GithubReleaseAsset[];
};

export type ResolveReleaseResult =
  | {
      readonly ok: true;
      readonly release: GithubRelease;
      readonly version: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export function resolveUpdateTarget(): UpdateTarget | null {
  let platform: UpdatePlatform | null = null;
  if (process.platform === "darwin") {
    platform = "darwin";
  } else if (process.platform === "linux") {
    platform = "linux";
  }
  if (!platform) {
    return null;
  }

  let arch: UpdateArch | null = null;
  if (process.arch === "arm64") {
    arch = "arm64";
  } else if (process.arch === "x64") {
    arch = "x86_64";
  }
  if (!arch) {
    return null;
  }

  return { platform, arch };
}

/**
 * Local dev installs write a bash wrapper script into ~/.hack/bin/hack that executes `bun index.ts`.
 * We refuse to self-update those shims, but must not mis-detect compiled binaries (which embed the
 * marker string as part of their program text/data).
 */
export function isDevWrapperShimBytes(bytes: Uint8Array): boolean {
  if (bytes.length < DEV_WRAPPER_SHEBANG_PREFIX.length) {
    return false;
  }

  // Only treat shebang files as possible wrappers.
  const prefix = String.fromCharCode(
    ...bytes.slice(0, DEV_WRAPPER_SHEBANG_PREFIX.length)
  );
  if (prefix !== DEV_WRAPPER_SHEBANG_PREFIX) {
    return false;
  }

  const head = bytes.slice(0, Math.min(bytes.length, 64 * 1024));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  return text.includes(DEV_WRAPPER_MARKER);
}

export type HackInstallState =
  | { readonly status: "missing" }
  | {
      readonly status: "present";
      readonly kind: "homebrew";
      readonly path: string;
      readonly linkTarget?: string;
    }
  | {
      readonly status: "present";
      readonly kind: "symlink";
      readonly path: string;
      readonly linkTarget: string;
    }
  | {
      readonly status: "present";
      readonly kind: "dev-wrapper";
      readonly path: string;
    }
  | {
      readonly status: "present";
      readonly kind: "standalone";
      readonly path: string;
    };

export function isHomebrewManagedHackPath(pathRaw: string): boolean {
  const path = pathRaw.trim();
  if (path.length === 0) {
    return false;
  }

  return HOMEBREW_PREFIXES.some((prefix) => {
    return (
      path === `${prefix}/bin/hack` ||
      path.endsWith(`${prefix}/bin/hack`) ||
      path.includes(`${prefix}/Cellar/hack/`) ||
      path.includes(`${prefix}/opt/hack/`)
    );
  })
    ? true
    : LINUXBREW_HOME_MARKERS.some((marker) => path.includes(marker));
}

export async function detectHackInstall({
  path,
}: {
  readonly path: string;
}): Promise<HackInstallState> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) {
    return { status: "missing" };
  }

  if (stat.isSymbolicLink()) {
    const linkTargetRaw = await readlink(path).catch(() => null);
    if (!linkTargetRaw) {
      return {
        status: "present",
        kind: "symlink",
        path,
        linkTarget: path,
      };
    }

    const linkTarget = resolve(dirname(path), linkTargetRaw);
    if (
      isHomebrewManagedHackPath(path) ||
      isHomebrewManagedHackPath(linkTarget)
    ) {
      return {
        status: "present",
        kind: "homebrew",
        path,
        linkTarget,
      };
    }

    return {
      status: "present",
      kind: "symlink",
      path,
      linkTarget,
    };
  }

  if (isHomebrewManagedHackPath(path)) {
    return {
      status: "present",
      kind: "homebrew",
      path,
    };
  }

  const file = Bun.file(path);
  const prefixBuf = await file
    .slice(0, 2)
    .arrayBuffer()
    .catch(() => null);
  if (prefixBuf) {
    const prefix = new Uint8Array(prefixBuf);
    const isShebang =
      prefix.length === 2 && prefix[0] === 0x23 && prefix[1] === 0x21;
    if (isShebang) {
      const headBuf = await file
        .slice(0, 64 * 1024)
        .arrayBuffer()
        .catch(() => null);
      if (headBuf && isDevWrapperShimBytes(new Uint8Array(headBuf))) {
        return {
          status: "present",
          kind: "dev-wrapper",
          path,
        };
      }
    }
  }

  return {
    status: "present",
    kind: "standalone",
    path,
  };
}

export function normalizeTag(tagRaw: string): string {
  const t = tagRaw.trim();
  if (t.length === 0) {
    return "";
  }
  return t.startsWith("v") ? t : `v${t}`;
}

export function tagToVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function expectedCliTarballName(opts: {
  readonly version: string;
  readonly target: UpdateTarget;
}): string {
  return `hack-${opts.version}-${opts.target.platform}-${opts.target.arch}.tar.gz`;
}

export function selectCliTarballAsset(opts: {
  readonly release: GithubRelease;
  readonly version: string;
  readonly target: UpdateTarget;
}): GithubReleaseAsset | null {
  const expected = expectedCliTarballName({
    version: opts.version,
    target: opts.target,
  });
  return opts.release.assets.find((asset) => asset.name === expected) ?? null;
}

export async function resolveGithubRelease(opts: {
  readonly tag?: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
}): Promise<ResolveReleaseResult> {
  const owner = opts.repoOwner ?? DEFAULT_REPO_OWNER;
  const repo = opts.repoName ?? DEFAULT_REPO_NAME;
  const tag = typeof opts.tag === "string" ? normalizeTag(opts.tag) : "";

  const url =
    tag.length > 0
      ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
      : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "hack-cli",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (_error: unknown) {
    const message =
      "Network unavailable; installation unchanged. Retry when connectivity returns.";
    return { ok: false, error: message };
  }

  if (!res.ok) {
    const text = await safeReadText(res);
    return {
      ok: false,
      error: `GitHub API error (${res.status}): ${text ?? res.statusText}`,
    };
  }

  const json: unknown = await res.json().catch(() => null);
  const parsed = parseGithubRelease(json);
  if (!parsed) {
    return { ok: false, error: "Invalid GitHub release response" };
  }

  const version = tagToVersion(parsed.tag);
  if (version.trim().length === 0) {
    return { ok: false, error: "Invalid release tag_name" };
  }

  return { ok: true, release: parsed, version };
}

export type DownloadExtractResult =
  | {
      readonly ok: true;
      readonly tmpDir: string;
      readonly extractedReleaseDir: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export async function downloadAndExtractRelease(opts: {
  readonly url: string;
  readonly version: string;
  readonly sha256?: string;
  readonly request?: ReleaseFetch;
  /** Parent for a fresh owned extraction directory; defaults to the OS temp directory. */
  readonly tempParent?: string;
}): Promise<DownloadExtractResult> {
  if (!RELEASE_VERSION.test(opts.version)) {
    return {
      ok: false,
      error: "Invalid release version; installation unchanged.",
    };
  }
  const tmpRoot = await mkdtemp(
    join(opts.tempParent ?? tmpdir(), "hack-update-")
  );
  const tarballPath = resolve(tmpRoot, "release.tar.gz");
  try {
    await transferRelease({
      url: opts.url,
      path: tarballPath,
      sha256: opts.sha256,
      request: opts.request,
    });
    const rootName = `hack-${opts.version}-release`;
    const { stdout: names } = await execOrThrow(["tar", "-tzf", tarballPath], {
      stdin: "ignore",
      timeoutMs: 30_000,
    });
    const { stdout: details } = await execOrThrow(
      ["tar", "-tvzf", tarballPath],
      { stdin: "ignore", timeoutMs: 30_000 }
    );
    if (
      !names.trim() ||
      names
        .trim()
        .split("\n")
        .some(
          (name) =>
            !(
              ARCHIVE_NAME.test(name) &&
              (name === rootName || name.startsWith(`${rootName}/`))
            ) || name.split("/").some((part) => part === ".." || part === ".")
        ) ||
      details
        .trim()
        .split("\n")
        .some((line) => !["-", "d"].includes(line[0] ?? ""))
    ) {
      throw new Error("Unsafe release archive layout; installation unchanged.");
    }
    const tarExit = await extractTarGz({ tarballPath, outDir: tmpRoot });
    if (!tarExit.ok) {
      throw new Error(
        "Release archive extraction failed; installation unchanged."
      );
    }
    const extractedReleaseDir = resolve(tmpRoot, rootName);
    await verifyReleaseDirectory(extractedReleaseDir);
    return { ok: true, tmpDir: tmpRoot, extractedReleaseDir };
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true });
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Release download failed; installation unchanged.",
    };
  }
}

export type InstallReleaseResult =
  | { readonly ok: true; readonly backupManifest: string }
  | { readonly ok: false; readonly error: string };

export async function installExtractedRelease(opts: {
  readonly version: string;
  readonly extractedReleaseDir: string;
  readonly binaryPath: string;
  readonly assetsDir: string;
}): Promise<InstallReleaseResult> {
  try {
    return { ok: true, ...(await publishRelease(opts)) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unable to publish release; previous installation retained.",
    };
  }
}

export function compareVersions(opts: {
  readonly current: string;
  readonly latest: string;
}): { readonly cmp: number | null; readonly updateAvailable: boolean | null } {
  const cmp = compareSemver(opts.current, opts.latest);
  if (cmp === null) {
    return { cmp: null, updateAvailable: null };
  }
  return { cmp, updateAvailable: cmp === -1 };
}

function parseGithubRelease(json: unknown): GithubRelease | null {
  if (!isRecord(json)) {
    return null;
  }

  const tag = getString(json, "tag_name");
  if (typeof tag !== "string" || tag.trim().length === 0) {
    return null;
  }

  const assetsUnknown: unknown = json.assets;
  const assets: GithubReleaseAsset[] = [];
  if (Array.isArray(assetsUnknown)) {
    for (const entry of assetsUnknown) {
      if (!isRecord(entry)) {
        continue;
      }
      const name = getString(entry, "name");
      const url = getString(entry, "browser_download_url");
      if (typeof name === "string" && typeof url === "string" && name && url) {
        const digest = getString(entry, "digest");
        if (digest && !ASSET_DIGEST.test(digest)) {
          return null;
        }
        assets.push({
          name,
          url,
          ...(digest ? { sha256: digest.slice(7) } : {}),
        });
      }
    }
  }

  return { tag, assets };
}

async function safeReadText(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function extractTarGz(opts: {
  readonly tarballPath: string;
  readonly outDir: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  try {
    await execOrThrow(["tar", "-xzf", opts.tarballPath, "-C", opts.outDir], {
      stdin: "ignore",
      timeoutMs: 30_000,
    });
    return { ok: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to extract tarball";
    return { ok: false, error: message };
  }
}
