import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { logger } from "../ui/logger.ts";
import { TODO_IMAGE_PLACEHOLDER, TODO_IMAGE_SENTINEL } from "./compose.ts";
import type { DiscoveredPackage, ServiceCandidate } from "./discovery.ts";
import { scoreDevScript } from "./discovery.ts";
import { buildSuggestedCommand } from "./heuristics.ts";

/**
 * A single discovery-time finding surfaced during `hack init`. Each variant
 * carries enough structured data to render both a human warning line
 * (`describeFinding`) and, where relevant, a compose comment.
 */
export type InitDiscoveryFinding =
  | {
      readonly kind: "duplicate-script";
      readonly packageRelativeDir: string;
      readonly keptScriptName: string;
      readonly droppedScriptName: string;
    }
  | {
      readonly kind: "port-reassigned";
      readonly serviceName: string;
      readonly fromPort: number;
      readonly toPort: number;
    }
  | {
      readonly kind: "unknown-runtime";
      readonly serviceName: string;
      readonly runtime: PackageRuntime;
    }
  | {
      readonly kind: "backing-service";
      readonly serviceKind: BackingServiceKind;
      readonly evidence: readonly string[];
      readonly alreadyContainerized: boolean;
    }
  | {
      readonly kind: "existing-compose-found";
      readonly path: string;
    };

export type PackageRuntime =
  | "dotnet"
  | "go"
  | "rust"
  | "python"
  | "elixir"
  | "ruby";

export type BackingServiceKind =
  | "postgres"
  | "mysql"
  | "redis"
  | "temporal"
  | "kafka"
  | "rabbitmq"
  | "mongodb";

const RUNTIME_MARKER_FILES: ReadonlyMap<string, PackageRuntime> = new Map([
  [".csproj", "dotnet"],
  [".fsproj", "dotnet"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["mix.exs", "elixir"],
  ["Gemfile", "ruby"],
]);

const RUNTIME_COMMAND_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly runtime: PackageRuntime;
}> = [
  { pattern: /\bdotnet\s/i, runtime: "dotnet" },
  { pattern: /\bgo run\b/i, runtime: "go" },
  { pattern: /\bcargo\s/i, runtime: "rust" },
  { pattern: /\bpython\s/i, runtime: "python" },
  { pattern: /\bmix\s/i, runtime: "elixir" },
];

const DEPENDENCY_TO_BACKING_SERVICE: ReadonlyMap<string, BackingServiceKind> =
  new Map([
    ["pg", "postgres"],
    ["postgres", "postgres"],
    ["mysql2", "mysql"],
    ["ioredis", "redis"],
    ["redis", "redis"],
    ["bullmq", "redis"],
    ["kafkajs", "kafka"],
    ["amqplib", "rabbitmq"],
    ["mongodb", "mongodb"],
    ["mongoose", "mongodb"],
  ]);

const TEMPORAL_DEPENDENCY_PREFIX = "@temporalio/";

const ENV_KEY_TO_BACKING_SERVICE: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly kind: BackingServiceKind;
}> = [
  { pattern: /^DATABASE_URL$/, kind: "postgres" },
  { pattern: /^POSTGRES_/, kind: "postgres" },
  { pattern: /^MYSQL_/, kind: "mysql" },
  { pattern: /^REDIS(_URL)?$|^REDIS_/, kind: "redis" },
  { pattern: /^TEMPORAL_/, kind: "temporal" },
  { pattern: /^MONGO/, kind: "mongodb" },
  { pattern: /^KAFKA_/, kind: "kafka" },
  { pattern: /^(AMQP|RABBIT)/, kind: "rabbitmq" },
];

const ENV_FILE_NAMES = [".env", ".env.example", ".env.local.example"] as const;

const BACKING_SERVICE_SUGGESTIONS: ReadonlyMap<BackingServiceKind, string> =
  new Map([
    [
      "postgres",
      "add a postgres service + volume, or point env at an existing instance",
    ],
    [
      "mysql",
      "add a mysql service + volume, or point env at an existing instance",
    ],
    ["redis", "add a redis service, or point env at an existing instance"],
    [
      "temporal",
      "add a temporal dev-server service, or point env at an existing instance",
    ],
    [
      "kafka",
      "add a kafka (or redpanda) service, or point env at an existing broker",
    ],
    ["rabbitmq", "add a rabbitmq service, or point env at an existing broker"],
    [
      "mongodb",
      "add a mongodb service + volume, or point env at an existing instance",
    ],
  ]);

