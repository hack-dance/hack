#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface Args {
  readonly repo: string;
  readonly tag: string | null;
  readonly version: string | null;
  readonly tapDir: string | null;
}

interface ParseOk {
  readonly ok: true;
  readonly args: Args;
}

interface ParseErr {
  readonly ok: false;
  readonly message: string;
}

interface GithubReleaseView {
  readonly tagName?: unknown;
  readonly assets?: unknown;
}

export interface ReleaseAssetInfo {
  readonly name: string;
  readonly sha256: string;
}

type ParsedOption =
  | {
      readonly ok: true;
      readonly nextIndex: number;
      readonly apply: (input: MutableArgs) => void;
    }
  | ParseErr;

type MutableArgs = {
  repo: string;
  tag: string | null;
  version: string | null;
  tapDir: string | null;
};

const HELP_TEXT = [
  "Render the Homebrew tap formula for a published hack release.",
  "",
  "Usage:",
  "  bun run scripts/update-homebrew-tap.ts --tag=vX.Y.Z --version=X.Y.Z --tap-dir=/path/to/tap",
  "  bun run scripts/update-homebrew-tap.ts --tag vX.Y.Z --version X.Y.Z --tap-dir /path/to/tap",
  "",
  "Options:",
  "  --repo <owner/name>   GitHub repo to query (default: hack-dance/hack)",
].join("\n");

if (import.meta.main) {
  const parsed = parseArgs({ argv: Bun.argv.slice(2) });
  if (parsed.ok) {
    process.exitCode = await main({ args: parsed.args });
  } else {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 1;
  }
}

