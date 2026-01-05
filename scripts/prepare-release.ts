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

  if (currentVersion === nextVersion) return 0

  pkg.version = nextVersion
  await Bun.write(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n")
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
