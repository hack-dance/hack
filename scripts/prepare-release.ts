#!/usr/bin/env bun

import { resolve } from "node:path"

type Args = {
  readonly version: string | null
}

type ParseOk = { readonly ok: true; readonly args: Args }
type ParseErr = { readonly ok: false; readonly message: string }

const parsed = parseArgs({ argv: Bun.argv.slice(2) })
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n`)
  process.exitCode = 1
} else {
  process.exitCode = await main({ args: parsed.args })
}

async function main({ args }: { readonly args: Args }): Promise<number> {
  const nextVersion = args.version?.trim() ?? ""
  if (nextVersion.length === 0) {
    process.stderr.write("Missing --version.\n")
    return 1
  }

  const repoRoot = resolve(import.meta.dir, "..")

  // Update package.json
  const packageJsonPath = resolve(repoRoot, "package.json")
  const pkg = await Bun.file(packageJsonPath).json()

  if (typeof pkg !== "object" || pkg === null) {
    process.stderr.write("Unable to read package.json.\n")
    return 1
  }

  const currentVersion = typeof pkg.version === "string" ? pkg.version : null
  if (currentVersion === null) {
    process.stderr.write("package.json is missing a string version.\n")
    return 1
  }

  if (currentVersion !== nextVersion) {
    pkg.version = nextVersion
    await Bun.write(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n")
    process.stdout.write(`Updated package.json: ${currentVersion} → ${nextVersion}\n`)
  }

  // Update macOS app version in Base.xcconfig
  const xconfigPath = resolve(repoRoot, "apps/macos/Config/Base.xcconfig")
  try {
    const xconfigContent = await Bun.file(xconfigPath).text()
    const updatedXconfig = xconfigContent.replace(
      /^MARKETING_VERSION = .*/m,
      `MARKETING_VERSION = ${nextVersion}`
    )
    if (updatedXconfig !== xconfigContent) {
      await Bun.write(xconfigPath, updatedXconfig)
      process.stdout.write(`Updated Base.xcconfig: MARKETING_VERSION → ${nextVersion}\n`)
    }
  } catch {
    // macOS config may not exist, that's fine
  }

  return 0
}

function parseArgs({ argv }: { readonly argv: readonly string[] }): ParseOk | ParseErr {
  let version: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    if (arg.length === 0) continue

    if (arg === "--help" || arg === "-h") {
      return {
        ok: false,
        message: [
          "Update package.json for a release version.",
          "",
          "Usage:",
          "  bun run scripts/prepare-release.ts --version=X.Y.Z",
          "  bun run scripts/prepare-release.ts --version X.Y.Z",
          ""
        ].join("\n")
      }
    }

    if (arg === "--version") {
      const value = argv[index + 1]?.trim()
      if (!value) return { ok: false, message: "Missing value for --version." }
      version = value
      index += 1
      continue
    }

    if (arg.startsWith("--version=")) {
      const value = arg.slice("--version=".length).trim()
      if (!value) return { ok: false, message: "Missing value for --version." }
      version = value
      continue
    }

    return { ok: false, message: `Unknown arg: ${arg}` }
  }

  if (!version) return { ok: false, message: "Missing --version." }

  return { ok: true, args: { version } }
}