async function main({ args }: { readonly args: Args }): Promise<number> {
  const tag = args.tag?.trim() ?? "";
  const version = args.version?.trim() ?? "";
  const tapDir = args.tapDir?.trim() ?? "";

  if (tag.length === 0) {
    process.stderr.write("Missing --tag.\n");
    return 1;
  }
  if (version.length === 0) {
    process.stderr.write("Missing --version.\n");
    return 1;
  }
  if (tapDir.length === 0) {
    process.stderr.write("Missing --tap-dir.\n");
    return 1;
  }

  const release = await loadRelease({
    repo: args.repo,
    tag,
  });
  if (!release.ok) {
    process.stderr.write(`${release.error}\n`);
    return 1;
  }

  if (release.tag !== tag) {
    process.stderr.write(
      `Release tag mismatch: expected ${tag}, got ${release.tag}.\n`
    );
    return 1;
  }

  let formula: string;
  try {
    formula = renderFormula({
      repo: args.repo,
      tag,
      version,
      darwinArm64: requireAsset({
        assets: release.assets,
        fileName: `hack-${version}-darwin-arm64.tar.gz`,
      }),
      darwinX64: requireAsset({
        assets: release.assets,
        fileName: `hack-${version}-darwin-x86_64.tar.gz`,
      }),
      linuxX64: requireAsset({
        assets: release.assets,
        fileName: `hack-${version}-linux-x86_64.tar.gz`,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  const formulaPath = resolve(tapDir, "Formula", "hack.rb");
  await mkdir(dirname(formulaPath), { recursive: true });
  await Bun.write(formulaPath, formula);
  process.stdout.write(`Wrote ${formulaPath}\n`);
  return 0;
}

function requireAsset({
  assets,
  fileName,
}: {
  readonly assets: readonly ReleaseAssetInfo[];
  readonly fileName: string;
}): ReleaseAssetInfo {
  const asset = assets.find((entry) => entry.name === fileName);
  if (!asset) {
    throw new Error(`Missing release asset: expected ${fileName}.`);
  }
  return asset;
}

async function loadRelease({
  repo,
  tag,
}: {
  readonly repo: string;
  readonly tag: string;
}): Promise<
  | {
      readonly ok: true;
      readonly tag: string;
      readonly assets: readonly ReleaseAssetInfo[];
    }
  | { readonly ok: false; readonly error: string }
> {
  const proc = Bun.spawn({
    cmd: [
      "gh",
      "release",
      "view",
      tag,
      "--repo",
      repo,
      "--json",
      "tagName,assets",
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = stderr.trim();
    return {
      ok: false,
      error:
        details.length > 0
          ? `gh release view failed: ${details}`
          : "gh release view failed.",
    };
  }

  let parsed: GithubReleaseView;
  try {
    parsed = JSON.parse(stdout) as GithubReleaseView;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to parse release metadata: ${message}` };
  }

  if (typeof parsed.tagName !== "string" || parsed.tagName.length === 0) {
    return { ok: false, error: "Release metadata is missing tagName." };
  }

  const assets = parseAssets({
    assets: parsed.assets,
  });
  return { ok: true, tag: parsed.tagName, assets };
}

function parseAssets({
  assets,
}: {
  readonly assets: unknown;
}): readonly ReleaseAssetInfo[] {
  if (!Array.isArray(assets)) {
    return [];
  }

  const out: ReleaseAssetInfo[] = [];
  for (const asset of assets) {
    if (!isRecord(asset)) {
      continue;
    }

    const name = typeof asset.name === "string" ? asset.name : null;
    const digestRaw = typeof asset.digest === "string" ? asset.digest : null;
    if (!(name && digestRaw)) {
      continue;
    }

    const sha256 = digestRaw.startsWith("sha256:")
      ? digestRaw.slice("sha256:".length)
      : digestRaw;
    if (sha256.length === 0) {
      continue;
    }

    out.push({
      name,
      sha256,
    });
  }

  return out;
}

export function renderFormula({
  repo,
  tag,
  version,
  darwinArm64,
  darwinX64,
  linuxX64,
}: {
  readonly repo: string;
  readonly tag: string;
  readonly version: string;
  readonly darwinArm64: ReleaseAssetInfo;
  readonly darwinX64: ReleaseAssetInfo;
  readonly linuxX64: ReleaseAssetInfo;
}): string {
  return `${[
    "class Hack < Formula",
    '  desc "Environment orchestration for software projects"',
    `  homepage "https://github.com/${repo}"`,
    `  version "${version}"`,
    '  license "MIT"',
    "",
    "  on_macos do",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/${repo}/releases/download/${tag}/${darwinArm64.name}"`,
    `      sha256 "${darwinArm64.sha256}"`,
    "    else",
    `      url "https://github.com/${repo}/releases/download/${tag}/${darwinX64.name}"`,
    `      sha256 "${darwinX64.sha256}"`,
    "    end",
    "  end",
    "",
    "  on_linux do",
    `    url "https://github.com/${repo}/releases/download/${tag}/${linuxX64.name}"`,
    `    sha256 "${linuxX64.sha256}"`,
    "  end",
    "",
    "  def install",
    '    libexec.install "hack"',
    '    (libexec/"assets").install Dir["assets/*"] if (buildpath/"assets").directory?',
    '    (libexec/"assets/binaries").install Dir["binaries/*"] if (buildpath/"binaries").directory?',
    '    (bin/"hack").write_env_script libexec/"hack", HACK_ASSETS_DIR: libexec/"assets"',
    "  end",
    "",
    "  test do",
    '    assert_match "hack", shell_output("#{bin}/hack --help")',
    "  end",
    "end",
    "",
  ].join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseArgs({
  argv,
}: {
  readonly argv: readonly string[];
}): ParseOk | ParseErr {
  const args: MutableArgs = {
    version: null,
    tag: null,
    tapDir: null,
    repo: "hack-dance/hack",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.length === 0) {
      continue;
    }
    const parsed = parseArgToken({ argv, index });
    if (!parsed.ok) {
      return parsed;
    }
    parsed.apply(args);
    index = parsed.nextIndex;
  }

  return {
    ok: true,
    args,
  };
}

function parseArgToken({
  argv,
  index,
}: {
  readonly argv: readonly string[];
  readonly index: number;
}): ParsedOption {
  const arg = argv[index] ?? "";
  if (arg === "--help" || arg === "-h") {
    return { ok: false, message: HELP_TEXT };
  }

  const inlineOption = parseInlineOption({ arg });
  if (inlineOption) {
    return {
      ...inlineOption,
      ...(inlineOption.ok ? { nextIndex: index } : {}),
    };
  }

  return parseSplitOption({ argv, index });
}

function parseInlineOption({
  arg,
}: {
  readonly arg: string;
}): ParsedOption | null {
  if (arg.startsWith("--version=")) {
    return buildOptionResult({
      value: arg.slice("--version=".length).trim(),
      flag: "--version",
      nextIndex: 0,
      apply: (args, value) => {
        args.version = value;
      },
    });
  }
  if (arg.startsWith("--tag=")) {
    return buildOptionResult({
      value: arg.slice("--tag=".length).trim(),
      flag: "--tag",
      nextIndex: 0,
      apply: (args, value) => {
        args.tag = value;
      },
    });
  }
  if (arg.startsWith("--tap-dir=")) {
    return buildOptionResult({
      value: arg.slice("--tap-dir=".length).trim(),
      flag: "--tap-dir",
      nextIndex: 0,
      apply: (args, value) => {
        args.tapDir = value;
      },
    });
  }
  if (arg.startsWith("--repo=")) {
    return buildOptionResult({
      value: arg.slice("--repo=".length).trim(),
      flag: "--repo",
      nextIndex: 0,
      apply: (args, value) => {
        args.repo = value;
      },
    });
  }
  return null;
}

function parseSplitOption({
  argv,
  index,
}: {
  readonly argv: readonly string[];
  readonly index: number;
}): ParsedOption {
  const arg = argv[index] ?? "";
  const value = argv[index + 1]?.trim() ?? "";

  if (arg === "--version") {
    return buildOptionResult({
      value,
      flag: "--version",
      nextIndex: index + 1,
      apply: (args, nextValue) => {
        args.version = nextValue;
      },
    });
  }
  if (arg === "--tag") {
    return buildOptionResult({
      value,
      flag: "--tag",
      nextIndex: index + 1,
      apply: (args, nextValue) => {
        args.tag = nextValue;
      },
    });
  }
  if (arg === "--tap-dir") {
    return buildOptionResult({
      value,
      flag: "--tap-dir",
      nextIndex: index + 1,
      apply: (args, nextValue) => {
        args.tapDir = nextValue;
      },
    });
  }
  if (arg === "--repo") {
    return buildOptionResult({
      value,
      flag: "--repo",
      nextIndex: index + 1,
      apply: (args, nextValue) => {
        args.repo = nextValue;
      },
    });
  }

  return { ok: false, message: `Unknown argument: ${arg}` };
}

function buildOptionResult({
  value,
  flag,
  nextIndex,
  apply,
}: {
  readonly value: string;
  readonly flag: string;
  readonly nextIndex: number;
  readonly apply: (args: MutableArgs, value: string) => void;
}): ParsedOption {
  if (value.length === 0) {
    return { ok: false, message: `Missing value for ${flag}.` };
  }

  return {
    ok: true,
    nextIndex,
    apply: (args) => {
      apply(args, value);
    },
  };
}
