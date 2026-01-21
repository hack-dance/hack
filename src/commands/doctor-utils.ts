import { YAML } from "bun";

import { DEFAULT_CADDY_IP, DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord, isStringArray } from "../lib/guards.ts";

export type ComposeNetworkHygieneError =
  | "invalid-yaml"
  | "unexpected-format"
  | "missing-services";

export type ComposeNetworkHygieneResult =
  | { readonly offenders: readonly string[] }
  | { readonly error: ComposeNetworkHygieneError };

export function resolverHasNameserver(opts: {
  readonly text: string;
  readonly nameserver: string;
}): boolean {
  return opts.text
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === `nameserver ${opts.nameserver}`);
}

export function dnsmasqConfigHasDomain(opts: {
  readonly text: string;
  readonly domain: string;
}): boolean {
  // Accept container IP (preferred), IPv6, or legacy IPv4 config
  const containerIpLine = `address=/.${opts.domain}/${DEFAULT_CADDY_IP}`;
  const ipv6Line = `address=/.${opts.domain}/::1`;
  const ipv4Line = `address=/.${opts.domain}/127.0.0.1`;
  return (
    opts.text.includes(containerIpLine) ||
    opts.text.includes(ipv6Line) ||
    opts.text.includes(ipv4Line)
  );
}

export function analyzeComposeNetworkHygiene(opts: {
  readonly yamlText: string;
  readonly ingressNetwork?: string;
}): ComposeNetworkHygieneResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(opts.yamlText);
  } catch {
    return { error: "invalid-yaml" };
  }

  if (!isRecord(parsed)) {
    return { error: "unexpected-format" };
  }

  const services = parsed.services;
  if (!isRecord(services)) {
    return { error: "missing-services" };
  }

  const offenders: string[] = [];
  const ingressNetwork = opts.ingressNetwork ?? DEFAULT_INGRESS_NETWORK;

  for (const [serviceName, def] of Object.entries(services)) {
    if (!isRecord(def)) {
      continue;
    }

    const labels = def.labels;
    const hasCaddyLabel = hasCaddyLabelValue(labels);

    const networks = def.networks;
    const nets = extractNetworkNames(networks);

    const isInternal = serviceName === "db" || serviceName === "redis";
    const attachedToIngress = nets.includes(ingressNetwork);

    if (isInternal && attachedToIngress && !hasCaddyLabel) {
      offenders.push(serviceName);
    }
  }

  return { offenders };
}

function hasCaddyLabelValue(labels: unknown): boolean {
  if (isRecord(labels)) {
    return "caddy" in labels || "caddy.reverse_proxy" in labels;
  }
  if (isStringArray(labels)) {
    return labels.some(
      (label) =>
        label.startsWith("caddy=") || label.startsWith("caddy.reverse_proxy=")
    );
  }
  return false;
}

function extractNetworkNames(networks: unknown): string[] {
  if (isStringArray(networks)) {
    return networks;
  }
  if (isRecord(networks)) {
    return Object.keys(networks);
  }
  return [];
}
