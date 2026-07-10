import { resolve } from "node:path";
import { YAML } from "bun";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";

const REGISTRY_CONFIG_FILES = [".npmrc", ".yarnrc.yml", "bunfig.toml"] as const;
const ENV_REFERENCE_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const DEPENDENCY_INSTALL_PATTERN =
  /(?:^|\s)(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+(?:install|ci)(?:\s|$)/i;

export type RegistryCredentialReference = {
  readonly key: string;
  readonly path: string;
  readonly line: number;
};

export class RegistryCredentialPreflightError extends Error {
  readonly missing: readonly RegistryCredentialReference[];

  constructor(opts: {
    readonly missing: readonly RegistryCredentialReference[];
  }) {
    super(formatRegistryCredentialPreflightFailure({ missing: opts.missing }));
    this.name = "RegistryCredentialPreflightError";
    this.missing = opts.missing;
  }
}

export async function discoverRegistryCredentialReferences(opts: {
  readonly projectRoot: string;
}): Promise<readonly RegistryCredentialReference[]> {
  const references: RegistryCredentialReference[] = [];
  for (const filename of REGISTRY_CONFIG_FILES) {
    const path = resolve(opts.projectRoot, filename);
    const text = await readTextFile(path);
    if (text === null) {
      continue;
    }
    for (const [index, line] of text.split("\n").entries()) {
      for (const match of line.matchAll(ENV_REFERENCE_PATTERN)) {
        const key = match[1];
        if (key) {
          references.push({ key, path, line: index + 1 });
        }
      }
    }
  }
  return references;
}

function serializeComposeCommand(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(" ");
  }
  return "";
}

function hasDependencyBootstrapLabel(value: unknown): boolean {
  if (isRecord(value)) {
    return (
      value["hack.dependencies.bootstrap"] === true ||
      value["hack.dependencies.bootstrap"] === "true"
    );
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some(
    (entry) =>
      typeof entry === "string" &&
      entry.trim().toLowerCase() === "hack.dependencies.bootstrap=true"
  );
}

export async function discoverDependencyBootstrapServices(opts: {
  readonly composeFile: string;
}): Promise<readonly string[]> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return [];
  }
  try {
    const parsed: unknown = YAML.parse(text);
    const services =
      isRecord(parsed) && isRecord(parsed.services) ? parsed.services : null;
    if (!services) {
      return [];
    }
    return Object.entries(services)
      .filter(([, value]) => {
        if (!isRecord(value)) {
          return false;
        }
        const command = `${serializeComposeCommand(value.entrypoint)} ${serializeComposeCommand(value.command)}`;
        return (
          hasDependencyBootstrapLabel(value.labels) ||
          DEPENDENCY_INSTALL_PATTERN.test(command)
        );
      })
      .map(([service]) => service)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function preflightRegistryCredentials(opts: {
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<{
  readonly references: readonly RegistryCredentialReference[];
  readonly missing: readonly RegistryCredentialReference[];
}> {
  const references = await discoverRegistryCredentialReferences({
    projectRoot: opts.projectRoot,
  });
  return {
    references,
    missing: references.filter((reference) => {
      const value = opts.env[reference.key];
      return typeof value !== "string" || value.length === 0;
    }),
  };
}

export function formatRegistryCredentialPreflightFailure(opts: {
  readonly missing: readonly RegistryCredentialReference[];
}): string {
  const unique = [...new Set(opts.missing.map((reference) => reference.key))];
  const locations = opts.missing
    .map((reference) => `${reference.path}:${reference.line}`)
    .join(", ");
  return `Missing package-registry credential${unique.length === 1 ? "" : "s"}: ${unique.join(", ")}. Referenced by ${locations}. Add the value to the selected Hack env overlay before startup.`;
}
