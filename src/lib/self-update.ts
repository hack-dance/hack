import { lstat, mkdir, readdir, readlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { ensureDir } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { compareSemver } from "./semver.ts";
import { execOrThrow } from "./shell.ts";

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
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to reach GitHub";
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
}): Promise<DownloadExtractResult> {
  const tmpRoot = await mkTmpDir({ prefix: "hack-update-" });
  const tarballPath = resolve(tmpRoot, "release.tar.gz");

  const downloadOk = await downloadToFile({
    url: opts.url,
    outPath: tarballPath,
  });
  if (!downloadOk.ok) {
    await rm(tmpRoot, { recursive: true, force: true });
    return downloadOk;
  }

  const tarExit = await extractTarGz({ tarballPath, outDir: tmpRoot });
  if (!tarExit.ok) {
    await rm(tmpRoot, { recursive: true, force: true });
    return tarExit;
  }

  const dirName = `hack-${opts.version}-release`;
  const extractedReleaseDir = resolve(tmpRoot, dirName);

  const exists = await pathExists(extractedReleaseDir);
  if (!exists) {
    await rm(tmpRoot, { recursive: true, force: true });
    return {
      ok: false,
      error: `Missing extracted release dir: ${extractedReleaseDir}`,
    };
  }

  return { ok: true, tmpDir: tmpRoot, extractedReleaseDir };
}

export type InstallReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export async function installExtractedRelease(opts: {
  readonly extractedReleaseDir: string;
  readonly binaryPath: string;
  readonly assetsDir: string;
}): Promise<InstallReleaseResult> {
  const srcHack = resolve(opts.extractedReleaseDir, "hack");
  const srcAssets = resolve(opts.extractedReleaseDir, "assets");
  const srcBinaries = resolve(opts.extractedReleaseDir, "binaries");

  const hackExists = await pathExists(srcHack);
  if (!hackExists) {
    return { ok: false, error: `Missing hack binary in release: ${srcHack}` };
  }

  await ensureDir(dirname(opts.binaryPath));
  await ensureDir(opts.assetsDir);

  const replaceOk = await atomicReplaceFile({
    srcPath: srcHack,
    destPath: opts.binaryPath,
    chmodMode: 0o755,
  });
  if (!replaceOk.ok) {
    return replaceOk;
  }

  const assetsExists = await pathExists(srcAssets);
  if (assetsExists) {
    const copyOk = await copyDirContents({
      srcDir: srcAssets,
      destDir: opts.assetsDir,
    });
    if (!copyOk.ok) {
      return copyOk;
    }
  }

  const binariesExists = await pathExists(srcBinaries);
  if (binariesExists) {
    const destBinaries = resolve(opts.assetsDir, "binaries");
    await ensureDir(destBinaries);
    const copyOk = await copyDirContents({
      srcDir: srcBinaries,
      destDir: destBinaries,
    });
    if (!copyOk.ok) {
      return copyOk;
    }
  }

  return { ok: true };
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
        assets.push({ name, url });
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

async function mkTmpDir(opts: { readonly prefix: string }): Promise<string> {
  const dir = join(
    tmpdir(),
    `${opts.prefix}${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function downloadToFile(opts: {
  readonly url: string;
  readonly outPath: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  let res: Response;
  try {
    res = await fetch(opts.url, {
      headers: {
        accept: "application/octet-stream",
        "user-agent": "hack-cli",
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to download release asset";
    return { ok: false, error: message };
  }

  if (!res.ok) {
    const text = await safeReadText(res);
    return {
      ok: false,
      error: `Download failed (${res.status}): ${text ?? res.statusText}`,
    };
  }

  try {
    const buf = await res.arrayBuffer();
    await Bun.write(opts.outPath, buf);
    return { ok: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to write downloaded file";
    return { ok: false, error: message };
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
    });
    return { ok: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to extract tarball";
    return { ok: false, error: message };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function atomicReplaceFile(opts: {
  readonly srcPath: string;
  readonly destPath: string;
  readonly chmodMode?: number;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const destDir = dirname(opts.destPath);
  const tmpName = `${basename(opts.destPath)}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  const tmpPath = resolve(destDir, tmpName);

  try {
    await Bun.write(tmpPath, Bun.file(opts.srcPath));
    if (typeof opts.chmodMode === "number") {
      await execOrThrow(["chmod", `${opts.chmodMode.toString(8)}`, tmpPath], {
        stdin: "ignore",
      });
    }
    await rename(tmpPath, opts.destPath);
    return { ok: true };
  } catch (error: unknown) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    const message =
      error instanceof Error ? error.message : "Failed to install file";
    return { ok: false, error: message };
  }
}

async function copyDirContents(opts: {
  readonly srcDir: string;
  readonly destDir: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  let entries: string[];
  try {
    entries = await readdir(opts.srcDir);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : `Failed to read ${opts.srcDir}`;
    return { ok: false, error: message };
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }

    const srcPath = resolve(opts.srcDir, entry);
    const destPath = resolve(opts.destDir, entry);

    const stat = await Bun.file(srcPath)
      .stat()
      .catch(() => null);
    if (!stat) {
      continue;
    }

    if (stat.isDirectory()) {
      await ensureDir(destPath);
      const nested = await copyDirContents({
        srcDir: srcPath,
        destDir: destPath,
      });
      if (!nested.ok) {
        return nested;
      }
      continue;
    }

    if (stat.isFile()) {
      await ensureDir(dirname(destPath));
      await rm(destPath, { force: true }).catch(() => undefined);
      await Bun.write(destPath, Bun.file(srcPath));
    }
  }

  return { ok: true };
}
