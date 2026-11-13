import { isRecord } from "./guards.ts";
import { HACK_OWNERSHIP_LABEL_NAMESPACES } from "./hack-ownership-labels.ts";

const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Logical Hack entry points become new native-owned bridges, never Docker attachments. */
export function isHackExternalNetwork(name: string, value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const external = value.external;
  if (!(external === true || isRecord(external))) {
    return false;
  }
  if (
    isRecord(external) &&
    Object.keys(external).some((key) => key !== "name")
  ) {
    return false;
  }
  const legacy = isRecord(external) ? external.name : undefined;
  if (
    legacy !== undefined &&
    value.name !== undefined &&
    legacy !== value.name
  ) {
    return false;
  }
  const actual = value.name ?? legacy ?? name;
  return actual === "hack-dev" || actual === "hack-logging";
}

/** Authored metadata never supplies Engine ownership. Semantic Hack declarations remain reviewed. */
export function isIgnoredHackComposeLabel(key: string): boolean {
  return (
    key.startsWith("com.docker.compose.") ||
    key === "com.docker.compose" ||
    HACK_OWNERSHIP_LABEL_NAMESPACES.some(
      (prefix) => key.startsWith(prefix) || key === prefix.slice(0, -1)
    ) ||
    ((key === "hack" || key.startsWith("hack.")) &&
      key !== "hack.dependencies" &&
      key !== "hack.service" &&
      !key.startsWith("hack.dependencies.") &&
      !key.startsWith("hack.service."))
  );
}

/** Bounded declared foreign names for an actionable refusal; no label values or host paths. */
export function foreignComposeNetworkNames(compose: unknown): string[] {
  if (!(isRecord(compose) && isRecord(compose.networks))) {
    return [];
  }
  return Object.entries(compose.networks)
    .flatMap(([name, network]) => {
      if (
        !isRecord(network) ||
        isHackExternalNetwork(name, network) ||
        network["x-hack-isolated"] === true
      ) {
        return [];
      }
      const legacy = isRecord(network.external) ? network.external : undefined;
      if (!(network.external === true || legacy)) {
        return [];
      }
      const actual = network.name ?? legacy?.name ?? name;
      return typeof actual === "string" && NETWORK_NAME.test(actual)
        ? [actual]
        : [];
    })
    .slice(0, 32)
    .sort();
}

/** Refuse an ambiguous alias topology rather than silently splitting one Compose network. */
export function duplicateHackComposeNetworks(compose: unknown): string[] {
  if (!(isRecord(compose) && isRecord(compose.networks))) {
    return [];
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const [name, definition] of Object.entries(compose.networks)) {
    if (!(isRecord(definition) && isHackExternalNetwork(name, definition))) {
      continue;
    }
    const legacy = isRecord(definition.external)
      ? definition.external.name
      : undefined;
    const identity = definition.name ?? legacy ?? name;
    if (typeof identity === "string") {
      if (seen.has(identity)) {
        duplicates.add(identity);
      }
      seen.add(identity);
    }
  }
  return [...duplicates].sort();
}
