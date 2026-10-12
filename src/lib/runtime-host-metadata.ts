import { YAML } from "bun";

import { applyBranchToHost } from "./branch-hosts.ts";
import { isRecord } from "./guards.ts";

export const RUNTIME_HOST_METADATA_KEYS = {
  branch: "HACK_BRANCH",
  devHost: "HACK_DEV_HOST",
  devUrl: "HACK_DEV_URL",
  aliasHost: "HACK_ALIAS_HOST",
  aliasUrl: "HACK_ALIAS_URL",
  composeProject: "HACK_COMPOSE_PROJECT",
  runtimeMetadata: "HACK_RUNTIME_METADATA",
  serviceName: "HACK_SERVICE_NAME",
  serviceUrl: "HACK_SERVICE_URL",
  serviceUrls: "HACK_SERVICE_URLS",
} as const;

export type RuntimeHostMetadata = {
  readonly version: 1;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly hosts: {
    readonly dev: string;
    readonly alias: string | null;
  };
  readonly services: Readonly<
    Record<string, { readonly urls: readonly string[] }>
  >;
};

/** One service's public route hosts and the environment keys its author already owns. */
export type RuntimeHostMetadataService = {
  /** Effective public hostnames in declaration order; empty when unrouted. */
  readonly hosts: readonly string[];
  readonly declaredEnvironmentKeys: ReadonlySet<string>;
};

/** Every environment key Hack reserves for runtime host metadata. */
export const RUNTIME_HOST_METADATA_KEY_NAMES: readonly string[] = Object.values(
  RUNTIME_HOST_METADATA_KEYS
);

/** Compose project name reported for an instance; branches use `<project>--<branch>`. */
export function runtimeHostMetadataComposeProject(opts: {
  readonly projectName: string;
  readonly branch: string | null;
}): string {
  return opts.branch ? `${opts.projectName}--${opts.branch}` : opts.projectName;
}

/**
 * Browser-facing HTTPS URL for a public host. The default HTTPS port stays
 * implicit; any other ingress port (such as a native HTTPS frontend) is explicit.
 */
export function runtimeHostUrl(opts: {
  readonly host: string;
  readonly httpsPort?: number | null;
}): string {
  const port =
    opts.httpsPort === undefined ||
    opts.httpsPort === null ||
    opts.httpsPort === 443
      ? ""
      : `:${opts.httpsPort}`;
  return `https://${opts.host}${port}`;
}

/**
 * Builds the generated Compose fragment that exposes non-secret runtime
 * identity to every service. Keys already declared by a service are omitted;
 * later Hack env overrides retain their normal higher precedence.
 */
export function buildRuntimeHostMetadataOverride(opts: {
  readonly composeYamls: readonly string[];
  readonly branch: string | null;
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly composeProject: string;
}): string | null {
  const effectiveServices = readEffectiveServices({
    composeYamls: opts.composeYamls,
  });
  if (effectiveServices.size === 0) {
    return null;
  }

  const environments = buildRuntimeHostMetadataEnvironments({
    services: new Map(
      [...effectiveServices].map(([serviceName, service]) => [
        serviceName,
        {
          hosts: service.caddy
            ? extractCaddyHosts({ value: service.caddy })
            : [],
          declaredEnvironmentKeys: service.declaredEnvironmentKeys,
        },
      ])
    ),
    branch: opts.branch,
    devHost: opts.devHost,
    aliasHost: opts.aliasHost,
    composeProject: opts.composeProject,
  });
  if (environments.size === 0) {
    return null;
  }
  const services: Record<string, { environment: Record<string, string> }> = {};
  for (const [serviceName, environment] of environments) {
    services[serviceName] = { environment };
  }
  return ensureTrailingNewline(
    cleanupYaml(YAML.stringify({ services }, null, 2))
  );
}

/**
 * Computes the non-secret runtime identity each service receives. The Compose
 * override and the native backend both use it, so both emit the same keys and
 * document shape. Keys a service already declares are omitted (explicit project
 * values win) and services left without keys are absent from the result. The
 * iteration order of `services` defines the metadata document's service order.
 */
