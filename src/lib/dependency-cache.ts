import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { YAML } from "bun";
import { CliUsageError } from "../cli/command.ts";
import { validateDependencyCacheLayout } from "./dependency-cache-layout.ts";
import { createDependencyCacheProtocol } from "./dependency-cache-protocol.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "./fs.ts";
import { isRecord } from "./guards.ts";
import { discoverDependencyBootstrapServices } from "./registry-credential-preflight.ts";

const CACHE_VOLUME_LABEL = "hack.dependencies.cache-volume";
const LOCKFILES_LABEL = "hack.dependencies.lockfiles";
const RUNTIME_FILES_LABEL = "hack.dependencies.runtime-files";
const DEFAULT_LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
] as const;
const DEFAULT_RUNTIME_FILES = [
  "package.json",
  ".mise.toml",
  "mise.toml",
  ".tool-versions",
  ".node-version",
  ".nvmrc",
] as const;

type DependencyCacheDeclaration = {
  readonly service: string;
  readonly volume: string;
  readonly lockfiles: readonly string[];
  readonly runtimeFiles: readonly string[];
  readonly runtime: Readonly<Record<string, unknown>>;
};

export type DependencyCacheResolution = {
  readonly progressServices?: readonly string[];
  readonly sharingDisabledReason?:
    | "runtime_identity_unresolved"
    | "runtime_platform_unresolved";
  readonly overridePath: string | null;
  readonly fingerprint: string | null;
  readonly volumes: readonly {
    readonly logicalName: string;
    readonly resolvedName: string;
    readonly services: readonly string[];
  }[];
  readonly inputs: readonly string[];
};

/** Only explicitly instrumented initializer services can provide phase observations. */
export function resolveDependencyCacheProgress(opts: {
  readonly cache: DependencyCacheResolution;
  readonly project: string | null | undefined;
  readonly baseProject: string;
}):
  | { readonly project: string; readonly services: readonly string[] }
  | undefined {
  return opts.cache.progressServices?.length
    ? {
        project: opts.project ?? opts.baseProject,
        services: opts.cache.progressServices,
      }
    : undefined;
}

/** Select only installers for cache volumes mounted by the requested consumers. */
export async function resolveDependencyCacheBootstrapServices(opts: {
  readonly composeFile: string;
  readonly cache: DependencyCacheResolution;
  readonly targetServices: readonly string[];
}): Promise<readonly string[]> {
  if (!opts.cache.overridePath) {
    return [];
  }
  const text = await readTextFile(opts.composeFile);
  const parsed: unknown = YAML.parse(text ?? "");
  if (!(isRecord(parsed) && isRecord(parsed.services))) {
    return [];
  }
  const installers = new Set([
    ...(await discoverDependencyBootstrapServices(opts)),
    ...(opts.cache.progressServices ?? []),
  ]);
  const services = parsed.services;
  const requiredVolumes = opts.cache.volumes.filter((volume) =>
    opts.targetServices.some((target) => {
      if (volume.services.includes(target)) {
        return false;
      }
      const service = services[target];
      return (
        isRecord(service) &&
        Array.isArray(service.volumes) &&
        service.volumes.some(
          (mount: unknown) => resolveVolumeSource(mount) === volume.logicalName
        )
      );
    })
  );
  return [
    ...new Set(
      requiredVolumes
        .flatMap((volume) => volume.services)
        .filter((service) => installers.has(service))
    ),
  ].sort();
}

function resolveVolumeSource(mount: unknown): unknown {
  if (typeof mount === "string") {
    return mount.split(":")[0];
  }
  return isRecord(mount) && mount.type === "volume" ? mount.source : null;
}

