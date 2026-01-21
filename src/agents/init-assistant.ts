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

export type InitAssistantReport = {
  readonly repoRoot: string;
  readonly projectContext: ProjectContext | null;
  readonly packageCount: number;
  readonly isMonorepo: boolean;
  readonly workspacePatterns: readonly string[];
  readonly discoverySignals: readonly string[];
  readonly packageManagers: readonly string[];
  readonly envFiles: readonly string[];
  readonly composeFiles: readonly ComposeSignal[];
  readonly dockerfiles: readonly string[];
  readonly dbSignals: readonly string[];
  readonly candidates: readonly ServiceCandidate[];
  readonly setupScripts: readonly ScriptSignal[];
};

/**
 * Build a report describing repo signals for agent-assisted init.
 */
export async function buildInitAssistantReport(opts: {
  readonly repoRoot: string;
}): Promise<InitAssistantReport> {
  const projectContext = await findProjectContext(opts.repoRoot);
  const discovery = await discoverRepo(opts.repoRoot);

  const packageManagers = await detectPackageManagers({
    repoRoot: opts.repoRoot,
  });
  const envFiles = await detectEnvFiles({ repoRoot: opts.repoRoot });
  const composeFiles = await detectComposeFiles({
    repoRoot: opts.repoRoot,
    projectContext,
  });
  const dockerfiles = await scanGlobs({
    repoRoot: opts.repoRoot,
    patterns: DOCKERFILE_PATTERNS,
    limit: 12,
  });
  const dbSignals = await scanGlobs({
    repoRoot: opts.repoRoot,
    patterns: DB_PATTERNS,
    limit: 12,
  });
  const setupScripts = collectSetupScripts({ packages: discovery.packages });

  return {
    repoRoot: opts.repoRoot,
    projectContext,
    packageCount: discovery.packages.length,
    isMonorepo: discovery.isMonorepo,
    workspacePatterns: discovery.workspacePatterns,
    discoverySignals: discovery.signals,
    packageManagers,
    envFiles,
    composeFiles,
    dockerfiles,
    dbSignals,
    candidates: discovery.candidates,
    setupScripts,
  };
}

/**
 * Render the init assistant prompt based on repo signals.
 */
export function renderInitAssistantPrompt(opts: {
  readonly report: InitAssistantReport;
}): string {
  const lines: string[] = [];

  lines.push("# hack agent init");
  lines.push("");
  lines.push(
    [
      "You are helping a user bootstrap hack in this repo.",
      "Prefer hack CLI; ask before making assumptions.",
    ].join(" ")
  );
  lines.push("");
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
  lines.push("Suggested flow:");
  for (const step of buildSuggestedSteps({ report: opts.report })) {
    lines.push(`- ${step}`);
  }
  lines.push("");
  lines.push("Questions to confirm:");
  for (const question of buildSuggestedQuestions({ report: opts.report })) {
    lines.push(`- ${question}`);
  }
  lines.push("");
  lines.push("Need dependency/ops patterns? Run `hack agent patterns`.");
  lines.push("");

  return lines.join("\n");
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

const PACKAGE_MANAGER_FILES = [
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
] as const;

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

async function detectPackageManagers(opts: {
  readonly repoRoot: string;
}): Promise<string[]> {
  const found: string[] = [];

  for (const filename of PACKAGE_MANAGER_FILES) {
    const path = resolve(opts.repoRoot, filename);
    if (await pathExists(path)) {
      found.push(filename);
    }
  }

  return found;
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

function buildSuggestedSteps(opts: {
  readonly report: InitAssistantReport;
}): string[] {
  const steps: string[] = [
    "Read README/docs to confirm local dev entrypoints and requirements.",
  ];

  if (opts.report.projectContext) {
    steps.push(
      "Review existing .hack config and update services/ports if needed."
    );
  } else {
    const autoHint =
      opts.report.candidates.length > 0
        ? "Run `hack init` (consider `--auto` since dev scripts were detected)."
        : "Run `hack init` and choose manual mode if scripts are unclear.";
    steps.push(autoHint);
  }

  steps.push(
    "Ensure compose includes app + dependencies (db/cache/queue) and correct ports."
  );

  if (opts.report.setupScripts.length > 0) {
    steps.push("Run setup scripts (migrations/seeds) after services are up.");
  }

  steps.push("Start services: `hack up --detach`.");
  steps.push("Verify: `hack ps`, `hack open --json`, `hack logs --pretty`.");

  return steps;
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

  return questions;
}
