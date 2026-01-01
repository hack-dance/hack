#!/usr/bin/env bun

import { dirname, resolve } from "node:path"
import { lstat, readlink } from "node:fs/promises"

import { readTextFile } from "../src/lib/fs.ts"

const CLI_NAME = "hack"
const DEFAULT_INSTALL_DIR_RELATIVE = ".hack/bin"

const home = (process.env.HOME ?? "").trim()
if (home.length === 0) {
  process.stderr.write("HOME is not set; cannot determine install directory.\n")
  process.exit(1)
}

const installDir = resolve(home, DEFAULT_INSTALL_DIR_RELATIVE)
const targetPath = resolve(installDir, CLI_NAME)

const current = await readCurrentInstall({ targetPath })
if (current.status === "missing") {
  process.stdout.write(`No install found at:\n  ${targetPath}\n`)
  process.exit(0)
}

if (current.kind === "symlink") {
  process.stdout.write("Install mode: bin (symlink)\n")
  process.stdout.write(`Path: ${targetPath}\n`)
  process.stdout.write(`Target: ${current.linkTarget}\n`)
  process.exit(0)
}

const isDevWrapper = current.content.includes("hack-cli local-dev shim")
process.stdout.write(`Install mode: ${isDevWrapper ? "dev (wrapper)" : "file (unknown)"}\n`)
process.stdout.write(`Path: ${targetPath}\n`)
process.exit(0)

type CurrentInstall =
  | { readonly status: "missing" }
  | { readonly status: "present"; readonly kind: "symlink"; readonly linkTarget: string }
  | { readonly status: "present"; readonly kind: "file"; readonly content: string }

async function readCurrentInstall({
  targetPath
}: {
  readonly targetPath: string
}): Promise<CurrentInstall> {
  try {
    const stat = await lstat(targetPath)
    if (stat.isSymbolicLink()) {
      const linkTargetRaw = await readlink(targetPath)
      const linkTarget = resolve(dirname(targetPath), linkTargetRaw)
      return { status: "present", kind: "symlink", linkTarget }
    }

    const content = await readTextFile(targetPath)
    return { status: "present", kind: "file", content: content ?? "" }
  } catch {
    return { status: "missing" }
  }
}
