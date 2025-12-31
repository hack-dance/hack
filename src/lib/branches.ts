import { dirname, resolve } from "node:path"

import { getString, isRecord } from "./guards.ts"
import { ensureDir, readTextFile, writeTextFileIfChanged } from "./fs.ts"
import { DEFAULT_SCHEMAS_HOST, PROJECT_BRANCHES_FILENAME } from "../constants.ts"

export const BRANCHES_VERSION = 1 as const
export const BRANCHES_SCHEMA_URL = `https://${DEFAULT_SCHEMAS_HOST}/hack.branches.schema.json`

export type BranchEntry = {
  readonly name: string
  readonly slug: string
  readonly note?: string
  readonly created_at?: string
  readonly last_used_at?: string
}

export type BranchesFile = {
  readonly $schema?: string
  readonly version: typeof BRANCHES_VERSION
  branches: BranchEntry[]
}

export type BranchesReadResult = {
  readonly path: string
  readonly exists: boolean
  readonly file: BranchesFile
  readonly parseError?: string
}

export type TouchBranchUsageResult = {
  readonly updated: boolean
  readonly created: boolean
  readonly path: string
  readonly error?: string
}

export async function readBranchesFile(opts: {
  readonly projectDir: string
}): Promise<BranchesReadResult> {
  const path = resolve(opts.projectDir, PROJECT_BRANCHES_FILENAME)
  const text = await readTextFile(path)
  if (text === null) {
    return {
      path,
      exists: false,
      file: defaultBranchesFile()
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON"
    return {
      path,
      exists: true,
      file: defaultBranchesFile(),
      parseError: message
    }
  }

  const file = parseBranchesFile(parsed)
  if (!file) {
    return {
      path,
      exists: true,
      file: defaultBranchesFile(),
      parseError: "Invalid hack.branches.json format"
    }
  }

  return { path, exists: true, file }
}

export async function writeBranchesFile(opts: {
  readonly path: string
  readonly file: BranchesFile
}): Promise<void> {
  const out: BranchesFile = {
    $schema: BRANCHES_SCHEMA_URL,
    version: BRANCHES_VERSION,
    branches: opts.file.branches
  }

  const dir = dirname(opts.path)
  await ensureDir(dir)
  await writeTextFileIfChanged(opts.path, `${JSON.stringify(out, null, 2)}\n`)
}

export async function touchBranchUsage(opts: {
  readonly projectDir: string
  readonly branch: string
  readonly nowIso?: string
  readonly createIfMissing?: boolean
}): Promise<TouchBranchUsageResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const read = await readBranchesFile({ projectDir: opts.projectDir })
  if (read.parseError) {
    return { updated: false, created: false, path: read.path, error: read.parseError }
  }

  if (!read.exists && !opts.createIfMissing) {
    return { updated: false, created: false, path: read.path }
  }

  let updated = false
  let created = false
  let matched = false

  const nextBranches = read.file.branches.map(entry => {
    if (entry.slug !== opts.branch && entry.name.toLowerCase() !== opts.branch.toLowerCase()) {
      return entry
    }
    matched = true
    updated = true
    return {
      ...entry,
      created_at: entry.created_at ?? nowIso,
      last_used_at: nowIso
    }
  })

  if (!matched && opts.createIfMissing) {
    updated = true
    created = true
    nextBranches.push({
      name: opts.branch,
      slug: opts.branch,
      created_at: nowIso,
      last_used_at: nowIso
    })
  }

  if (!updated) {
    return { updated: false, created: false, path: read.path }
  }

  await writeBranchesFile({ path: read.path, file: { ...read.file, branches: nextBranches } })
  return { updated: true, created, path: read.path }
}

function defaultBranchesFile(): BranchesFile {
  return {
    $schema: BRANCHES_SCHEMA_URL,
    version: BRANCHES_VERSION,
    branches: []
  }
}

function parseBranchesFile(value: unknown): BranchesFile | null {
  if (!isRecord(value)) return null
  const versionRaw = value["version"]
  const version = typeof versionRaw === "number" ? versionRaw : null
  if (version !== BRANCHES_VERSION) return null

  const branchesRaw = value["branches"]
  if (!Array.isArray(branchesRaw)) return null

  const branches: BranchEntry[] = []
  for (const entry of branchesRaw) {
    const parsed = parseBranchEntry(entry)
    if (parsed) branches.push(parsed)
  }

  return {
    $schema: getString(value, "$schema") ?? undefined,
    version: BRANCHES_VERSION,
    branches
  }
}

function parseBranchEntry(value: unknown): BranchEntry | null {
  if (!isRecord(value)) return null
  const name = getString(value, "name")
  const slug = getString(value, "slug")
  if (!name || !slug) return null
  const note = getString(value, "note") ?? undefined
  const createdAt = getString(value, "created_at") ?? undefined
  const lastUsedAt = getString(value, "last_used_at") ?? undefined
  return {
    name,
    slug,
    ...(note ? { note } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(lastUsedAt ? { last_used_at: lastUsedAt } : {})
  }
}
