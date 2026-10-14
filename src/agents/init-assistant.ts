import { relative, resolve } from "node:path";
import { Glob, YAML } from "bun";
import type { DiscoveredPackage, ServiceCandidate } from "../init/discovery.ts";
import { discoverRepo } from "../init/discovery.ts";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import type { ProjectContext } from "../lib/project.ts";
import { findProjectContext } from "../lib/project.ts";

export type ComposeSignal = {
  readonly path: string;
  readonly services: readonly string[];
};

export type ScriptSignal = {
  readonly packageId: string;
  readonly packageRelativeDir: string;
  readonly packageName: string | null;
  readonly scriptName: string;
  readonly scriptCommand: string;
};

/** JavaScript package managers identified by lockfile name. */
export type PackageManagerId = "bun" | "pnpm" | "yarn" | "npm";

/** A JavaScript lockfile found by name at the root or in a workspace package. */
export type LockfileSignal = {
  readonly path: string;
  readonly manager: PackageManagerId;
};

/** Non-JavaScript ecosystems recognized by manifest or lockfile name. */
export type RuntimeEcosystem =
  | "rust"
  | "go"
  | "python"
  | "ruby"
  | "elixir"
  | "dotnet";

/** A non-JavaScript manifest or lockfile found by name. */
export type RuntimeManifestSignal = {
  readonly path: string;
  readonly ecosystem: RuntimeEcosystem;
};

/**
 * Repo signals for agent-assisted init.
 *
 * Every field is derived from file names and manifest keys only: env files,
 * lockfiles and runtime pin files are detected by existence and never read,
 * and `package.json` contributes key names (`engines`, `packageManager`), not
 * their values. `limitations` states what the inventory did not cover so the
 * agent does not mistake an absent signal for an absent requirement.
 */
export type InitAssistantReport = {
  readonly repoRoot: string;
  readonly projectContext: ProjectContext | null;
  readonly packageCount: number;
  readonly isMonorepo: boolean;
  readonly workspacePatterns: readonly string[];
  readonly discoverySignals: readonly string[];
  /** Lockfile names present at the repo root. */
  readonly packageManagers: readonly string[];
  /** Lockfiles found inside workspace package directories (repo-relative). */
  readonly nestedLockfiles: readonly LockfileSignal[];
  /** Distinct package managers across all lockfiles when more than one is present. */
  readonly packageManagerConflicts: readonly PackageManagerId[];
  readonly runtimeManifests: readonly RuntimeManifestSignal[];
  /** Runtime pin file names and `package.json#<key>` pin keys, never values. */
  readonly runtimePins: readonly string[];
  readonly envFiles: readonly string[];
  readonly composeFiles: readonly ComposeSignal[];
  readonly dockerfiles: readonly string[];
  readonly dbSignals: readonly string[];
  readonly candidates: readonly ServiceCandidate[];
  readonly setupScripts: readonly ScriptSignal[];
  readonly limitations: readonly string[];
};

/**
 * Build a report describing repo signals for agent-assisted init.
 */
