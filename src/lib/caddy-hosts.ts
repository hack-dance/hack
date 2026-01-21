import { resolve } from "node:path";
import { YAML } from "bun";

import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { pathExists, readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

const GLOBAL_CADDY_PROJECT = "hack-dev-proxy";

export async function resolveGlobalCaddyIp(): Promise<string | null> {
  const ps = await exec(
    [
      "docker",
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT}`,
      "--filter",
      "label=com.docker.compose.service=caddy",
    ],
    { stdin: "ignore" }
  );
  if (ps.exitCode !== 0) {
    return null;
  }

  const id = ps.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!id) {
    return null;
  }

  const inspect = await exec(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id],
    { stdin: "ignore" }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const network = parsed[DEFAULT_INGRESS_NETWORK];
  if (!isRecord(network)) {
    return null;
  }
  const ip = network.IPAddress;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

export async function readInternalExtraHostsIp(opts: {
  readonly projectDir: string | null;
}): Promise<string | null> {
  if (!opts.projectDir) {
    return null;
  }
  const overridePath = resolve(
    opts.projectDir,
    ".internal",
    "compose.override.yml"
  );
  if (!(await pathExists(overridePath))) {
    return null;
  }
  const text = await readTextFile(overridePath);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const services = parsed.services;
  if (!isRecord(services)) {
    return null;
  }

  for (const service of Object.values(services)) {
    if (!isRecord(service)) {
      continue;
    }
    const extraHosts = service.extra_hosts;
    const ip = extractExtraHostsIp(extraHosts);
    if (ip) {
      return ip;
    }
  }

  return null;
}

function extractExtraHostsIp(extraHosts: unknown): string | null {
  if (isRecord(extraHosts)) {
    for (const value of Object.values(extraHosts)) {
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  if (Array.isArray(extraHosts)) {
    for (const entry of extraHosts) {
      if (typeof entry !== "string") {
        continue;
      }
      const ip = parseExtraHostEntry(entry);
      if (ip) {
        return ip;
      }
    }
  }

  return null;
}

function parseExtraHostEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  const eqIndex = trimmed.lastIndexOf("=");
  const colonIndex = trimmed.lastIndexOf(":");
  const splitIndex = eqIndex > colonIndex ? eqIndex : colonIndex;
  if (splitIndex <= 0) {
    return null;
  }
  const ip = trimmed.slice(splitIndex + 1).trim();
  return isIpv4(ip) ? ip : null;
}

function isIpv4(value: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return false;
  }
  return value.split(".").every((part) => {
    const num = Number(part);
    return Number.isInteger(num) && num >= 0 && num <= 255;
  });
}
