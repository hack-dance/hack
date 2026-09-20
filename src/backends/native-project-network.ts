import { isIP } from "node:net";

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
function refused(): Error {
  return new Error(
    "HACK_NATIVE_ALLOW_HOSTS requires at most 32 unique canonical public DNS names; wildcards, IP addresses, local names and empty entries are refused. Values omitted."
  );
}

/** Match native NetworkIntent admission; never resolve or widen the selection here. */
export function validateNativeAllowedHosts(
  hosts: readonly string[] = []
): readonly string[] {
  if (hosts.length > 32 || new Set(hosts).size !== hosts.length) {
    throw refused();
  }
  for (const host of hosts) {
    if (
      host.length > 253 ||
      !host.includes(".") ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      isIP(host) !== 0 ||
      host.split(".").some((label) => label.length > 63 || !LABEL.test(label))
    ) {
      throw refused();
    }
  }
  return [...hosts].sort();
}

export function parseNativeAllowedHosts(
  value: string | undefined
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (value.length > 8127) {
    throw refused();
  }
  return validateNativeAllowedHosts(value.split(","));
}
