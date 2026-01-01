#!/usr/bin/env bun

import { basename, dirname, resolve, relative } from "node:path"
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
  const releaseDir = resolve(releaseRoot, `hack-${version}`)

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

  process.stdout.write(`Release prepared at:\n  ${releaseDir}\n`)
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
    "  echo \"Add $INSTALL_BIN to PATH if needed.\"",
    "  echo \"  export PATH=\\\"$INSTALL_BIN:\\$PATH\\\"\"",
    "fi",
    "if [ -z \"${HACK_ASSETS_DIR:-}\" ]; then",
    "  echo \"Set assets path:\"",
    "  echo \"  export HACK_ASSETS_DIR=\\\"$INSTALL_ASSETS\\\"\"",
    "fi",
    "echo \"Next: hack global install\"",
    ""
  ].join("\n")
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