export async function buildInitAssistantReport(opts: {
  readonly repoRoot: string;
}): Promise<InitAssistantReport> {
  const projectContext = await findProjectContext(opts.repoRoot);
  const discovery = await discoverRepo(opts.repoRoot);

  const rootLockfiles = await detectLockfiles({
    repoRoot: opts.repoRoot,
    relativeDir: ".",
  });
  const nestedLockfiles = await detectNestedLockfiles({
    repoRoot: opts.repoRoot,
    packages: discovery.packages,
  });
  const packageManagerConflicts = detectPackageManagerConflicts({
    lockfiles: [...rootLockfiles, ...nestedLockfiles],
  });
  const runtimeManifests = await detectRuntimeManifests({
    repoRoot: opts.repoRoot,
  });
  const runtimePins = await detectRuntimePins({ repoRoot: opts.repoRoot });
  const hasRootPackageJson = await pathExists(
    resolve(opts.repoRoot, "package.json")
  );
  const envFiles = await detectEnvFiles({ repoRoot: opts.repoRoot });
  const composeFiles = await detectComposeFiles({
    repoRoot: opts.repoRoot,
    projectContext,
  });
  const dockerfiles = await scanGlobs({
    repoRoot: opts.repoRoot,
    patterns: DOCKERFILE_PATTERNS,
    limit: SCAN_LIMIT,
  });
  const dbSignals = await scanGlobs({
    repoRoot: opts.repoRoot,
    patterns: DB_PATTERNS,
    limit: SCAN_LIMIT,
  });
  const setupScripts = collectSetupScripts({ packages: discovery.packages });
  const limitations = buildLimitations({
    hasRootPackageJson,
    nestedLockfiles,
    packageManagerConflicts,
    runtimeManifests,
    truncatedScans: [
      ...(dockerfiles.length >= SCAN_LIMIT ? ["Dockerfiles"] : []),
      ...(dbSignals.length >= SCAN_LIMIT ? ["DB signals"] : []),
      ...(runtimeManifests.length >= RUNTIME_MANIFEST_LIMIT
        ? ["non-JS manifests"]
        : []),
    ],
  });

  return {
    repoRoot: opts.repoRoot,
    projectContext,
    packageCount: discovery.packages.length,
    isMonorepo: discovery.isMonorepo,
    workspacePatterns: discovery.workspacePatterns,
    discoverySignals: discovery.signals,
    packageManagers: rootLockfiles.map((entry) => entry.path),
    nestedLockfiles,
    packageManagerConflicts,
    runtimeManifests,
    runtimePins,
    envFiles,
    composeFiles,
    dockerfiles,
    dbSignals,
    candidates: discovery.candidates,
    setupScripts,
    limitations,
  };
}

/**
 * Render the pre-computed repo inventory section of the onboarding prompt.
 *
 * This is the only renderer of {@link InitAssistantReport}. Every onboarding
 * entry point (`hack init --with`, `hack agent onboard`, `hack agent init`, and
 * the `hack-init` MCP prompt) reaches it through the shared core renderer in
 * `onboarding-prompt.ts`, so the inventory text cannot fork between them.
 * The returned lines carry no heading and no trailing blank line.
 */
