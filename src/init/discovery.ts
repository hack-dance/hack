import { dirname, relative, resolve } from "node:path"
import { Glob, YAML } from "bun"

import { isRecord, isString, isStringArray } from "../lib/guards.ts"
import { pathExists, readTextFile } from "../lib/fs.ts"

export interface PackageJsonInfo {
  readonly name: string | null
  readonly scripts: ReadonlyMap<string, string>
  readonly workspaces: readonly string[]
}

export interface DiscoveredPackage {
  readonly id: string
  readonly packageJsonPath: string
  readonly dir: string
  readonly relativeDir: string
  readonly packageName: string | null
  readonly scripts: ReadonlyMap<string, string>
}

export interface ServiceCandidate {
  readonly id: string
  readonly packageId: string
  readonly packageRelativeDir: string
  readonly packageName: string | null
  readonly scriptName: string
  readonly scriptCommand: string
}

export interface RepoDiscovery {
  readonly repoRoot: string
  readonly isMonorepo: boolean
  readonly workspacePatterns: readonly string[]
  readonly packages: readonly DiscoveredPackage[]
  readonly candidates: readonly ServiceCandidate[]
  readonly signals: readonly string[]
}

export async function discoverRepo(repoRoot: string): Promise<RepoDiscovery> {
  const signals: string[] = []

  const rootPkgPath = resolve(repoRoot, "package.json")
  const rootPkg = await readPackageJson(rootPkgPath)

  const workspacePatterns = [...rootPkg.workspaces, ...(await readPnpmWorkspacePatterns(repoRoot))]

  const hasTurbo = await pathExists(resolve(repoRoot, "turbo.json"))
  if (hasTurbo) signals.push("turbo.json")

  const hasLerna = await pathExists(resolve(repoRoot, "lerna.json"))
  if (hasLerna) signals.push("lerna.json")

  const patterns =
    workspacePatterns.length > 0 ?
      dedupe(workspacePatterns)
    : await guessWorkspacePatterns(repoRoot)

  if (patterns.length > 0) signals.push("workspaces")

  const packageJsonRelPaths = new Set<string>()
  packageJsonRelPaths.add("package.json")

  for (const pattern of patterns) {
    const normalized = normalizeWorkspacePatternToPackageJson(pattern)
    const glob = new Glob(normalized)
    for await (const relPath of glob.scan({
      cwd: repoRoot,
      onlyFiles: true,
      dot: false
    })) {
      if (relPath.includes("node_modules/")) continue
      if (relPath.includes("/.git/")) continue
      packageJsonRelPaths.add(relPath)
    }
  }

  const packages: DiscoveredPackage[] = []
  for (const relPath of [...packageJsonRelPaths].sort()) {
    const absPath = resolve(repoRoot, relPath)
    const pkg = await readPackageJson(absPath)
    const dir = dirname(absPath)
    const relDir = relative(repoRoot, dir) || "."

    packages.push({
      id: relPath,
      packageJsonPath: absPath,
      dir,
      relativeDir: relDir,
      packageName: pkg.name,
      scripts: pkg.scripts
    })
  }

  const candidates = buildServiceCandidates(packages)

  const isMonorepo = packages.length > 1 && patterns.length > 0

  return {
    repoRoot,
    isMonorepo,
    workspacePatterns: patterns,
    packages,
    candidates,
    signals
  }
}

async function readPackageJson(absolutePath: string): Promise<PackageJsonInfo> {
  const text = await readTextFile(absolutePath)
  if (!text) return { name: null, scripts: new Map(), workspaces: [] }

  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    return { name: null, scripts: new Map(), workspaces: [] }
  }

  if (!isRecord(data)) return { name: null, scripts: new Map(), workspaces: [] }

  const name = isString(data["name"]) ? data["name"] : null

  const scriptsMap = new Map<string, string>()
  const scriptsRaw = data["scripts"]
  if (isRecord(scriptsRaw)) {
    for (const [k, v] of Object.entries(scriptsRaw)) {
      if (typeof v === "string") scriptsMap.set(k, v)
    }
  }

  const workspaces = parseWorkspacesField(data)

  return {
    name,
    scripts: scriptsMap,
    workspaces
  }
}

function parseWorkspacesField(pkg: Record<string, unknown>): string[] {
  const ws = pkg["workspaces"]
  if (isStringArray(ws)) return ws
  if (isRecord(ws)) {
    const pkgs = ws["packages"]
    if (isStringArray(pkgs)) return pkgs
  }
  return []
}

async function readPnpmWorkspacePatterns(repoRoot: string): Promise<string[]> {
  const pnpmPath = resolve(repoRoot, "pnpm-workspace.yaml")
  const text = await readTextFile(pnpmPath)
  if (!text) return []

  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []

  const packages = parsed["packages"]
  return isStringArray(packages) ? packages : []
}

async function guessWorkspacePatterns(repoRoot: string): Promise<string[]> {
  const guesses = ["apps/*", "packages/*", "services/*", "workers/*", "pipelines/*", "api/*"]

  const found: string[] = []
  for (const g of guesses) {
    const normalized = normalizeWorkspacePatternToPackageJson(g)
    const glob = new Glob(normalized)
    const iter = glob.scan({ cwd: repoRoot, onlyFiles: true, dot: false })
    for await (const _rel of iter) {
      found.push(g)
      break
    }
  }

  return found
}

function normalizeWorkspacePatternToPackageJson(pattern: string): string {
  const trimmed = pattern.replaceAll(/\/+$/g, "")
  return trimmed.endsWith("package.json") ? trimmed : `${trimmed}/package.json`
}

function buildServiceCandidates(packages: readonly DiscoveredPackage[]): ServiceCandidate[] {
  const out: ServiceCandidate[] = []

  for (const pkg of packages) {
    for (const [scriptName, scriptCommand] of pkg.scripts.entries()) {
      const score = scoreDevScript(scriptName)
      if (score === 0) continue

      out.push({
        id: `${pkg.id}:${scriptName}`,
        packageId: pkg.id,
        packageRelativeDir: pkg.relativeDir,
        packageName: pkg.packageName,
        scriptName,
        scriptCommand
      })
    }
  }

  out.sort((a, b) => scoreDevScript(b.scriptName) - scoreDevScript(a.scriptName))
  return out
}

function scoreDevScript(name: string): number {
  const n = name.toLowerCase()
  if (n === "dev") return 100
  if (n.startsWith("dev:")) return 80
  if (n === "start") return 40
  if (n === "serve") return 30
  if (n === "watch") return 20
  return 0
}

function dedupe(values: readonly string[]): string[] {
  const set = new Set<string>()
  for (const v of values) {
    const trimmed = v.trim()
    if (trimmed.length === 0) continue
    set.add(trimmed)
  }
  return [...set]
}
