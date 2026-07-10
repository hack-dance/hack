import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { YAML } from "bun";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "./fs.ts";
import { isRecord } from "./guards.ts";

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
};

export type DependencyCacheResolution = {
  readonly overridePath: string | null;
  readonly fingerprint: string | null;
  readonly volumes: readonly {
    readonly logicalName: string;
    readonly resolvedName: string;
    readonly services: readonly string[];
  }[];
  readonly inputs: readonly string[];
};

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
    if (typeof volume !== "string" || volume.trim().length === 0) {
      continue;
    }
    declarations.push({
      service,
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
}): Promise<string> {
  const hash = createHash("sha256");
  for (const file of opts.files) {
    hash.update(file.slice(opts.projectRoot.length));
    hash.update("\0");
    hash.update((await readTextFile(file)) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
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
  const inputs = await resolveExistingInputs({
    projectRoot: opts.projectRoot,
    declarations,
  });
  if (inputs.length === 0) {
    return { overridePath: null, fingerprint: null, volumes: [], inputs: [] };
  }
  const fingerprint = await fingerprintFiles({
    projectRoot: opts.projectRoot,
    files: inputs,
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
  const override = {
    volumes: Object.fromEntries(
      volumes.map((volume) => [
        volume.logicalName,
        { name: volume.resolvedName },
      ])
    ),
  };
  const internalDir = resolve(opts.projectDir, ".internal");
  await ensureDir(internalDir);
  const overridePath = resolve(
    internalDir,
    "compose.dependencies.override.yml"
  );
  await writeTextFileIfChanged(overridePath, YAML.stringify(override));
  return { overridePath, fingerprint, volumes, inputs };
}
