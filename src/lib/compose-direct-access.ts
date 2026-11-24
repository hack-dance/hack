import { isIP } from "node:net";
import type { RuntimeContainer } from "./runtime-projects.ts";

const PUBLISHED = /(?:^|,\s*)(\[[^\]]+\]|[\d.]+):(\d+)->\d+\/tcp(?=,|$)/g;
const LOOPBACK_HOSTS: Readonly<Record<string, string>> = {
  "0.0.0.0": "127.0.0.1",
  "::": "::1",
};
const EXPOSED_TCP = /(?:^|,\s*)(\d+)\/tcp(?=,|$)/g;

export function runningComposeDirectAccess(
  containers: readonly RuntimeContainer[],
  opts: {
    readonly linux: boolean;
    readonly project: string;
    readonly checkout: string;
  }
): string | null {
  let fallback: string | null = null;
  for (const container of containers) {
    if (
      container.state !== "running" ||
      container.project !== opts.project ||
      container.workingDir !== opts.checkout
    ) {
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
    const ip = opts.linux
      ? container.networks.find(
          (network) => isIP(network.ipAddress ?? "") === 4
        )?.ipAddress
      : null;
    if (published.length) {
      return `Reach ${container.service} directly at ${[...new Set(published)].join(", ")}.`;
    }
    if (ip && !fallback) {
      const endpoints = [...container.ports.matchAll(EXPOSED_TCP)].map(
        (match) => `${ip}:${match[1]}`
      );
      fallback = `Container address for ${container.service}: ${endpoints.join(", ") || `${ip} on its listening port`} (if reachable from this host).`;
    }
  }
  return fallback;
}
