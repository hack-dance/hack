import { access, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { confirm, isCancel } from "@clack/prompts";
import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { ensureDir } from "../lib/fs.ts";
import {
  ensureBundledMutagenInstalled,
  getMutagenPath,
} from "../lib/mutagen.ts";
import { findProjectContext } from "../lib/project.ts";
import {
  compareVersions,
  detectHackInstall,
  downloadAndExtractRelease,
  installExtractedRelease,
  resolveGithubRelease,
  resolveUpdateTarget,
  selectCliTarballAsset,
} from "../lib/self-update.ts";
import { exec } from "../lib/shell.ts";

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
    "- Refuses to self-update when running from a Homebrew install, local dev wrapper, or symlink install.",
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

  const mutagenProvision = await ensureMutagenAfterUpdate();
  const agentIntegrations = await syncAgentIntegrationsAfterUpdate({
    binaryPath: bin.path,
  });

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
      mutagen: mutagenProvision,
      agentIntegrations,
    },
    human: agentIntegrations.synced
      ? `Updated to v${latestVersion}; refreshed ${agentIntegrations.scope === "all" ? "project and global" : "global"} agent integrations.`
      : `Updated to v${latestVersion}. ${agentIntegrations.warning}`,
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

  return resolve(resolveGlobalHackDir(), "assets");
}

type MutagenProvisionResult = {
  readonly available: boolean;
  readonly installed: boolean;
  readonly path: string | null;
  readonly warning?: string;
};

type AgentIntegrationUpdateResult = {
  readonly synced: boolean;
  readonly scope: "global" | "all";
  readonly warning?: string;
};

/** Refresh the newly installed CLI's generated rules before the old process exits. */
async function syncAgentIntegrationsAfterUpdate(opts: {
  readonly binaryPath: string;
}): Promise<AgentIntegrationUpdateResult> {
  const project = await findProjectContext(process.cwd());
  const scope = project ? "all" : "global";
  const args = [
    opts.binaryPath,
    "setup",
    "sync",
    ...(project ? ["--all-scopes"] : ["--global"]),
  ];
  const result = await exec(args, { stdin: "ignore" });
  if (result.exitCode === 0) {
    return { synced: true, scope };
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return {
    synced: false,
    scope,
    warning: detail
      ? `Agent integration refresh failed: ${detail}`
      : "Agent integration refresh failed; run hack setup sync --all-scopes.",
  };
}

async function ensureMutagenAfterUpdate(): Promise<MutagenProvisionResult> {
  const existing = getMutagenPath();
  if (existing) {
    return {
      available: true,
      installed: false,
      path: existing,
    };
  }

  const installed = await ensureBundledMutagenInstalled();
  if (installed.ok) {
    return {
      available: true,
      installed: installed.installed,
      path: installed.mutagenPath,
    };
  }

  const fallback = getMutagenPath();
  return {
    available: Boolean(fallback),
    installed: false,
    path: fallback,
    warning: installed.message
      ? `${installed.reason}: ${installed.message}`
      : installed.reason,
  };
}

async function resolveSelfUpdateBinaryPath(): Promise<
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }
> {
  const candidate = resolveHackBinaryCandidate();
  if (!candidate) {
    return { ok: false, error: "Unable to resolve current hack binary path." };
  }

  const install = await detectHackInstall({ path: candidate });
  if (install.status === "missing") {
    return { ok: false, error: `hack binary not found at: ${candidate}` };
  }

  if (install.kind === "homebrew") {
    return {
      ok: false,
      error: [
        "Refusing to self-update because hack is installed via Homebrew.",
        install.linkTarget
          ? `  ${install.path} -> ${install.linkTarget}`
          : `  ${install.path}`,
        "",
        "Upgrade it with:",
        "  brew update",
        "  brew upgrade hack-dance/tap/hack",
      ].join("\n"),
    };
  }

  if (install.kind === "symlink") {
    return {
      ok: false,
      error: [
        "Refusing to self-update because hack is installed as a symlink.",
        `  ${install.path} -> ${install.linkTarget}`,
        "",
        "Install the release build using the installer script, then re-run:",
        "  curl -fsSL https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh | bash",
      ].join("\n"),
    };
  }

  if (install.kind === "dev-wrapper") {
    return {
      ok: false,
      error: [
        "Refusing to self-update because hack is a local-dev wrapper install.",
        "",
        "Install the release build with the installer script, then re-run `hack update`.",
      ].join("\n"),
    };
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
        "Reinstall hack with the release installer script and ensure it is on your PATH, then re-run.",
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

  return resolve(resolveGlobalHackDir(), "bin", "hack");
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
      readonly mutagen?: MutagenProvisionResult;
      readonly agentIntegrations?: AgentIntegrationUpdateResult;
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