export function buildRuntimeHostMetadataEnvironments(opts: {
  readonly services: ReadonlyMap<string, RuntimeHostMetadataService>;
  readonly branch: string | null;
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly composeProject: string;
  /** Public HTTPS ingress port; omitted, null or 443 keeps URLs portless. */
  readonly httpsPort?: number | null;
}): Map<string, Record<string, string>> {
  const baseHosts = [opts.devHost, opts.aliasHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  );
  const effectiveDevHost = applyBranchIfNeeded({
    host: opts.devHost,
    branch: opts.branch,
    baseHosts,
  });
  const effectiveAliasHost = opts.aliasHost
    ? applyBranchIfNeeded({
        host: opts.aliasHost,
        branch: opts.branch,
        baseHosts,
      })
    : null;
  const url = (host: string) =>
    runtimeHostUrl({ host, httpsPort: opts.httpsPort });
  const publicServices: Record<string, { readonly urls: readonly string[] }> =
    {};
  for (const [serviceName, service] of opts.services) {
    const urls = resolveServiceUrls({ hosts: service.hosts, url });
    if (urls.length > 0) {
      publicServices[serviceName] = { urls };
    }
  }
  const runtimeMetadata: RuntimeHostMetadata = {
    version: 1,
    branch: opts.branch,
    composeProject: opts.composeProject,
    hosts: {
      dev: effectiveDevHost,
      alias: effectiveAliasHost,
    },
    services: publicServices,
  };
  const sharedMetadata: Record<string, string> = {
    [RUNTIME_HOST_METADATA_KEYS.branch]: opts.branch ?? "",
    [RUNTIME_HOST_METADATA_KEYS.devHost]: effectiveDevHost,
    [RUNTIME_HOST_METADATA_KEYS.devUrl]: url(effectiveDevHost),
    [RUNTIME_HOST_METADATA_KEYS.composeProject]: opts.composeProject,
    [RUNTIME_HOST_METADATA_KEYS.runtimeMetadata]:
      JSON.stringify(runtimeMetadata),
    ...(effectiveAliasHost
      ? {
          [RUNTIME_HOST_METADATA_KEYS.aliasHost]: effectiveAliasHost,
          [RUNTIME_HOST_METADATA_KEYS.aliasUrl]: url(effectiveAliasHost),
        }
      : {}),
  };
  const environments = new Map<string, Record<string, string>>();
  for (const [serviceName, service] of opts.services) {
    const urls = publicServices[serviceName]?.urls ?? [];
    const metadata: Record<string, string> = {
      ...sharedMetadata,
      [RUNTIME_HOST_METADATA_KEYS.serviceName]: serviceName,
      [RUNTIME_HOST_METADATA_KEYS.serviceUrls]: JSON.stringify(urls),
      ...(urls[0] ? { [RUNTIME_HOST_METADATA_KEYS.serviceUrl]: urls[0] } : {}),
    };
    const environment = Object.fromEntries(
      Object.entries(metadata).filter(
        ([key]) => !service.declaredEnvironmentKeys.has(key)
      )
    );
    if (Object.keys(environment).length > 0) {
      environments.set(serviceName, environment);
    }
  }
  return environments;
}

function parseComposeYaml(opts: {
  readonly text: string;
}): Record<string, unknown> | null {
  try {
    const parsed: unknown = YAML.parse(opts.text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type EffectiveService = {
  caddy: string | null;
  readonly declaredEnvironmentKeys: Set<string>;
};

function readEffectiveServices(opts: {
  readonly composeYamls: readonly string[];
}): ReadonlyMap<string, EffectiveService> {
  const services = new Map<string, EffectiveService>();
  for (const text of opts.composeYamls) {
    const parsed = parseComposeYaml({ text });
    if (!(parsed && isRecord(parsed.services))) {
      continue;
    }
    for (const [serviceName, serviceRaw] of Object.entries(parsed.services)) {
      if (!isRecord(serviceRaw)) {
        continue;
      }
      const current = services.get(serviceName) ?? {
        caddy: null,
        declaredEnvironmentKeys: new Set<string>(),
      };
      const caddy = readCaddyLabel({ labels: serviceRaw.labels });
      if (caddy) {
        current.caddy = caddy;
      }
      for (const key of readDeclaredEnvironmentKeys({
        environment: serviceRaw.environment,
      })) {
        current.declaredEnvironmentKeys.add(key);
      }
      services.set(serviceName, current);
    }
  }
  return services;
}

function applyBranchIfNeeded(opts: {
  readonly host: string;
  readonly branch: string | null;
  readonly baseHosts: readonly string[];
}): string {
  return opts.branch
    ? applyBranchToHost({
        host: opts.host,
        branch: opts.branch,
        baseHosts: opts.baseHosts,
      })
    : opts.host;
}

function resolveServiceUrls(opts: {
  readonly hosts: readonly string[];
  readonly url: (host: string) => string;
}): readonly string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const host of opts.hosts) {
    const url = opts.url(host);
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** The public `caddy` route label value from map or list Compose labels. */
export function readCaddyLabel(opts: {
  readonly labels: unknown;
}): string | null {
  if (isRecord(opts.labels)) {
    const value = opts.labels.caddy;
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }
  if (!Array.isArray(opts.labels)) {
    return null;
  }
  for (const entry of opts.labels) {
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator > 0 && entry.slice(0, separator).trim() === "caddy") {
      return entry.slice(separator + 1).trim();
    }
  }
  return null;
}

function extractCaddyHosts(opts: {
  readonly value: string;
}): readonly string[] {
  const hosts: string[] = [];
  for (const part of opts.value.split(",")) {
    let host = part.trim();
    if (host.startsWith("http://")) {
      host = host.slice("http://".length);
    } else if (host.startsWith("https://")) {
      host = host.slice("https://".length);
    }
    const slashIndex = host.indexOf("/");
    if (slashIndex !== -1) {
      host = host.slice(0, slashIndex);
    }
    if (
      host.length === 0 ||
      host.includes("*") ||
      host.includes("{") ||
      host.includes("}") ||
      host.includes("$") ||
      host.includes(":")
    ) {
      continue;
    }
    hosts.push(host);
  }
  return hosts;
}

/** Environment keys a Compose service declares, from map or list form. */
export function readDeclaredEnvironmentKeys(opts: {
  readonly environment: unknown;
}): Set<string> {
  if (isRecord(opts.environment)) {
    return new Set(Object.keys(opts.environment));
  }
  if (!Array.isArray(opts.environment)) {
    return new Set();
  }
  const keys = new Set<string>();
  for (const entry of opts.environment) {
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("=");
    const key = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    if (key.length > 0) {
      keys.add(key);
    }
  }
  return keys;
}

function cleanupYaml(yaml: string): string {
  return yaml.replaceAll(/: \n/g, ":\n");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
