#!/usr/bin/env bun

import { basename, resolve, relative } from "node:path"
import { mkdir, readdir, rm } from "node:fs/promises"

import {
  renderProjectBranchesSchemaJson,
  renderProjectConfigSchemaJson
} from "../src/templates.ts"

type BuildArgs = {
  readonly outDirRaw: string | null
  readonly versionOverride: string | null
  readonly skipTests: boolean
  readonly noClean: boolean
}

type ParseOk = { readonly ok: true; readonly args: BuildArgs }
type ParseErr = { readonly ok: false; readonly message: string }

const parsed = parseArgs({ argv: Bun.argv.slice(2) })
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n`)
  process.exitCode = 1
} else {
  process.exitCode = await main({ args: parsed.args })
}

async function main({ args }: { readonly args: BuildArgs }): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..")
  const pkg = await Bun.file(resolve(repoRoot, "package.json")).json()
  const version = typeof args.versionOverride === "string" ? args.versionOverride : pkg.version

  if (typeof version !== "string" || version.trim().length === 0) {
    process.stderr.write("Unable to determine version from package.json or --version.\n")
    return 1
  }

  const distRoot = resolve(repoRoot, "dist")
  const releaseRoot = args.outDirRaw
    ? resolve(repoRoot, args.outDirRaw)
    : resolve(distRoot, "release")
  const target = resolveTarget()
  if (!target) {
    process.stderr.write(`Unsupported platform/arch: ${process.platform}/${process.arch}\n`)
    return 1
  }

  const releaseDirName = `hack-${version}-release`
  const releaseDir = resolve(releaseRoot, releaseDirName)

  if (!args.noClean) {
    await rm(releaseDir, { recursive: true, force: true })
  }
  await ensureDir(releaseDir)

  if (!args.skipTests) {
    const testExit = await run({ cmd: ["bun", "test"], cwd: repoRoot })
    if (testExit !== 0) return testExit
  }

  const binaryPath = resolve(distRoot, "hack")
  const buildExit = await run({
    cmd: ["bun", "build", "index.ts", "--compile", "--outfile", binaryPath],
    cwd: repoRoot
  })
  if (buildExit !== 0) return buildExit

  await copyFile({ from: binaryPath, to: resolve(releaseDir, "hack") })

  const assetsDir = resolve(releaseDir, "assets")
  const gifsDir = resolve(assetsDir, "gifs")
  const schemasDir = resolve(assetsDir, "schemas")
  await ensureDir(gifsDir)
  await ensureDir(schemasDir)

  await copyIfPresent({ path: resolve(repoRoot, "assets/cut.gif"), destDir: gifsDir })
  await copyIfPresent({ path: resolve(repoRoot, "assets/hacker-mash.gif"), destDir: gifsDir })

  await Bun.write(resolve(schemasDir, "hack.config.schema.json"), renderProjectConfigSchemaJson())
  await Bun.write(
    resolve(schemasDir, "hack.branches.schema.json"),
    renderProjectBranchesSchemaJson()
  )

  const gumSourceDir = resolve(repoRoot, "binaries", "gum")
  const gumDestDir = resolve(releaseDir, "binaries", "gum")
  const gumFiles = await listFiles({ dir: gumSourceDir })
  if (gumFiles.length > 0) {
    await ensureDir(gumDestDir)
    for (const file of gumFiles) {
      await copyFile({ from: resolve(gumSourceDir, file), to: resolve(gumDestDir, file) })
    }
  }

  await copyIfPresent({ path: resolve(repoRoot, "README.md"), destDir: releaseDir })

  const installScriptPath = resolve(releaseDir, "install.sh")
  await Bun.write(installScriptPath, renderInstallScript())
  await chmodExecutable({ path: installScriptPath })

  const checksumPath = resolve(releaseDir, "SHA256SUMS")
  await Bun.write(checksumPath, await renderChecksums({ root: releaseDir }))

  const tarballName = `hack-${version}-${target.platform}-${target.arch}.tar.gz`
  const tarballPath = resolve(releaseRoot, tarballName)
  const tarExit = await run({
    cmd: ["tar", "-czf", tarballPath, "-C", releaseRoot, releaseDirName],
    cwd: repoRoot
  })
  if (tarExit !== 0) return tarExit

  const downloadScriptName = `hack-${version}-install.sh`
  const downloadScriptPath = resolve(releaseRoot, downloadScriptName)
  const downloadScriptAltPath = resolve(releaseRoot, "hack-install.sh")
  const downloadScript = renderDownloadInstallScript()
  await Bun.write(downloadScriptPath, downloadScript)
  await Bun.write(downloadScriptAltPath, downloadScript)
  await chmodExecutable({ path: downloadScriptPath })
  await chmodExecutable({ path: downloadScriptAltPath })

  process.stdout.write(
    [
      "Release prepared:",
      `  Dir: ${releaseDir}`,
      `  Tarball: ${tarballPath}`,
      `  Install script: ${downloadScriptPath}`,
      `  Install script (latest): ${downloadScriptAltPath}`
    ].join("\n") + "\n"
  )
  return 0
}

function parseArgs({ argv }: { readonly argv: readonly string[] }): ParseOk | ParseErr {
  let outDirRaw: string | null = null
  let versionOverride: string | null = null
  let skipTests = false
  let noClean = false

  for (const arg of argv) {
    if (arg === "--skip-tests") {
      skipTests = true
      continue
    }
    if (arg === "--no-clean") {
      noClean = true
      continue
    }
    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length).trim()
      if (value.length === 0) return { ok: false, message: "Invalid --out (empty)" }
      outDirRaw = value
      continue
    }
    if (arg.startsWith("--version=")) {
      const value = arg.slice("--version=".length).trim()
      if (value.length === 0) return { ok: false, message: "Invalid --version (empty)" }
      versionOverride = value
      continue
    }
    if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        message: [
          "Build local release artifacts into dist/release.",
          "",
          "Usage:",
          "  bun run scripts/build-release.ts [--out=dist/release] [--version=X.Y.Z]",
          "                                   [--skip-tests] [--no-clean]",
          ""
        ].join("\n")
      }
    }
    return { ok: false, message: `Unknown arg: ${arg}` }
  }

  return {
    ok: true,
    args: { outDirRaw, versionOverride, skipTests, noClean }
  }
}

async function run({
  cmd,
  cwd
}: {
  readonly cmd: readonly string[]
  readonly cwd: string
}): Promise<number> {
  const proc = Bun.spawn([...cmd], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return await proc.exited
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function listFiles({ dir }: { readonly dir: string }): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter(entry => !entry.startsWith(".")).sort()
  } catch {
    return []
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat()
    return true
  } catch {
    return false
  }
}

async function copyIfPresent({ path, destDir }: { readonly path: string; readonly destDir: string }) {
  const exists = await fileExists(path)
  if (!exists) return
  await copyFile({ from: path, to: resolve(destDir, basename(path)) })
}

async function copyFile({ from, to }: { readonly from: string; readonly to: string }): Promise<void> {
  await Bun.write(to, Bun.file(from))
}

async function chmodExecutable({ path }: { readonly path: string }): Promise<void> {
  const proc = Bun.spawn(["chmod", "+x", path], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  })
  await proc.exited
}

function renderInstallScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "ROOT=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
    "INSTALL_BIN=\"${HACK_INSTALL_BIN:-$HOME/.hack/bin}\"",
    "INSTALL_ASSETS=\"${HACK_INSTALL_ASSETS:-$HOME/.hack/assets}\"",
    "ASSETS_DIR=\"$ROOT/assets\"",
    "BINARIES_DIR=\"$ROOT/binaries\"",
    "",
    "mkdir -p \"$INSTALL_BIN\" \"$INSTALL_ASSETS\"",
    "cp \"$ROOT/hack\" \"$INSTALL_BIN/hack\"",
    "chmod +x \"$INSTALL_BIN/hack\"",
    "",
    "if [ -d \"$ASSETS_DIR\" ]; then",
    "  mkdir -p \"$INSTALL_ASSETS\"",
    "  cp -R \"$ASSETS_DIR/.\" \"$INSTALL_ASSETS\"",
    "fi",
    "",
    "if [ -d \"$BINARIES_DIR\" ]; then",
    "  mkdir -p \"$INSTALL_ASSETS/binaries\"",
    "  cp -R \"$BINARIES_DIR/.\" \"$INSTALL_ASSETS/binaries\"",
    "fi",
    "",
    "has_cmd() { command -v \"$1\" >/dev/null 2>&1; }",
    "",
    "prompt_confirm() {",
    "  local prompt=\"$1\"",
    "  local default=\"${2:-n}\"",
    "  if [ \"${HACK_INSTALL_NONINTERACTIVE:-}\" = \"1\" ]; then",
    "    [ \"$default\" = \"y\" ] && return 0 || return 1",
    "  fi",
    "  local suffix=\"[y/N]\"",
    "  if [ \"$default\" = \"y\" ]; then",
    "    suffix=\"[Y/n]\"",
    "  fi",
    "  if has_cmd gum; then",
    "    if [ \"$default\" = \"y\" ]; then",
    "      gum confirm \"$prompt\" && return 0 || return 1",
    "    else",
    "      gum confirm --default=false \"$prompt\" && return 0 || return 1",
    "    fi",
    "  fi",
    "  read -r -p \"$prompt $suffix \" reply",
    "  if [ -z \"$reply\" ]; then",
    "    reply=\"$default\"",
    "  fi",
    "  case \"$reply\" in",
    "    y|Y|yes|YES) return 0 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "",
    "ensure_brew_pkg() {",
    "  local pkg=\"$1\"",
    "  local reason=\"$2\"",
    "  local default=\"$3\"",
    "  if ! has_cmd brew; then",
    "    echo \"Homebrew not found; skipping $pkg install ($reason).\"",
    "    return",
    "  fi",
    "  if brew list \"$pkg\" >/dev/null 2>&1; then",
    "    return",
    "  fi",
    "  if prompt_confirm \"Install $pkg via Homebrew? ($reason)\" \"$default\"; then",
    "    brew install \"$pkg\"",
    "  else",
    "    echo \"Skipping $pkg install.\"",
    "  fi",
    "}",
    "",
    "if has_cmd docker; then",
    "  :",
    "else",
    "  echo \"Docker not found. Install Docker before running hack.\"",
    "fi",
    "",
    "ensure_brew_pkg \"chafa\" \"used for hack the planet\" \"y\"",
    "ensure_brew_pkg \"dnsmasq\" \"required for *.hack DNS\" \"y\"",
    "ensure_brew_pkg \"mkcert\" \"used for hack global cert\" \"n\"",
    "",
    "echo \"Installed hack to $INSTALL_BIN/hack\"",
    "if [[ \":$PATH:\" != *\":$INSTALL_BIN:\"* ]]; then",
    "  if prompt_confirm \"Add hack to PATH by updating your shell config?\" \"y\"; then",
    "    shell_name=\"$(basename \"${SHELL:-}\")\"",
    "    if [ \"$shell_name\" = \"zsh\" ]; then",
    "      rc_file=\"$HOME/.zshrc\"",
    "    elif [ \"$shell_name\" = \"bash\" ]; then",
    "      rc_file=\"$HOME/.bashrc\"",
    "    else",
    "      rc_file=\"$HOME/.profile\"",
    "    fi",
    "    line=\"export PATH=\\\"$INSTALL_BIN:\\$PATH\\\"\"",
    "    assets_line=\"export HACK_ASSETS_DIR=\\\"$INSTALL_ASSETS\\\"\"",
    "    if [ -f \"$rc_file\" ] && grep -Fq \"$line\" \"$rc_file\"; then",
    "      :",
    "    else",
    "      echo \"$line\" >> \"$rc_file\"",
    "    fi",
    "    if [ -f \"$rc_file\" ] && grep -Fq \"$assets_line\" \"$rc_file\"; then",
    "      :",
    "    else",
    "      echo \"$assets_line\" >> \"$rc_file\"",
    "    fi",
    "    export PATH=\"$INSTALL_BIN:$PATH\"",
    "  else",
    "    echo \"Add $INSTALL_BIN to PATH if needed:\"",
    "    echo \"  export PATH=\\\"$INSTALL_BIN:\\$PATH\\\"\"",
    "  fi",
    "fi",
    "if [ -z \"${HACK_ASSETS_DIR:-}\" ]; then",
    "  export HACK_ASSETS_DIR=\"$INSTALL_ASSETS\"",
    "fi",
    "if prompt_confirm \"Run 'hack global install' now?\" \"y\"; then",
    "  \"$INSTALL_BIN/hack\" global install || true",
    "else",
    "  echo \"Next: hack global install\"",
    "fi",
    ""
  ].join("\n")
}

function renderDownloadInstallScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "REPO_OWNER=\"hack-dance\"",
    "REPO_NAME=\"hack-cli\"",
    "REPO=\"$REPO_OWNER/$REPO_NAME\"",
    "API_URL=\"https://api.github.com/repos/$REPO/releases/latest\"",
    "BASE_URL=\"${HACK_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}\"",
    "",
    "if [ -n \"${HACK_INSTALL_TAG:-}\" ]; then",
    "  TAG=\"$HACK_INSTALL_TAG\"",
    "elif [ -n \"${HACK_INSTALL_VERSION:-}\" ]; then",
    "  TAG=\"v$HACK_INSTALL_VERSION\"",
    "else",
    "  TAG=$(curl -fsSL \"$API_URL\" | sed -n 's/.*\"tag_name\": \"\\([^\"]*\\)\".*/\\1/p' | head -n1)",
    "fi",
    "",
    "if [ -z \"$TAG\" ]; then",
    "  echo \"Failed to resolve release tag.\"",
    "  exit 1",
    "fi",
    "",
    "VERSION=\"${TAG#v}\"",
    "OS=\"$(uname -s | tr '[:upper:]' '[:lower:]')\"",
    "ARCH=\"$(uname -m)\"",
    "if [ \"$ARCH\" = \"x86_64\" ] || [ \"$ARCH\" = \"amd64\" ]; then",
    "  ARCH=\"x86_64\"",
    "elif [ \"$ARCH\" = \"arm64\" ] || [ \"$ARCH\" = \"aarch64\" ]; then",
    "  ARCH=\"arm64\"",
    "else",
    "  echo \"Unsupported architecture: $ARCH\"",
    "  exit 1",
    "fi",
    "",
    "if [ \"$OS\" != \"darwin\" ] && [ \"$OS\" != \"linux\" ]; then",
    "  echo \"Unsupported OS: $OS\"",
    "  exit 1",
    "fi",
    "",
    "TARBALL=\"hack-$VERSION-$OS-$ARCH.tar.gz\"",
    "URL=\"$BASE_URL/$TAG/$TARBALL\"",
    "",
    "tmpdir=$(mktemp -d)",
    "cleanup() { rm -rf \"$tmpdir\"; }",
    "trap cleanup EXIT",
    "",
    "echo \"Downloading $URL\"",
    "curl -fsSL \"$URL\" -o \"$tmpdir/$TARBALL\"",
    "tar -xzf \"$tmpdir/$TARBALL\" -C \"$tmpdir\"",
    "",
    "INSTALL_DIR=\"$tmpdir/hack-$VERSION-release\"",
    "if [ ! -d \"$INSTALL_DIR\" ]; then",
    "  echo \"Missing release directory: $INSTALL_DIR\"",
    "  exit 1",
    "fi",
    "",
    "bash \"$INSTALL_DIR/install.sh\"",
    ""
  ].join("\n")
}

type ReleaseTarget = {
  readonly platform: string
  readonly arch: string
}

function resolveTarget(): ReleaseTarget | null {
  const platform =
    process.platform === "darwin" ? "darwin"
    : process.platform === "linux" ? "linux"
    : null
  if (!platform) return null

  const arch =
    process.arch === "arm64" ? "arm64"
    : process.arch === "x64" ? "x86_64"
    : null
  if (!arch) return null

  return { platform, arch }
}

async function renderChecksums({ root }: { readonly root: string }): Promise<string> {
  const files = await walkFiles({ root })
  const lines: string[] = []

  for (const file of files) {
    const rel = relative(root, file)
    const data = await Bun.file(file).arrayBuffer()
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(new Uint8Array(data))
    const hash = hasher.digest("hex")
    lines.push(`${hash}  ${rel}`)
  }

  return lines.join("\n") + "\n"
}

async function walkFiles({ root }: { readonly root: string }): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkFiles({ root: path })
      out.push(...nested)
      continue
    }
    if (entry.isFile()) out.push(path)
  }
  return out.sort()
}