/**
 * Drop lower-scored dev-script candidates within the same package, keeping
 * only the single best-scoring script (per `scoreDevScript`'s ordering).
 * Prevents `web` + `web-2` duplicate services when a package defines both
 * `dev` and `start`.
 */
export function dedupeCandidatesByPackage(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): {
  readonly selected: readonly ServiceCandidate[];
  readonly dropped: readonly {
    readonly candidate: ServiceCandidate;
    readonly keptScriptName: string;
  }[];
} {
  const byPackage = new Map<string, ServiceCandidate[]>();
  for (const candidate of opts.candidates) {
    const bucket = byPackage.get(candidate.packageId);
    if (bucket) {
      bucket.push(candidate);
    } else {
      byPackage.set(candidate.packageId, [candidate]);
    }
  }

  const selected: ServiceCandidate[] = [];
  const dropped: { candidate: ServiceCandidate; keptScriptName: string }[] = [];

  for (const bucket of byPackage.values()) {
    const ranked = [...bucket].sort(
      (a, b) => scoreDevScript(b.scriptName) - scoreDevScript(a.scriptName)
    );
    const best = ranked[0];
    if (!best) {
      continue;
    }
    selected.push(best);
    for (const candidate of ranked.slice(1)) {
      dropped.push({ candidate, keptScriptName: best.scriptName });
    }
  }

  return { selected, dropped };
}

const WORKSPACE_FILTER_PATTERNS: readonly RegExp[] = [
  /--filter[= ]([^\s]+)/i,
  /--cwd[= ]([^\s]+)/i,
  /--project[= ]([^\s]+)/i,
  /--prefix[= ]([^\s]+)/i,
];

/**
 * Best-effort extraction of a workspace-relative directory (or package
 * name fragment) that a root-level aggregator script command appears to
 * delegate to — e.g. `turbo run dev --filter=web`, `dotnet run --project
 * apps/backend/Api.csproj`, `pnpm --cwd apps/web dev`.
 */
