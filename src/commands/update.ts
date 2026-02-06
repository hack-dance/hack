import { access, lstat, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { confirm, isCancel } from "@clack/prompts";
import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { ensureDir } from "../lib/fs.ts";
import {
  compareVersions,
  downloadAndExtractRelease,
  isDevWrapperShimBytes,
  installExtractedRelease,
  resolveGithubRelease,
  resolveUpdateTarget,
  selectCliTarballAsset,
} from "../lib/self-update.ts";

const optCheck = defineOption({
  name: "check",
  type: "boolean",
  long: "--check",
  description: "Check for updates (do not install)",
} as const);

const optYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description: "Apply update without prompting",
} as const);

const optTag = defineOption({
  name: "tag",
  type: "string",
  long: "--tag",
  valueHint: "<tag>",
  description: "Update to a specific release tag (e.g. v1.4.0)",
} as const);

const options = [optCheck, optYes, optTag, optJson] as const;
const positionals = [] as const;

const spec = defineCommand({
  name: "update",
  summary: "Update hack to the latest release",
  group: "Diagnostics",
  description: [
    "Downloads and installs the latest stable hack release from GitHub.",
    "",
    "Notes:",
    "- Refuses to self-update when running from a local dev wrapper or symlink install.",
    "- Updates the current hack binary and refreshes assets.",
  ].join("\n"),
  options,
  positionals,
  subcommands: [],
} as const);

type Spec = typeof spec;

const handleUpdate: CommandHandlerFor<Spec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const target = resolveUpdateTarget();
  if (!target) {
    return writeResult({
      json: args.options.json === true,
      result: {
        ok: false,
        error: `Unsupported platform/arch: ${process.platform}/${process.arch}`,
      },
    });
  }

  const bin = await resolveSelfUpdateBinaryPath();
  if (!bin.ok) {
    return writeResult({
      json: args.options.json === true,
      result: { ok: false, error: bin.error },
    });
  }

  const assetsDir = resolveAssetsDir();
  const tag =
    typeof args.options.tag === "string" ? args.options.tag : undefined;

  const releaseRes = await resolveGithubRelease({ tag });
  if (!releaseRes.ok) {
    return writeResult({
      json: args.options.json === true,
      result: { ok: false, error: releaseRes.error },
    });
  }

  const latestVersion = releaseRes.version;
  const currentVersion = ctx.cli.version;

  const { updateAvailable } = compareVersions({
    current: currentVersion,
    latest: latestVersion,
  });
  if (updateAvailable === null) {
    return writeResult({
      json: args.options.json === true,
      result: {
        ok: false,
        error: `Unable to compare versions (current=${currentVersion}, latest=${latestVersion})`,
      },
    });
  }

  if (!updateAvailable) {
    return writeResult({
      json: args.options.json === true,
      result: {
        ok: true,
        current: currentVersion,
        latest: latestVersion,
        updateAvailable: false,
        installed: false,
        target,
        binaryPath: bin.path,
        assetsDir,
      },
      human: `Already up to date (v${currentVersion}).`,
    });
  }

  const asset = selectCliTarballAsset({
    release: releaseRes.release,
    version: latestVersion,
    target,
  });
  if (!asset) {
    return writeResult({
      json: args.options.json === true,
      result: {
        ok: false,
        error: `Missing release asset for ${target.platform}/${target.arch} (v${latestVersion})`,
      },
    });
  }

  const announce = `Update available: v${currentVersion} -> v${latestVersion}`;
  if (args.options.check === true) {
    return writeResult({
      json: args.options.json === true,
      result: {
        ok: true,
        current: currentVersion,
        latest: latestVersion,
        updateAvailable: true,
        installed: false,
        target,
        binaryPath: bin.path,
        assetsDir,
      },
      human: announce,
    });
  }

  const wantsInstall = await confirmInstall({
    yes: args.options.yes === true,
    isTty: process.stdout.isTTY,
    prompt: `${announce}. Install now?`,
  });
  if (!wantsInstall.ok) {
    return writeResult({
      json: args.options.json === true,
      result: { ok: false, error: wantsInstall.error },
    });
  }
  if (!wantsInstall.install) {
    return writeResult({
      json: args.options.json === true,
      result: {
        ok: true,
        current: currentVersion,
        latest: latestVersion,
        updateAvailable: true,
        installed: false,
        target,
        binaryPath: bin.path,
        assetsDir,
      },
      human: "Aborted.",
    });
  }

  await ensureDir(dirname(bin.path));
  await ensureDir(assetsDir);

  const extracted = await downloadAndExtractRelease({
    url: asset.url,
    version: latestVersion,
  });
  if (!extracted.ok) {
    return writeResult({
      json: args.options.json === true,
      result: { ok: false, error: extracted.error },
    });
  }

  try {
    const install = await installExtractedRelease({
      extractedReleaseDir: extracted.extractedReleaseDir,
      binaryPath: bin.path,
      assetsDir,
    });
    if (!install.ok) {
      return writeResult({
        json: args.options.json === true,
        result: { ok: false, error: install.error },
      });
    }
  } finally {
    // Best-effort cleanup; avoid failing the update after a successful install.
    await rm(extracted.tmpDir, { recursive: true, force: true }).catch(
      () => undefined
    );
  }

  return writeResult({
    json: args.options.json === true,
    result: {
      ok: true,
      current: currentVersion,
      latest: latestVersion,
      updateAvailable: true,
      installed: true,
      target,
      binaryPath: bin.path,
      assetsDir,
    },
    human: `Updated to v${latestVersion}.`,
  });
};