export function renderInitAssistantInventory(opts: {
  readonly report: InitAssistantReport;
}): string[] {
  const lines: string[] = [];

  lines.push("Repo context:");
  lines.push(`- Root: ${opts.report.repoRoot}`);
  lines.push(`- Hack config: ${formatHackContext({ report: opts.report })}`);
  lines.push(
    `- Packages: ${opts.report.packageCount} (${opts.report.isMonorepo ? "monorepo" : "single"})`
  );
  if (opts.report.workspacePatterns.length > 0) {
    lines.push(`- Workspaces: ${opts.report.workspacePatterns.join(", ")}`);
  }
  if (opts.report.discoverySignals.length > 0) {
    lines.push(`- Signals: ${opts.report.discoverySignals.join(", ")}`);
  }
  lines.push("");
  lines.push("Detected files:");
  lines.push(
    formatField({
      label: "Package managers",
      values: opts.report.packageManagers,
    })
  );
  lines.push(
    formatField({
      label: "Nested lockfiles",
      values: opts.report.nestedLockfiles.map((entry) => entry.path),
    })
  );
  lines.push(
    formatField({
      label: "Package manager conflicts",
      values: opts.report.packageManagerConflicts,
    })
  );
  lines.push(
    formatField({
      label: "Non-JS runtimes",
      values: formatRuntimeManifests({ values: opts.report.runtimeManifests }),
    })
  );
  lines.push(
    formatField({ label: "Runtime pins", values: opts.report.runtimePins })
  );
  lines.push(formatField({ label: "Env files", values: opts.report.envFiles }));
  lines.push(
    formatField({
      label: "Compose files",
      values: formatComposeFiles({ values: opts.report.composeFiles }),
    })
  );
  lines.push(
    formatField({ label: "Dockerfiles", values: opts.report.dockerfiles })
  );
  lines.push(
    formatField({ label: "DB signals", values: opts.report.dbSignals })
  );
  lines.push("");
  lines.push("Dev scripts (service candidates):");
  if (opts.report.candidates.length === 0) {
    lines.push("- none detected");
  } else {
    for (const candidate of opts.report.candidates) {
      lines.push(`- ${formatCandidate({ candidate })}`);
    }
  }
  lines.push("");
  lines.push("Setup scripts (migrations/seeds/etc):");
  if (opts.report.setupScripts.length === 0) {
    lines.push("- none detected");
  } else {
    for (const script of opts.report.setupScripts) {
      lines.push(`- ${formatScriptSignal({ signal: script })}`);
    }
  }
  lines.push("");
  lines.push(
    "Discovery limitations (check these gaps yourself and report the ones that remain):"
  );
  for (const limitation of opts.report.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  lines.push(
    "Resolve these questions from the repo first; ask only for unresolved blockers:"
  );
  for (const question of buildSuggestedQuestions({ report: opts.report })) {
    lines.push(`- ${question}`);
  }

  return lines;
}

const DOCKERFILE_PATTERNS = ["**/Dockerfile", "**/Dockerfile.*"] as const;
const DB_PATTERNS = [
  "**/prisma/schema.prisma",
  "**/drizzle.config.*",
  "**/supabase/config.toml",
  "**/migrations/*.sql",
  "**/migrations/**/*.sql",
  "**/db/schema.sql",
  "**/schema.sql",
] as const;

const SCAN_LIMIT = 12;
const RUNTIME_MANIFEST_LIMIT = 24;

/** Lockfile name to package manager; `bun.lock` is current, `bun.lockb` legacy. */
const LOCKFILE_MANAGERS: readonly (readonly [string, PackageManagerId])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const RUNTIME_MANIFEST_FILES: readonly (readonly [string, RuntimeEcosystem])[] =
  [
    ["Cargo.toml", "rust"],
    ["Cargo.lock", "rust"],
    ["go.mod", "go"],
    ["go.sum", "go"],
    ["go.work", "go"],
    ["pyproject.toml", "python"],
    ["uv.lock", "python"],
    ["poetry.lock", "python"],
    ["requirements.txt", "python"],
    ["Pipfile.lock", "python"],
    ["Gemfile", "ruby"],
    ["Gemfile.lock", "ruby"],
    ["mix.exs", "elixir"],
    ["mix.lock", "elixir"],
  ];

const RUNTIME_MANIFEST_EXTENSIONS: readonly (readonly [
  string,
  RuntimeEcosystem,
])[] = [
  [".csproj", "dotnet"],
  [".fsproj", "dotnet"],
  [".sln", "dotnet"],
];

/** Root, plus up to two directory levels below it. */
const RUNTIME_MANIFEST_PATTERNS: readonly string[] = (() => {
  const names = [
    ...RUNTIME_MANIFEST_FILES.map(([name]) => name),
    ...RUNTIME_MANIFEST_EXTENSIONS.map(([extension]) => `*${extension}`),
  ].join(",");
  return ["", "*/", "*/*/"].map((prefix) => `${prefix}{${names}}`);
})();

/** Runtime pin files checked at the repo root by name only. */
const RUNTIME_PIN_FILES = [
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
  ".bun-version",
  ".python-version",
  ".ruby-version",
  ".go-version",
  "rust-toolchain",
  "rust-toolchain.toml",
  "global.json",
] as const;

/** Root `package.json` keys that pin a runtime or package manager. */
const PACKAGE_JSON_PIN_KEYS = ["engines", "packageManager", "volta"] as const;

const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.example",
  ".env.sample",
  ".env.template",
] as const;

const IGNORE_PREFIXES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  ".output/",
  ".cache/",
  "coverage/",
  ".hack/",
] as const;

const COMPOSE_PATTERNS = [
  "**/docker-compose.yml",
  "**/docker-compose.yaml",
  "**/compose.yml",
  "**/compose.yaml",
] as const;

async function detectLockfiles(opts: {
  readonly repoRoot: string;
  readonly relativeDir: string;
}): Promise<LockfileSignal[]> {
  const found: LockfileSignal[] = [];

  for (const [filename, manager] of LOCKFILE_MANAGERS) {
    const rel =
      opts.relativeDir === "." ? filename : `${opts.relativeDir}/${filename}`;
    if (await pathExists(resolve(opts.repoRoot, rel))) {
      found.push({ path: rel, manager });
    }
  }

  return found;
}

/**
 * Check each discovered workspace package directory for its own lockfile.
 * A nested lockfile usually means that package installs separately from the
 * workspace root, possibly with a different package manager.
 */
