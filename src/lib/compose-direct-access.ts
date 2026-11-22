import { isIP } from "node:net";
import type { RuntimeContainer } from "./runtime-projects.ts";

const PUBLISHED = /(?:^|,\s*)(\[[^\]]+\]|[\d.]+):(\d+)->\d+\/tcp(?=,|$)/g;
const LOOPBACK_HOSTS: Readonly<Record<string, string>> = {
  "0.0.0.0": "127.0.0.1",
  "::": "::1",
};
const EXPOSED_TCP =
  /(?:^|,\s*)(?:\[[^\]]+\]:\d+->|[\d.]+:\d+->)?(\d+)\/tcp(?=,|$)/g;

export function runningComposeDirectAccess(
  containers: readonly RuntimeContainer[],
  linux: boolean
): string | null {
  for (const container of containers) {
    if (container.state !== "running") {
      continue;
    }
    const published = [...container.ports.matchAll(PUBLISHED)].flatMap(
      ([, address, port]) => {
        const ip = address?.replace(/^\[|\]$/g, "") ?? "";
        if (!(port && isIP(ip))) {
          return [];
        }
        const host = LOOPBACK_HOSTS[ip] ?? ip;
        return [`${isIP(host) === 6 ? `[${host}]` : host}:${port}`];
      }
    );
    const exposed = [...container.ports.matchAll(EXPOSED_TCP)].map(
      (match) => match[1]
    );
    const ip = linux
      ? container.networks.find(
          (network) => isIP(network.ipAddress ?? "") === 4
        )?.ipAddress
      : null;
    if (published.length) {
      return `Reach ${container.service} directly at ${[...new Set(published)].join(", ")}.`;
    }
    if (ip) {
      const endpoints = exposed.map((port) => `${ip}:${port}`);
      return `Reach ${container.service} directly at ${endpoints.join(", ") || `${ip} on its listening port`}.`;
    }
  }
  return null;
}
