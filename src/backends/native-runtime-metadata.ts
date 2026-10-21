import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  buildRuntimeHostMetadataEnvironments,
  type RuntimeHostMetadataService,
  readCaddyLabel,
  readDeclaredEnvironmentKeys,
  runtimeHostMetadataComposeProject,
} from "../lib/runtime-host-metadata.ts";
import type { NativeProjectInput } from "./native-project-input.ts";

const LIMIT = 256 * 1024;

/** Public instance identity for native runtime host metadata. Never secret values. */
export type NativeRuntimeMetadataSelection = {
  /** Configured base development host, before branch rewriting. */
  readonly devHost: string;
  /** Configured base OAuth alias host, or null when the alias is disabled. */
  readonly aliasHost: string | null;
  /** Base Compose project name; branch instances report `<name>--<branch>`. */
  readonly projectName: string;
};

export type NativeRuntimeMetadata = {
  /** Input whose normalized Compose carries the metadata as public environment. */
  readonly input: NativeProjectInput;
  /** Normalized route hostnames per routed service; review must report the same set. */
  readonly routes: ReadonlyMap<string, readonly string[]>;
};

function refused(): Error {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native runtime metadata requires reviewable services whose route labels match the reviewed plan; no graph was started.",
  });
}

/** Mirror native review's hostname normalization: trailing dot removed, lowercase. */
function routeHosts(labels: unknown): string[] {
  const caddy = readCaddyLabel({ labels });
  if (caddy === null) {
    return [];
  }
  const hosts: string[] = [];
  for (const part of caddy.split(",")) {
    const trimmed = part.trim();
    const host = (
      trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed
    ).toLowerCase();
    if (host && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

/** Compose interpolation treats `$` specially; `$$` is its literal escape. */
function literal(value: string): string {
  return value.replaceAll("$", () => "$$");
}

/**
 * Add the same runtime host metadata the Compose backend generates to the exact
 * normalized Compose native review will see, as public (non-secret) environment.
 *
 * The values are derived from the route labels native review turns into its
 * route plan, the effective branch and the native HTTPS port; callers must check
 * the returned routes against the reviewed plan with
 * {@link verifyNativeRuntimeMetadataRoutes} before starting anything. Keys a
 * service already declares, including Hack-managed project values (bare keys),
 * are left untouched, so explicit project values win. Call this after branch
 * rewriting and every other normalization so the reviewed bytes are final.
 */
export function applyNativeRuntimeMetadata(opts: {
  readonly input: NativeProjectInput;
  readonly selection: NativeRuntimeMetadataSelection;
  readonly branch: string | null;
  /** Native HTTPS frontend port; null when no frontend is selected. */
  readonly httpsPort: number | null;
}): NativeRuntimeMetadata {
  const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  const services = new Map<string, RuntimeHostMetadataService>();
  const routes = new Map<string, readonly string[]>();
  const records = new Map<string, Record<string, unknown>>();
  for (const [name, service] of Object.entries(compose.services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    const hosts = routeHosts(service.labels);
    if (hosts.length > 0) {
      routes.set(name, hosts);
    }
    records.set(name, service);
    services.set(name, {
      hosts,
      declaredEnvironmentKeys: readDeclaredEnvironmentKeys({
        environment: service.environment,
      }),
    });
  }
  const environments = buildRuntimeHostMetadataEnvironments({
    services,
    branch: opts.branch,
    devHost: opts.selection.devHost,
    aliasHost: opts.selection.aliasHost,
    composeProject: runtimeHostMetadataComposeProject({
      projectName: opts.selection.projectName,
      branch: opts.branch,
    }),
    httpsPort: opts.httpsPort,
  });
  for (const [name, values] of environments) {
    const service = records.get(name);
    if (!service) {
      throw refused();
    }
    const entries = Object.entries(values).map(
      ([key, value]) => [key, literal(value)] as const
    );
    if (service.environment === undefined || service.environment === null) {
      service.environment = Object.fromEntries(entries);
    } else if (isRecord(service.environment)) {
      Object.assign(service.environment, Object.fromEntries(entries));
    } else if (Array.isArray(service.environment)) {
      service.environment.push(
        ...entries.map(([key, value]) => `${key}=${value}`)
      );
    } else {
      throw refused();
    }
  }
  const normalizedComposeJson = JSON.stringify(compose);
  if (Buffer.byteLength(normalizedComposeJson) > LIMIT) {
    throw refused();
  }
  return { input: { ...opts.input, normalizedComposeJson }, routes };
}

/**
 * Refuse unless every active service's reviewed route hostnames are exactly the
 * hostnames its runtime metadata advertises. This keeps the delivered URLs bound
 * to the reviewed route plan rather than to a client-side label reading.
 */
export function verifyNativeRuntimeMetadataRoutes(opts: {
  readonly plan: unknown;
  readonly routes: ReadonlyMap<string, readonly string[]>;
}): void {
  if (!(isRecord(opts.plan) && isRecord(opts.plan.services))) {
    throw refused();
  }
  for (const [name, service] of Object.entries(opts.plan.services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    if (service.active !== true) {
      continue;
    }
    const routing = service.routing;
    const reviewed: unknown[] =
      isRecord(routing) && Array.isArray(routing.hostnames)
        ? routing.hostnames
        : [];
    if (!reviewed.every((host) => typeof host === "string")) {
      throw refused();
    }
    const expected = [...(opts.routes.get(name) ?? [])].sort();
    if (
      JSON.stringify([...(reviewed as string[])].sort()) !==
      JSON.stringify(expected)
    ) {
      throw refused();
    }
  }
}