async function detectNestedLockfiles(opts: {
  readonly repoRoot: string;
  readonly packages: readonly DiscoveredPackage[];
}): Promise<LockfileSignal[]> {
  const found: LockfileSignal[] = [];
  const dirs = new Set(
    opts.packages
      .map((pkg) => normalizePath({ path: pkg.relativeDir }))
      .filter((dir) => dir !== "." && !shouldIgnorePath({ relPath: `${dir}/` }))
  );

  for (const relativeDir of [...dirs].sort()) {
    found.push(
      ...(await detectLockfiles({ repoRoot: opts.repoRoot, relativeDir }))
    );
  }

  return found;
}

function detectPackageManagerConflicts(opts: {
  readonly lockfiles: readonly LockfileSignal[];
}): PackageManagerId[] {
  const managers = [
    ...new Set(opts.lockfiles.map((entry) => entry.manager)),
  ].sort();
  return managers.length > 1 ? managers : [];
}

async function detectRuntimeManifests(opts: {
  readonly repoRoot: string;
}): Promise<RuntimeManifestSignal[]> {
  const paths = await scanGlobs({
    repoRoot: opts.repoRoot,
    patterns: RUNTIME_MANIFEST_PATTERNS,
    limit: RUNTIME_MANIFEST_LIMIT,
  });

  const found: RuntimeManifestSignal[] = [];
  for (const path of paths) {
    const ecosystem = classifyRuntimeManifest({ path });
    if (ecosystem) {
      found.push({ path, ecosystem });
    }
  }
  return found;
}

function classifyRuntimeManifest(opts: {
  readonly path: string;
}): RuntimeEcosystem | null {
  const name = opts.path.split("/").at(-1) ?? "";
  const byName = RUNTIME_MANIFEST_FILES.find(([file]) => file === name);
  if (byName) {
    return byName[1];
  }
  const byExtension = RUNTIME_MANIFEST_EXTENSIONS.find(([extension]) =>
    name.endsWith(extension)
  );
  return byExtension ? byExtension[1] : null;
}

/**
 * Detect runtime pins by name. Pin files are checked for existence only;
 * `package.json` contributes the names of pinning keys, never their values.
 */
async function detectRuntimePins(opts: {
  readonly repoRoot: string;
}): Promise<string[]> {
  const found: string[] = [];

  for (const filename of RUNTIME_PIN_FILES) {
    if (await pathExists(resolve(opts.repoRoot, filename))) {
      found.push(filename);
    }
  }

  const keys = await readPackageJsonKeys({
    absolutePath: resolve(opts.repoRoot, "package.json"),
  });
  for (const key of PACKAGE_JSON_PIN_KEYS) {
    if (keys.has(key)) {
      found.push(`package.json#${key}`);
    }
  }

  return found;
}

async function readPackageJsonKeys(opts: {
  readonly absolutePath: string;
}): Promise<ReadonlySet<string>> {
  const text = await readTextFile(opts.absolutePath);
  if (!text) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return new Set();
  }
  return isRecord(parsed) ? new Set(Object.keys(parsed)) : new Set();
}

/**
 * State what this inventory did not cover. The first two entries always
 * apply; the rest describe gaps detected in this repo.
 */
function buildLimitations(opts: {
  readonly hasRootPackageJson: boolean;
  readonly nestedLockfiles: readonly LockfileSignal[];
  readonly packageManagerConflicts: readonly PackageManagerId[];
  readonly runtimeManifests: readonly RuntimeManifestSignal[];
  readonly truncatedScans: readonly string[];
}): string[] {
  const limitations = [
    "Inventory reads file names and manifest keys only; env files, secrets, lockfile contents, and pin values were not read.",
    "Lockfiles were checked at the repo root and in discovered workspace package directories; non-JS manifests at the root and up to two directory levels below it.",
  ];

  if (!opts.hasRootPackageJson) {
    limitations.push(
      "No root package.json: JavaScript workspace, script, and service discovery found nothing at the root."
    );
  }
  if (opts.packageManagerConflicts.length > 0) {
    limitations.push(
      `Lockfiles from more than one package manager (${opts.packageManagerConflicts.join(", ")}): confirm which one CI uses; do not delete or regenerate another manager's lockfile to resolve it.`
    );
  }
  if (opts.nestedLockfiles.length > 0) {
    limitations.push(
      "Nested lockfiles mean those packages may install separately from the workspace root; confirm how each one installs before sharing a dependency volume."
    );
  }
  const ecosystems = [
    ...new Set(opts.runtimeManifests.map((entry) => entry.ecosystem)),
  ].sort();
  if (ecosystems.length > 0) {
    limitations.push(
      `Service candidates and setup scripts come from package.json scripts only; entrypoints, ports, and setup steps for ${ecosystems.join(", ")} were not inferred.`
    );
  }
  if (opts.truncatedScans.length > 0) {
    limitations.push(
      `Scan results were capped for ${opts.truncatedScans.join(", ")}; more matches may exist.`
    );
  }

  return limitations;
}

