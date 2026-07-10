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
  readonly service?: string;

  constructor(opts: {
    readonly missing: readonly RegistryCredentialReference[];
    readonly service?: string;
  }) {
    super(
      formatRegistryCredentialPreflightFailure({
        missing: opts.missing,
        service: opts.service,
      })
    );
    this.name = "RegistryCredentialPreflightError";
    this.missing = opts.missing;
    this.service = opts.service;
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

function hasComposeLabel(opts: {
  readonly labels: unknown;
  readonly name: string;
}): boolean {
  const { labels, name } = opts;
  if (isRecord(labels)) {
    return labels[name] === true || labels[name] === "true";
  }
  if (!Array.isArray(labels)) {
    return false;
  }
  return labels.some(
    (entry) =>
      typeof entry === "string" &&
      entry.trim().toLowerCase() === `${name.toLowerCase()}=true`
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
          hasComposeLabel({
            labels: value.labels,
            name: "hack.dependencies.bootstrap",
          }) || DEPENDENCY_INSTALL_PATTERN.test(command)
        );
      })
      .map(([service]) => service)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Services that may legitimately exit zero after startup instead of staying running. */
export async function discoverSuccessfulCompletionServices(opts: {
  readonly composeFile: string;
}): Promise<readonly string[]> {
  const bootstrapServices = await discoverDependencyBootstrapServices(opts);
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return bootstrapServices;
  }
  try {
    const parsed: unknown = YAML.parse(text);
    const services =
      isRecord(parsed) && isRecord(parsed.services) ? parsed.services : null;
    if (!services) {
      return bootstrapServices;
    }
    const explicitOneShots = Object.entries(services)
      .filter(
        ([, value]) =>
          isRecord(value) &&
          hasComposeLabel({
            labels: value.labels,
            name: "hack.service.one-shot",
          })
      )
      .map(([service]) => service);
    const completionDependencies = Object.values(services).flatMap((value) => {
      if (!(isRecord(value) && isRecord(value.depends_on))) {
        return [];
      }
      return Object.entries(value.depends_on)
        .filter(
          ([, dependency]) =>
            isRecord(dependency) &&
            dependency.condition === "service_completed_successfully"
        )
        .map(([service]) => service);
    });
    return [
      ...new Set([
        ...bootstrapServices,
        ...explicitOneShots,
        ...completionDependencies,
      ]),
    ].sort((left, right) => left.localeCompare(right));
  } catch {
    return bootstrapServices;
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
  readonly service?: string;
}): string {
  const unique = [...new Set(opts.missing.map((reference) => reference.key))];
  const locations = opts.missing
    .map((reference) => `${reference.path}:${reference.line}`)
    .join(", ");
  const service = opts.service ? ` for service ${opts.service}` : "";
  return `Missing package-registry credential${unique.length === 1 ? "" : "s"}${service}: ${unique.join(", ")}. Referenced by ${locations}. Add the value to that service's selected Hack env scope before startup.`;
}