function parseCsv(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeLabels(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  if (!Array.isArray(value)) {
    return {};
  }
  const labels: Record<string, string> = {};
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator > 0) {
      labels[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return labels;
}

function parseDeclarations(
  parsed: unknown
): readonly DependencyCacheDeclaration[] {
  if (!(isRecord(parsed) && isRecord(parsed.services))) {
    return [];
  }
  const declarations: DependencyCacheDeclaration[] = [];
  for (const [service, rawService] of Object.entries(parsed.services)) {
    if (!isRecord(rawService)) {
      continue;
    }
    const labels = normalizeLabels(rawService.labels);
    const volume = labels[CACHE_VOLUME_LABEL];
    if (
      labels["hack.dependencies.cache-protocol"] !== undefined &&
      !(typeof volume === "string" && volume.trim())
    ) {
      throw new CliUsageError(
        "Dependency cache protocol requires hack.dependencies.cache-volume"
      );
    }
    if (typeof volume !== "string" || volume.trim().length === 0) {
      continue;
    }
    declarations.push({
      service,
      runtime: rawService,
      volume: volume.trim(),
      lockfiles: parseCsv(labels[LOCKFILES_LABEL]),
      runtimeFiles: parseCsv(labels[RUNTIME_FILES_LABEL]),
    });
  }
  return declarations;
}

async function resolveExistingInputs(opts: {
  readonly projectRoot: string;
  readonly declarations: readonly DependencyCacheDeclaration[];
}): Promise<readonly string[]> {
  const configuredLockfiles = opts.declarations.flatMap(
    (entry) => entry.lockfiles
  );
  const configuredRuntimeFiles = opts.declarations.flatMap(
    (entry) => entry.runtimeFiles
  );
  const candidates = [
    ...(configuredLockfiles.length > 0
      ? configuredLockfiles
      : DEFAULT_LOCKFILES),
    ...(configuredRuntimeFiles.length > 0
      ? configuredRuntimeFiles
      : DEFAULT_RUNTIME_FILES),
  ];
  const paths: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    const path = resolve(opts.projectRoot, candidate);
    if (await pathExists(path)) {
      paths.push(path);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function fingerprintFiles(opts: {
  readonly projectRoot: string;
  readonly files: readonly string[];
  readonly runtimeIdentity: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("hack-dependency-cache-v2\0");
  hash.update(opts.runtimeIdentity);
  hash.update("\0");
  for (const file of opts.files) {
    hash.update(file.slice(opts.projectRoot.length));
    hash.update("\0");
    hash.update((await readTextFile(file)) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Canonical declared build configuration, not a digest of the built image/context. */
function canonicalRuntimeValue(value: unknown): string | null {
  if (typeof value === "string") {
    // Compose may resolve interpolation from .env or CLI inputs unavailable here.
    return value.includes("$") ? null : JSON.stringify(value);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = value.map(canonicalRuntimeValue);
    return entries.includes(null) ? null : `[${entries.join(",")}]`;
  }
  if (!isRecord(value)) {
    return null;
  }
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entry = canonicalRuntimeValue(value[key]);
    if (entry === null || key.includes("$")) {
      return null;
    }
    entries.push(`${JSON.stringify(key)}:${entry}`);
  }
  return `{${entries.join(",")}}`;
}

function protocolRuntimeIdentity(
  runtime: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const labels = normalizeLabels(runtime.labels);
  const protocol = labels["hack.dependencies.cache-protocol"];
  if (protocol === undefined) {
    return {};
  }
  return {
    protocol,
    generation: labels["hack.dependencies.cache-generation"] ?? "0",
    verify: labels["hack.dependencies.cache-verify"] ?? null,
    command: runtime.command ?? null,
    entrypoint: runtime.entrypoint ?? null,
    environment: runtime.environment ?? null,
    workingDir: runtime.working_dir ?? null,
  };
}

const PLATFORM_PATTERN = /^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_.-]+)?$/;

function hasUnresolvedBuildArgs(build: unknown): boolean {
  if (!isRecord(build)) {
    return false;
  }
  const args = build.args;
  return (
    (Array.isArray(args) &&
      args.some((arg) => typeof arg !== "string" || !arg.includes("="))) ||
    (isRecord(args) && Object.values(args).some((arg) => arg === null))
  );
}

function declaredRuntimeIdentity(
  declarations: readonly DependencyCacheDeclaration[]
):
  | { readonly identity: string }
  | {
      readonly reason: NonNullable<
        DependencyCacheResolution["sharingDisabledReason"]
      >;
    } {
  const identities: string[] = [];
  for (const declaration of [...declarations].sort((a, b) =>
    a.service.localeCompare(b.service)
  )) {
    const runtime = declaration.runtime;
    const platform = runtime.platform ?? process.env.DOCKER_DEFAULT_PLATFORM;
    if (platform === undefined || platform === "") {
      // Host architecture cannot identify a remote Docker daemon's default.
      return { reason: "runtime_platform_unresolved" };
    }
    if (typeof platform !== "string" || !PLATFORM_PATTERN.test(platform)) {
      return { reason: "runtime_identity_unresolved" };
    }
    if (!(typeof runtime.image === "string" || runtime.build !== undefined)) {
      return { reason: "runtime_identity_unresolved" };
    }
    if (hasUnresolvedBuildArgs(runtime.build)) {
      return { reason: "runtime_identity_unresolved" };
    }
    const identity = canonicalRuntimeValue({
      ...protocolRuntimeIdentity(runtime),
      service: declaration.service,
      volume: declaration.volume,
      image: runtime.image ?? null,
      platform,
      build: runtime.build ?? null,
    });
    if (identity === null) {
      return { reason: "runtime_identity_unresolved" };
    }
    identities.push(identity);
  }
  return { identity: `[${identities.join(",")}]` };
}

function sanitizeVolumeSegment(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]/g, "-")
    .replaceAll(/-+/g, "-");
}

export async function resolveDependencyCacheOverride(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly composeFile: string;
}): Promise<DependencyCacheResolution> {
  const composeText = await readTextFile(opts.composeFile);
  if (!composeText) {
    return { overridePath: null, fingerprint: null, volumes: [], inputs: [] };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(composeText);
  } catch {
    return { overridePath: null, fingerprint: null, volumes: [], inputs: [] };
  }
  const declarations = parseDeclarations(parsed);
  if (declarations.length === 0) {
    return { overridePath: null, fingerprint: null, volumes: [], inputs: [] };
  }
  const protocolDeclarations = declarations.filter(
    (declaration) =>
      normalizeLabels(declaration.runtime.labels)[
        "hack.dependencies.cache-protocol"
      ] !== undefined
  );
  for (const declaration of protocolDeclarations) {
    if (
      declarations.filter((entry) => entry.volume === declaration.volume)
        .length !== 1
    ) {
      throw new CliUsageError(
        "Dependency cache protocol supports one initializer per volume"
      );
    }
    validateDependencyCacheLayout({
      compose: parsed,
      producer: declaration.service,
      volume: declaration.volume,
    });
    createDependencyCacheProtocol({
      service: declaration.runtime,
      volume: declaration.volume,
      fingerprint: "0000000000000000",
      scriptPath: "/hack-dependency-cache-install.sh",
    });
  }
  const runtime = declaredRuntimeIdentity(declarations);
  if ("reason" in runtime) {
    if (protocolDeclarations.length > 0) {
      throw new CliUsageError(
        "Dependency cache protocol requires resolved installer identity and explicit platform"
      );
    }
    return {
      overridePath: null,
      fingerprint: null,
      volumes: [],
      inputs: [],
      sharingDisabledReason: runtime.reason,
    };
  }
  const inputs = await resolveExistingInputs({
    projectRoot: opts.projectRoot,
    declarations,
  });
  if (inputs.length === 0) {
    if (protocolDeclarations.length > 0) {
      throw new CliUsageError(
        "Dependency cache protocol requires existing fingerprint inputs"
      );
    }
    return { overridePath: null, fingerprint: null, volumes: [], inputs: [] };
  }
  const fingerprint = await fingerprintFiles({
    projectRoot: opts.projectRoot,
    files: inputs,
    runtimeIdentity: runtime.identity,
  });
  const grouped = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    const services = grouped.get(declaration.volume) ?? new Set<string>();
    services.add(declaration.service);
    grouped.set(declaration.volume, services);
  }
  const volumes = [...grouped.entries()].map(([logicalName, services]) => ({
    logicalName,
    resolvedName: [
      "hack-cache",
      sanitizeVolumeSegment(opts.projectName),
      sanitizeVolumeSegment(basename(logicalName)),
      fingerprint,
    ].join("-"),
    services: [...services].sort((left, right) => left.localeCompare(right)),
  }));
  const internalDir = resolve(opts.projectDir, ".internal");
  await ensureDir(internalDir);
  const services: Record<string, unknown> = {};
  for (const declaration of protocolDeclarations) {
    const containerScript = "/hack-dependency-cache-install.sh";
    const protocol = createDependencyCacheProtocol({
      service: declaration.runtime,
      volume: declaration.volume,
      fingerprint,
      scriptPath: containerScript,
    });
    if (!protocol) {
      continue;
    }
    const scriptPath = resolve(
      internalDir,
      `dependency-cache-${fingerprint}-${createHash("sha256").update(declaration.service).digest("hex").slice(0, 12)}.sh`
    );
    await writeTextFileIfChanged(scriptPath, protocol.script);
    services[declaration.service] = {
      entrypoint: protocol.entrypoint,
      volumes: [
        {
          type: "bind",
          source: scriptPath,
          target: containerScript,
          read_only: true,
        },
      ],
    };
  }
  const override = {
    ...(protocolDeclarations.length > 0 ? { services } : {}),
    volumes: Object.fromEntries(
      volumes.map((volume) => [
        volume.logicalName,
        { name: volume.resolvedName },
      ])
    ),
  };
  const overridePath = resolve(
    internalDir,
    "compose.dependencies.override.yml"
  );
  await writeTextFileIfChanged(overridePath, YAML.stringify(override));
  return {
    overridePath,
    fingerprint,
    volumes,
    inputs,
    ...(protocolDeclarations.length > 0
      ? { progressServices: protocolDeclarations.map((entry) => entry.service) }
      : {}),
  };
}