async function detectEnvFiles(opts: {
  readonly repoRoot: string;
}): Promise<string[]> {
  const found: string[] = [];

  for (const filename of ENV_FILES) {
    const path = resolve(opts.repoRoot, filename);
    if (await pathExists(path)) {
      found.push(filename);
    }
  }

  return found;
}

async function detectComposeFiles(opts: {
  readonly repoRoot: string;
  readonly projectContext: ProjectContext | null;
}): Promise<ComposeSignal[]> {
  const seen = new Set<string>();
  const out: ComposeSignal[] = [];

  if (opts.projectContext) {
    const rel = normalizePath({
      path: relative(opts.repoRoot, opts.projectContext.composeFile),
    });
    const services = await readComposeServices({
      absolutePath: opts.projectContext.composeFile,
    });
    seen.add(rel);
    out.push({ path: rel, services });
  }

  const discovered = await scanGlobs({
    repoRoot: opts.repoRoot,
    patterns: COMPOSE_PATTERNS,
    limit: 12,
  });

  for (const rel of discovered) {
    if (seen.has(rel)) {
      continue;
    }
    const abs = resolve(opts.repoRoot, rel);
    const services = await readComposeServices({ absolutePath: abs });
    out.push({ path: rel, services });
    seen.add(rel);
  }

  return out;
}

async function readComposeServices(opts: {
  readonly absolutePath: string;
}): Promise<string[]> {
  const text = await readTextFile(opts.absolutePath);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text) as unknown;
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }

  return Object.keys(servicesRaw).sort();
}

async function scanGlobs(opts: {
  readonly repoRoot: string;
  readonly patterns: readonly string[];
  readonly limit: number;
}): Promise<string[]> {
  const found = new Set<string>();

  for (const pattern of opts.patterns) {
    if (found.size >= opts.limit) {
      break;
    }

    const glob = new Glob(pattern);
    for await (const rel of glob.scan({
      cwd: opts.repoRoot,
      onlyFiles: true,
      dot: false,
    })) {
      const normalized = normalizePath({ path: rel });
      if (shouldIgnorePath({ relPath: normalized })) {
        continue;
      }
      found.add(normalized);
      if (found.size >= opts.limit) {
        break;
      }
    }
  }

  return [...found].sort();
}

function shouldIgnorePath(opts: { readonly relPath: string }): boolean {
  const normalized = normalizePath({ path: opts.relPath });
  return IGNORE_PREFIXES.some(
    (prefix) =>
      normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)
  );
}

function normalizePath(opts: { readonly path: string }): string {
  return opts.path.replaceAll("\\", "/");
}

function collectSetupScripts(opts: {
  readonly packages: readonly DiscoveredPackage[];
}): ScriptSignal[] {
  const results: ScriptSignal[] = [];

  for (const pkg of opts.packages) {
    for (const [scriptName, scriptCommand] of pkg.scripts.entries()) {
      if (!isSetupScript({ scriptName, scriptCommand })) {
        continue;
      }
      results.push({
        packageId: pkg.id,
        packageRelativeDir: pkg.relativeDir,
        packageName: pkg.packageName,
        scriptName,
        scriptCommand,
      });
    }
  }

  return results;
}

