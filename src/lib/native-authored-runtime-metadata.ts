import { DEFAULT_NEW_PROJECT_TLD } from "../constants.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";
import type { NativeRoutingResolution } from "./native-routing-plan-protocol.ts";
import {
  buildEffectiveRuntimeHostMetadataEnvironments,
  RUNTIME_HOST_METADATA_KEY_NAMES,
  type RuntimeHostMetadataService,
  runtimeHostMetadataComposeProject,
} from "./runtime-host-metadata.ts";

/** Instance identity the command owner selects; hosts come from compiler routing. */
export type NativeAuthoredRuntimeMetadataSelection = {
  /** Selected instance branch; a compiler routing resolution's branch takes precedence. */
  readonly branch: string | null;
  /**
   * Actual Compose project for the Compose backend. Omitted reports
   * `<name>` or `<name>--<branch>`, the same name native image projects report.
   */
  readonly composeProject?: string;
  /** Public HTTPS ingress port; null or 443 keeps URLs portless. */
  readonly httpsPort: number | null;
};

/**
 * The Compose backend's selection: the selected `--branch` instance, the
 * instance's actual Compose project, and portless URLs behind shared ingress.
 * Every authored Compose planner (command inputs and file material sources)
 * uses this one mapping so their plans stay byte-identical.
 */
export function nativeComposeRuntimeMetadataSelection(identity: {
  readonly instance: string | null;
  readonly composeProject: string;
}): NativeAuthoredRuntimeMetadataSelection {
  return {
    branch: identity.instance,
    composeProject: identity.composeProject,
    httpsPort: null,
  };
}

/** Public generated values per declared workload. Never secret and never managed. */
export type NativeRuntimeMetadataValues = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const RESERVED = new Set(RUNTIME_HOST_METADATA_KEY_NAMES);

function originHost(origin: string | undefined): string | null {
  if (origin === undefined) {
    return null;
  }
  try {
    const host = new URL(origin).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Public route hostnames per service: routes in name order, each route origin
 * before its aliases (in alias name order), so the first service URL is the
 * development origin, as in a Compose route label that lists the dev host first.
 */
function serviceHosts(
  routing: NativeRoutingResolution | undefined
): Map<string, string[]> {
  const hosts = new Map<string, string[]>();
  if (!routing) {
    return hosts;
  }
  for (const name of Object.keys(routing.routes).sort()) {
    const route = routing.routes[name];
    if (!route) {
      continue;
    }
    const selected = hosts.get(route.service) ?? [];
    const aliases = Object.keys(route.aliases)
      .sort()
      .map((alias) => route.aliases[alias]);
    for (const origin of [route.origin, ...aliases]) {
      const host = originHost(origin);
      if (host !== null) {
        selected.push(host);
      }
    }
    hosts.set(route.service, selected);
  }
  return hosts;
}

/**
 * Hack-generated runtime host metadata for an authored `.hack/hack.project.json`
 * project, computed by the same shared builder Compose-backed and native image
 * projects use. The compiler's routing resolution supplies the effective
 * (already branch-applied) development, OAuth alias and service hosts; without
 * one, the development host is the compiler's generated `<name>.hack.local`
 * origin. Every declared workload receives the full key set: the compiler binds
 * these values below managed and authored env, so explicit values win there.
 */
export function nativeAuthoredRuntimeMetadata(opts: {
  readonly projectName: string;
  readonly declaredWorkloads: NativeDeclaredWorkloads;
  readonly routing: NativeRoutingResolution | undefined;
  readonly selection: NativeAuthoredRuntimeMetadataSelection;
}): NativeRuntimeMetadataValues {
  const { routing, selection } = opts;
  const branch = routing ? (routing.branch ?? null) : selection.branch;
  const effectiveDevHost =
    originHost(routing?.project_origin) ??
    [branch, opts.projectName, DEFAULT_NEW_PROJECT_TLD]
      .filter((part): part is string => typeof part === "string")
      .join(".");
  const effectiveAliasHost =
    routing?.oauth_alias === null || routing?.oauth_alias === undefined
      ? null
      : originHost(routing.aliases[routing.oauth_alias]);
  const hosts = serviceHosts(routing);
  const services = new Map<string, RuntimeHostMetadataService>(
    Object.keys(opts.declaredWorkloads).map((name) => [
      name,
      { hosts: hosts.get(name) ?? [], declaredEnvironmentKeys: new Set() },
    ])
  );
  const environments = buildEffectiveRuntimeHostMetadataEnvironments({
    services,
    branch,
    effectiveDevHost,
    effectiveAliasHost,
    composeProject:
      selection.composeProject ??
      runtimeHostMetadataComposeProject({
        projectName: opts.projectName,
        branch,
      }),
    httpsPort: selection.httpsPort,
  });
  return Object.fromEntries(environments);
}

/** Closed wire projection: declared workloads, reserved keys and plain text values only. */
export function parseNativeRuntimeMetadataValues(
  value: unknown,
  workloadName: (name: string) => boolean
): NativeRuntimeMetadataValues | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const output: Record<string, Record<string, string>> = {};
  for (const [name, entries] of Object.entries(value)) {
    if (
      !workloadName(name) ||
      typeof entries !== "object" ||
      entries === null ||
      Array.isArray(entries)
    ) {
      return null;
    }
    const projected: Record<string, string> = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (
        !RESERVED.has(key) ||
        typeof entry !== "string" ||
        entry.includes("\0")
      ) {
        return null;
      }
      projected[key] = entry;
    }
    output[name] = projected;
  }
  return output;
}

/** Whether `key` is a reserved generated runtime metadata key. */
export function isNativeRuntimeMetadataKey(key: string): boolean {
  return RESERVED.has(key);
}