async function confirmInstall(opts: {
  readonly yes: boolean;
  readonly isTty: boolean;
  readonly prompt: string;
}): Promise<
  | { readonly ok: true; readonly install: boolean }
  | { readonly ok: false; readonly error: string }
> {
  if (opts.yes) {
    return { ok: true, install: true };
  }
  if (!opts.isTty) {
    return {
      ok: false,
      error: "Non-interactive shell; re-run with --yes to apply the update.",
    };
  }

  const res = await confirm({ message: opts.prompt, initialValue: true });
  if (isCancel(res)) {
    return { ok: true, install: false };
  }
  return { ok: true, install: res === true };
}

function resolveAssetsDir(): string {
  const env = (process.env.HACK_ASSETS_DIR ?? "").trim();
  if (env.length > 0) {
    return resolve(env);
  }

  const home = (process.env.HOME ?? "").trim();
  if (home.length > 0) {
    return resolve(home, ".hack", "assets");
  }

  return resolve(".hack", "assets");
}

async function resolveSelfUpdateBinaryPath(): Promise<
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }
> {
  const candidate = resolveHackBinaryCandidate();
  if (!candidate) {
    return { ok: false, error: "Unable to resolve current hack binary path." };
  }

  const stat = await lstat(candidate).catch(() => null);
  if (!stat) {
    return { ok: false, error: `hack binary not found at: ${candidate}` };
  }

  if (stat.isSymbolicLink()) {
    return {
      ok: false,
      error: [
        "Refusing to self-update because hack is installed as a symlink.",
        "",
        "Install the release build into ~/.hack/bin using the installer script, then re-run:",
        "  curl -fsSL https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh | bash",
      ].join("\n"),
    };
  }

  // Detect local dev shim installs (a bash wrapper script), but avoid false positives for compiled
  // binaries (which embed the marker string in their own data segment).
  const file = Bun.file(candidate);
  const prefixBuf = await file.slice(0, 2).arrayBuffer().catch(() => null);
  if (prefixBuf) {
    const prefix = new Uint8Array(prefixBuf);
    const isShebang =
      prefix.length === 2 && prefix[0] === 0x23 && prefix[1] === 0x21; // #!
    if (isShebang) {
      const headBuf = await file
        .slice(0, 64 * 1024)
        .arrayBuffer()
        .catch(() => null);
      if (headBuf && isDevWrapperShimBytes(new Uint8Array(headBuf))) {
        return {
          ok: false,
          error: [
            "Refusing to self-update because hack is a local-dev wrapper install.",
            "",
            "Install the release build into ~/.hack/bin, then re-run `hack update`.",
          ].join("\n"),
        };
      }
    }
  }

  const writable = await access(candidate, 2).then(
    () => true,
    () => false
  );
  if (!writable) {
    return {
      ok: false,
      error: [
        "Refusing to self-update because the current hack binary is not writable:",
        `  ${candidate}`,
        "",
        "Reinstall hack into ~/.hack/bin and ensure it is on your PATH, then re-run.",
      ].join("\n"),
    };
  }

  return { ok: true, path: candidate };
}

function resolveHackBinaryCandidate(): string | null {
  if (basename(process.execPath) === "hack") {
    return process.execPath;
  }

  const which = Bun.which("hack");
  if (typeof which === "string" && which.trim().length > 0) {
    return which;
  }

  const home = (process.env.HOME ?? "").trim();
  if (home.length > 0) {
    return resolve(home, ".hack", "bin", "hack");
  }

  return null;
}

type UpdateOutput =
  | {
      readonly ok: true;
      readonly current: string;
      readonly latest: string;
      readonly updateAvailable: boolean;
      readonly installed: boolean;
      readonly target: {
        readonly platform: string;
        readonly arch: string;
      };
      readonly binaryPath: string;
      readonly assetsDir: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

function writeResult(opts: {
  readonly json: boolean;
  readonly result: UpdateOutput;
  readonly human?: string;
}): number {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(opts.result, null, 2)}\n`);
    return opts.result.ok ? 0 : 1;
  }

  if (opts.result.ok) {
    process.stdout.write(`${opts.human ?? "OK"}\n`);
    return 0;
  }

  process.stderr.write(`${opts.result.error}\n`);
  return 1;
}

export const updateCommand = withHandler(spec, handleUpdate);