function isSetupScript(opts: {
  readonly scriptName: string;
  readonly scriptCommand: string;
}): boolean {
  const name = opts.scriptName.toLowerCase();
  const cmd = opts.scriptCommand.toLowerCase();

  if (name === "db" || name.startsWith("db:") || name.startsWith("db-")) {
    return true;
  }
  if (name.includes("migrate") || name.includes("migration")) {
    return true;
  }
  if (name.includes("seed")) {
    return true;
  }
  if (name.includes("prisma") || name.includes("drizzle")) {
    return true;
  }
  if (name.includes("typeorm") || name.includes("knex")) {
    return true;
  }
  if (name.includes("flyway")) {
    return true;
  }

  if (cmd.includes("prisma") || cmd.includes("drizzle")) {
    return true;
  }
  if (cmd.includes("typeorm") || cmd.includes("knex")) {
    return true;
  }
  if (cmd.includes("flyway") || cmd.includes("alembic")) {
    return true;
  }

  return false;
}

function formatHackContext(opts: {
  readonly report: InitAssistantReport;
}): string {
  if (!opts.report.projectContext) {
    return "not found";
  }

  const relDir = normalizePath({
    path: relative(opts.report.repoRoot, opts.report.projectContext.projectDir),
  });
  const relCompose = normalizePath({
    path: relative(
      opts.report.repoRoot,
      opts.report.projectContext.composeFile
    ),
  });
  return `${relDir} (compose: ${relCompose})`;
}

function formatField(opts: {
  readonly label: string;
  readonly values: readonly string[] | string;
}): string {
  const content = Array.isArray(opts.values)
    ? formatList({ values: opts.values })
    : opts.values;
  return `- ${opts.label}: ${content}`;
}

function formatList(opts: { readonly values: readonly string[] }): string {
  if (opts.values.length === 0) {
    return "none detected";
  }
  return opts.values.join(", ");
}

function formatComposeFiles(opts: {
  readonly values: readonly ComposeSignal[];
}): string[] {
  if (opts.values.length === 0) {
    return [];
  }
  return opts.values.map((entry) => {
    if (entry.services.length === 0) {
      return entry.path;
    }
    return `${entry.path} (services: ${entry.services.join(", ")})`;
  });
}

function formatRuntimeManifests(opts: {
  readonly values: readonly RuntimeManifestSignal[];
}): string[] {
  const byEcosystem = new Map<RuntimeEcosystem, string[]>();
  for (const entry of opts.values) {
    const paths = byEcosystem.get(entry.ecosystem) ?? [];
    paths.push(entry.path);
    byEcosystem.set(entry.ecosystem, paths);
  }
  return [...byEcosystem.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ecosystem, paths]) => `${ecosystem} (${paths.join(", ")})`);
}

function formatCandidate(opts: {
  readonly candidate: ServiceCandidate;
}): string {
  const location =
    opts.candidate.packageRelativeDir === "."
      ? "root"
      : opts.candidate.packageRelativeDir;
  const pkgLabel = opts.candidate.packageName
    ? `${location} (${opts.candidate.packageName})`
    : location;
  return `${pkgLabel}: ${opts.candidate.scriptName} -> ${opts.candidate.scriptCommand}`;
}

function formatScriptSignal(opts: { readonly signal: ScriptSignal }): string {
  const location =
    opts.signal.packageRelativeDir === "."
      ? "root"
      : opts.signal.packageRelativeDir;
  const pkgLabel = opts.signal.packageName
    ? `${location} (${opts.signal.packageName})`
    : location;
  return `${pkgLabel}: ${opts.signal.scriptName} -> ${opts.signal.scriptCommand}`;
}

function buildSuggestedQuestions(opts: {
  readonly report: InitAssistantReport;
}): string[] {
  const questions: string[] = [
    "Which service should be exposed on DEV_HOST?",
    "Are there extra services (db/cache/queue) that must be included?",
    "Which env vars/secrets are required for dev?",
    "Any one-time setup steps before running the app?",
  ];

  if (opts.report.candidates.length === 0) {
    questions.push("Which command starts the main app locally?");
  }
  if (opts.report.packageManagerConflicts.length > 0) {
    questions.push("Which package manager and lockfile does CI install with?");
  }
  if (opts.report.runtimeManifests.length > 0) {
    questions.push(
      "Which commands build and start the non-JS services, and which ports do they use?"
    );
  }

  return questions;
}