function extractDelegationTarget(scriptCommand: string): string | null {
  for (const pattern of WORKSPACE_FILTER_PATTERNS) {
    const match = scriptCommand.match(pattern);
    const raw = match?.[1];
    if (raw) {
      return raw.replaceAll(/["']/g, "");
    }
  }
  return null;
}

/**
 * Indexes non-root candidates by both their package directory basename and
 * package name (lowercased) so a root aggregator script's delegation
 * target can be resolved against either.
 */
function buildNonRootTargetIndex(
  candidates: readonly ServiceCandidate[]
): ReadonlyMap<string, ServiceCandidate> {
  const nonRootByTarget = new Map<string, ServiceCandidate>();

  for (const candidate of candidates) {
    if (candidate.packageRelativeDir === ".") {
      continue;
    }
    const dirBase = basename(candidate.packageRelativeDir).toLowerCase();
    if (!nonRootByTarget.has(dirBase)) {
      nonRootByTarget.set(dirBase, candidate);
    }
    if (!candidate.packageName) {
      continue;
    }
    const nameKey = candidate.packageName.toLowerCase();
    if (!nonRootByTarget.has(nameKey)) {
      nonRootByTarget.set(nameKey, candidate);
    }
  }

  return nonRootByTarget;
}

/**
 * Resolves the workspace candidate a root-level aggregator script appears
 * to delegate to, using either an explicit `--filter`/`--cwd`/`--project`
 * reference or the `dev:<suffix>` naming convention.
 */
/**
 * Candidate lookup keys for a delegation target, most specific first: the
 * raw key, its basename (handles path-like targets such as `apps/web`),
 * and — when the target looks like a file (`Api.csproj`) — the basename of
 * its parent directory (handles `--project backend/Api.csproj`).
 */
function delegationLookupKeys(targetKey: string): readonly string[] {
  const keys = [targetKey, basename(targetKey)];
  if (FILE_EXTENSION_PATTERN.test(basename(targetKey))) {
    const parent = targetKey.split("/").slice(0, -1).join("/");
    if (parent.length > 0) {
      keys.push(basename(parent));
    }
  }
  return keys;
}

function resolveAggregatorTargetCandidate(opts: {
  readonly candidate: ServiceCandidate;
  readonly nonRootByTarget: ReadonlyMap<string, ServiceCandidate>;
}): ServiceCandidate | null {
  const delegationTarget = extractDelegationTarget(
    opts.candidate.scriptCommand
  );
  const scriptSuffix = opts.candidate.scriptName.includes(":")
    ? opts.candidate.scriptName.split(":").slice(1).join(":")
    : null;

  const targetKey = (delegationTarget ?? scriptSuffix)?.toLowerCase();
  if (!targetKey) {
    return null;
  }

  for (const key of delegationLookupKeys(targetKey)) {
    const match = opts.nonRootByTarget.get(key);
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Detects root-package "aggregator" scripts that just delegate to another
 * discovered package's own dev script (e.g. root `dev:web` running
 * `turbo run dev --filter=web` while `apps/web` already has its own `dev`
 * candidate, or `dev:backend` running `dotnet run --project apps/backend`
 * while `apps/backend` is itself a discovered package). These produce a
 * true duplicate service (`web` + `web-2`) even though they live in
 * different packages, so per-package dedupe alone can't catch them.
 *
 * A root candidate is dropped when:
 * - it belongs to the repo-root package (`packageRelativeDir === "."`), and
 * - its command references another discovered package's relative dir (via
 *   `--filter`/`--cwd`/`--project`/`--prefix`) or its own script name
 *   (after the `dev:` prefix) matches another package's directory
 *   basename or package name, and
 * - that other package already has its own qualifying candidate.
 */
export function dedupeAggregatorCandidates(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): {
  readonly selected: readonly ServiceCandidate[];
  readonly dropped: readonly {
    readonly candidate: ServiceCandidate;
    readonly keptScriptName: string;
  }[];
} {
  const nonRootByTarget = buildNonRootTargetIndex(opts.candidates);

  const dropped: { candidate: ServiceCandidate; keptScriptName: string }[] = [];
  const droppedIds = new Set<string>();

  for (const candidate of opts.candidates) {
    if (candidate.packageRelativeDir !== ".") {
      continue;
    }

    const targetCandidate = resolveAggregatorTargetCandidate({
      candidate,
      nonRootByTarget,
    });
    if (!targetCandidate) {
      continue;
    }

    dropped.push({ candidate, keptScriptName: targetCandidate.scriptName });
    droppedIds.add(candidate.id);
  }

  const selected = opts.candidates.filter((c) => !droppedIds.has(c.id));
  return { selected, dropped };
}

/**
 * Full candidate dedupe pipeline: first drops root-level aggregator scripts
 * that delegate to another package's own dev script
 * (`dedupeAggregatorCandidates`), then collapses same-package duplicates
 * (`dedupeCandidatesByPackage`). Returns the final selected set plus one
 * `duplicate-script` finding per dropped candidate from either pass.
 */
export function dedupeCandidates(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): {
  readonly selected: readonly ServiceCandidate[];
  readonly findings: readonly InitDiscoveryFinding[];
} {
  const aggregatorPass = dedupeAggregatorCandidates({
    candidates: opts.candidates,
  });
  const packagePass = dedupeCandidatesByPackage({
    candidates: aggregatorPass.selected,
  });

  const findings: InitDiscoveryFinding[] = [
    ...aggregatorPass.dropped.map(({ candidate, keptScriptName }) => ({
      kind: "duplicate-script" as const,
      packageRelativeDir: candidate.packageRelativeDir,
      keptScriptName,
      droppedScriptName: candidate.scriptName,
    })),
    ...packagePass.dropped.map(({ candidate, keptScriptName }) => ({
      kind: "duplicate-script" as const,
      packageRelativeDir: candidate.packageRelativeDir,
      keptScriptName,
      droppedScriptName: candidate.scriptName,
    })),
  ];

  return { selected: packagePass.selected, findings };
}

/** Minimal shape validation.ts needs from a built compose draft to detect port collisions. */
export interface PortCollisionDraft {
  readonly name: string;
  readonly role: "http" | "internal";
  readonly port?: number;
  readonly candidate: ServiceCandidate;
}

/**
 * Detects HTTP drafts sharing the same internal port and deterministically
 * reassigns duplicates to the next free port (ascending from the collision),
 * mutating `port` on the drafts in place and returning the new command for
 * each reassigned draft plus a finding per reassignment.
 *
 * Deterministic order: drafts are processed in input order; the first
 * draft to claim a port keeps it, subsequent claimants walk upward until
 * they find a port unused by any other draft.
 */
export function reassignCollidingPorts(opts: {
  readonly drafts: readonly PortCollisionDraft[];
}): {
  readonly reassignments: ReadonlyMap<
    string,
    { readonly port: number; readonly command: string }
  >;
  readonly findings: readonly InitDiscoveryFinding[];
} {
  const reassignments = new Map<
    string,
    { readonly port: number; readonly command: string }
  >();
  const findings: InitDiscoveryFinding[] = [];
  const claimed = new Set<number>();

  for (const draft of opts.drafts) {
    if (draft.role !== "http" || draft.port === undefined) {
      continue;
    }

    if (!claimed.has(draft.port)) {
      claimed.add(draft.port);
      continue;
    }

    const nextPort = findNextFreePort({ from: draft.port, claimed });
    claimed.add(nextPort);

    const command = buildSuggestedCommand({
      candidate: draft.candidate,
      role: "http",
      port: nextPort,
    });

    reassignments.set(draft.name, { port: nextPort, command });
    findings.push({
      kind: "port-reassigned",
      serviceName: draft.name,
      fromPort: draft.port,
      toPort: nextPort,
    });
  }

  return { reassignments, findings };
}

function findNextFreePort(opts: {
  readonly from: number;
  readonly claimed: ReadonlySet<number>;
}): number {
  let candidate = opts.from + 1;
  while (opts.claimed.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

const PROJECT_PATH_PATTERN = /--project[= ]([^\s]+)/i;
const FILE_EXTENSION_PATTERN = /\.[a-z]+$/i;
const PRISMA_PROVIDER_PATTERN = /provider\s*=\s*"([a-z]+)"/i;

/**
 * Best-effort language/runtime detection for a discovered package: looks
 * for marker files (`*.csproj`, `go.mod`, `Cargo.toml`, ...) in the package
 * directory, then falls back to sniffing the script command text. For
 * root-level aggregator scripts whose command targets another directory
 * (e.g. `dotnet run --project apps/backend/Api.csproj`), also checks marker
 * files in that referenced directory when `repoRoot` is provided — this is
 * what catches a root `dev:backend` aggregator that never had its own
 * package directory to inspect. Returns `null` for JS/TS packages (the
 * default assumption).
 */
export async function detectPackageRuntime(opts: {
  readonly dir: string;
  readonly scriptCommand?: string;
  readonly repoRoot?: string;
}): Promise<PackageRuntime | null> {
  const fromFiles = await detectRuntimeFromMarkerFiles({ dir: opts.dir });
  if (fromFiles) {
    return fromFiles;
  }

  if (opts.scriptCommand && opts.repoRoot) {
    const fromTarget = await detectRuntimeFromReferencedTarget({
      repoRoot: opts.repoRoot,
      scriptCommand: opts.scriptCommand,
    });
    if (fromTarget) {
      return fromTarget;
    }
  }

  if (opts.scriptCommand) {
    for (const { pattern, runtime } of RUNTIME_COMMAND_PATTERNS) {
      if (pattern.test(opts.scriptCommand)) {
        return runtime;
      }
    }
  }

  return null;
}

/**
 * Resolves a `--project <path>` (or similar) reference in an aggregator
 * script command to a repo-relative directory and checks it for runtime
 * marker files. Handles both directory references (`apps/backend`) and
 * project-file references (`apps/backend/Api.csproj`).
 */
async function detectRuntimeFromReferencedTarget(opts: {
  readonly repoRoot: string;
  readonly scriptCommand: string;
}): Promise<PackageRuntime | null> {
  const match = opts.scriptCommand.match(PROJECT_PATH_PATTERN);
  const rawTarget = match?.[1]?.replaceAll(/["']/g, "");
  if (!rawTarget) {
    return null;
  }

  const targetPath = resolve(opts.repoRoot, rawTarget);
  const looksLikeFile = FILE_EXTENSION_PATTERN.test(basename(rawTarget));
  const targetDir = looksLikeFile ? resolve(targetPath, "..") : targetPath;

  if (looksLikeFile) {
    const fileRuntime = RUNTIME_MARKER_FILES.get(
      `.${basename(rawTarget).split(".").pop()}`
    );
    if (fileRuntime && (await pathExists(targetPath))) {
      return fileRuntime;
    }
  }

  return await detectRuntimeFromMarkerFiles({ dir: targetDir });
}

async function detectRuntimeFromMarkerFiles(opts: {
  readonly dir: string;
}): Promise<PackageRuntime | null> {
  let entries: string[];
  try {
    entries = await readdir(opts.dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    for (const [suffix, runtime] of RUNTIME_MARKER_FILES) {
      if (suffix.startsWith(".") ? entry.endsWith(suffix) : entry === suffix) {
        return runtime;
      }
    }
  }

  return null;
}

/** A single detected backing-service signal with its evidence trail. */
export interface BackingServiceDetection {
  readonly kind: BackingServiceKind;
  readonly evidence: readonly string[];
  readonly alreadyContainerized: boolean;
}

/**
 * Scans package.json dependencies and .env / .env-example files (key names
 * only — values are never read into findings) across the repo root and
 * every discovered package for signals of external backing services
 * (postgres, redis, temporal, etc). Also checks for an existing
 * docker-compose file already referencing these images. Results are
 * deduped to one entry per service kind with accumulated evidence.
 */
export async function detectBackingServices(opts: {
  readonly repoRoot: string;
  readonly packages: readonly DiscoveredPackage[];
}): Promise<readonly BackingServiceDetection[]> {
  const evidenceByKind = new Map<BackingServiceKind, string[]>();

  const addEvidence = (kind: BackingServiceKind, note: string): void => {
    const bucket = evidenceByKind.get(kind);
    if (bucket) {
      if (!bucket.includes(note)) {
        bucket.push(note);
      }
    } else {
      evidenceByKind.set(kind, [note]);
    }
  };

  for (const pkg of opts.packages) {
    await collectDependencyEvidence({ pkg, addEvidence });
    await collectEnvFileEvidence({ dir: pkg.dir, addEvidence });
  }

  const alreadyContainerized = await hasExistingComposeWithBackingServices({
    repoRoot: opts.repoRoot,
    kinds: [...evidenceByKind.keys()],
  });

  return [...evidenceByKind.entries()].map(([kind, evidence]) => ({
    kind,
    evidence,
    alreadyContainerized: alreadyContainerized.has(kind),
  }));
}

async function collectDependencyEvidence(opts: {
  readonly pkg: DiscoveredPackage;
  readonly addEvidence: (kind: BackingServiceKind, note: string) => void;
}): Promise<void> {
  const text = await readTextFile(opts.pkg.packageJsonPath);
  if (!text) {
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return;
  }
  if (!isRecord(data)) {
    return;
  }

  const depNames = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = data[field];
    if (isRecord(deps)) {
      for (const name of Object.keys(deps)) {
        depNames.add(name);
      }
    }
  }

  for (const dep of depNames) {
    const kind = DEPENDENCY_TO_BACKING_SERVICE.get(dep);
    if (kind) {
      opts.addEvidence(kind, `dependency "${dep}" in ${opts.pkg.relativeDir}`);
    }
    if (dep.startsWith(TEMPORAL_DEPENDENCY_PREFIX)) {
      opts.addEvidence(
        "temporal",
        `dependency "${dep}" in ${opts.pkg.relativeDir}`
      );
    }
    if (dep === "prisma" || dep === "@prisma/client") {
      const provider = await detectPrismaProvider({ dir: opts.pkg.dir });
      if (provider) {
        opts.addEvidence(
          provider,
          `prisma schema provider in ${opts.pkg.relativeDir}`
        );
      }
    }
  }
}

const PRISMA_PROVIDER_TO_BACKING_SERVICE: ReadonlyMap<
  string,
  BackingServiceKind
> = new Map([
  ["postgresql", "postgres"],
  ["postgres", "postgres"],
  ["mysql", "mysql"],
  ["mongodb", "mongodb"],
]);

async function detectPrismaProvider(opts: {
  readonly dir: string;
}): Promise<BackingServiceKind | null> {
  const schemaPath = resolve(opts.dir, "prisma/schema.prisma");
  const text = await readTextFile(schemaPath);
  if (!text) {
    return null;
  }
  const match = text.match(PRISMA_PROVIDER_PATTERN);
  const provider = match?.[1]?.toLowerCase();
  if (!provider) {
    return null;
  }
  return PRISMA_PROVIDER_TO_BACKING_SERVICE.get(provider) ?? null;
}

async function collectEnvFileEvidence(opts: {
  readonly dir: string;
  readonly addEvidence: (kind: BackingServiceKind, note: string) => void;
}): Promise<void> {
  for (const fileName of ENV_FILE_NAMES) {
    const path = resolve(opts.dir, fileName);
    const text = await readTextFile(path);
    if (!text) {
      continue;
    }

    for (const line of text.split("\n")) {
      const key = extractEnvKey(line);
      if (!key) {
        continue;
      }
      for (const { pattern, kind } of ENV_KEY_TO_BACKING_SERVICE) {
        if (pattern.test(key)) {
          opts.addEvidence(
            kind,
            `${key} in ${fileName} (${basename(opts.dir)})`
          );
        }
      }
    }
  }
}

function extractEnvKey(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  return trimmed.slice(0, eq).trim();
}

const BACKING_SERVICE_IMAGE_HINTS: ReadonlyMap<
  BackingServiceKind,
  readonly string[]
> = new Map([
  ["postgres", ["postgres"]],
  ["mysql", ["mysql", "mariadb"]],
  ["redis", ["redis"]],
  ["temporal", ["temporal"]],
  ["kafka", ["kafka", "redpanda"]],
  ["rabbitmq", ["rabbitmq"]],
  ["mongodb", ["mongo"]],
]);

const EXISTING_COMPOSE_FILE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

/**
 * Repo-root `docker-compose*.yml`/`compose*.yml` files found alongside the
 * project being initialized (not `.hack/docker-compose.yml`, which hack
 * itself owns). Used both to mark backing-service detections as "already
 * containerized elsewhere" and to surface a standalone pointer finding so
 * agents/humans treat the existing file as ground truth for images/backing
 * services instead of re-deriving them from scratch.
 */
export async function findExistingComposeFiles(opts: {
  readonly repoRoot: string;
}): Promise<readonly string[]> {
  const found: string[] = [];
  for (const fileName of EXISTING_COMPOSE_FILE_NAMES) {
    const path = resolve(opts.repoRoot, fileName);
    if (await pathExists(path)) {
      found.push(path);
    }
  }
  return found;
}

async function hasExistingComposeWithBackingServices(opts: {
  readonly repoRoot: string;
  readonly kinds: readonly BackingServiceKind[];
}): Promise<ReadonlySet<BackingServiceKind>> {
  const found = new Set<BackingServiceKind>();
  if (opts.kinds.length === 0) {
    return found;
  }

  const composeFiles = await findExistingComposeFiles({
    repoRoot: opts.repoRoot,
  });

  for (const path of composeFiles) {
    const text = (await readTextFile(path)) ?? "";
    const lower = text.toLowerCase();
    for (const kind of opts.kinds) {
      const hints = BACKING_SERVICE_IMAGE_HINTS.get(kind) ?? [];
      if (hints.some((hint) => lower.includes(hint))) {
        found.add(kind);
      }
    }
  }

  return found;
}

/**
 * Sentinel image value to assign on a draft when `detectPackageRuntime`
 * reports a non-JS runtime. `renderCompose` (see `./compose.ts`) replaces
 * this with a visibly wrong placeholder image (`alpine:3`) instead of
 * silently defaulting to the bun-node image — the previous silent-wrong-image
 * behavior is exactly what the field report flagged.
 */
export function runtimeTodoImageSentinel(): string {
  return TODO_IMAGE_SENTINEL;
}

/** Renders the compose-comment + warning text for a non-JS runtime finding. */
export function describeUnknownRuntimeComment(opts: {
  readonly serviceName: string;
  readonly runtime: PackageRuntime;
}): string {
  return `TODO(hack-init): ${opts.serviceName} looks like a ${opts.runtime} service — set a matching image and command`;
}

/** Human-readable one-line warning (or info, for dedupe) for a finding. */
export function describeFinding(finding: InitDiscoveryFinding): {
  readonly level: "warn" | "info";
  readonly message: string;
} {
  if (finding.kind === "duplicate-script") {
    return {
      level: "info",
      message: `${finding.packageRelativeDir}: dropped duplicate/aggregator script "${finding.droppedScriptName}" — kept "${finding.keptScriptName}"`,
    };
  }

  if (finding.kind === "port-reassigned") {
    return {
      level: "warn",
      message: `${finding.serviceName}: port ${finding.fromPort} was already taken — reassigned to ${finding.toPort}`,
    };
  }

  if (finding.kind === "unknown-runtime") {
    return {
      level: "warn",
      message: `${finding.serviceName}: looks like a ${finding.runtime} service — using placeholder image "${TODO_IMAGE_PLACEHOLDER}"; set a matching image and command`,
    };
  }

  if (finding.kind === "existing-compose-found") {
    return {
      level: "warn",
      message: `existing compose found at ${finding.path} — treat it as ground truth for backing services and images`,
    };
  }

  const suggestion =
    BACKING_SERVICE_SUGGESTIONS.get(finding.serviceKind) ??
    "review this service manually";
  const containerizedNote = finding.alreadyContainerized
    ? " (already containerized elsewhere)"
    : "";
  return {
    level: "warn",
    message: `backing service "${finding.serviceKind}" detected${containerizedNote} — ${suggestion} (evidence: ${finding.evidence.join(", ")})`,
  };
}

/**
 * Logs one warning (or info, for dedupe notes) per finding via the shared
 * CLI logger. Call after compose generation in both the interactive and
 * `--auto` init paths.
 */
export function reportInitDiscoveryFindings(opts: {
  readonly findings: readonly InitDiscoveryFinding[];
}): void {
  for (const finding of opts.findings) {
    const { level, message } = describeFinding(finding);
    if (level === "info") {
      logger.info({ message });
    } else {
      logger.warn({ message });
    }
  }
}

/**
 * Compose header comment lines summarizing backing-service detections and
 * any existing repo-root compose file found alongside the generated one.
 * Used as `ComposePlan.headerComments` (see `./compose.ts`).
 */
export function buildDiscoveryHeaderComments(opts: {
  readonly detections: readonly BackingServiceDetection[];
  readonly existingComposeFiles?: readonly string[];
}): readonly string[] {
  const lines: string[] = [];

  if (opts.existingComposeFiles && opts.existingComposeFiles.length > 0) {
    lines.push(
      "An existing compose file was found in this repo — treat it as ground",
      "truth for backing-service images/config rather than re-deriving them:"
    );
    for (const path of opts.existingComposeFiles) {
      lines.push(`- ${path}`);
    }
  }

  if (opts.detections.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      "hack-init discovery: possible backing services were detected but not scaffolded.",
      "Review and add services manually, or point env vars at existing instances."
    );

    for (const detection of opts.detections) {
      const suggestion =
        BACKING_SERVICE_SUGGESTIONS.get(detection.kind) ??
        "review this service manually";
      const containerizedNote = detection.alreadyContainerized
        ? " (already containerized elsewhere)"
        : "";
      lines.push(`- ${detection.kind}${containerizedNote}: ${suggestion}`);
    }
  }

  return lines;
}

/** Builds the `existing-compose-found` findings for any repo-root compose files. */
export function buildExistingComposeFindings(opts: {
  readonly existingComposeFiles: readonly string[];
}): readonly InitDiscoveryFinding[] {
  return opts.existingComposeFiles.map((path) => ({
    kind: "existing-compose-found" as const,
    path,
  }));
}
