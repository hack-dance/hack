import { readFile } from "node:fs/promises";
import {
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
} from "../constants.ts";
import { readGlobalConfig } from "./config.ts";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { isRecord } from "./guards.ts";

export const DEFAULT_DOMAIN_CONFIG_KEY = "default_domain" as const;

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL = /^\d+$/;

/** A suffix for generated project hosts, never a URL, wildcard, or full host. */
export function parseDefaultDomain(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("default_domain must be a domain string");
  }
  const domain = value.trim().toLowerCase();
  const labels = domain.split(".");
  if (
    domain.length > 253 ||
    (labels.length < 2 && domain !== DEFAULT_PROJECT_TLD) ||
    labels.some((label) => !DOMAIN_LABEL.test(label)) ||
    domain === "localhost" ||
    NUMERIC_LABEL.test(labels.at(-1) ?? "")
  ) {
    throw new Error(
      "default_domain must be a valid domain suffix, such as hack.local or hack.gy"
    );
  }
  return domain;
}

/** Explicit project dev_host/--dev-host always takes precedence over this global default. */
export async function resolveDefaultDomain(): Promise<string> {
  const configured = await readGlobalConfig({
    path: DEFAULT_DOMAIN_CONFIG_KEY,
  });
  return configured === undefined
    ? DEFAULT_NEW_PROJECT_TLD
    : parseDefaultDomain(configured);
}

/**
 * The configured default domain for observe-only reads (`hack global status
 * --observe`): the built-in default only when the global config file is
 * confirmed missing or does not set one. A config that exists but cannot be
 * read or parsed throws, so the caller reports unknown instead of checking
 * the wrong suffixes.
 */
export async function resolveDefaultDomainStrictly(): Promise<string> {
  let text: string;
  try {
    text = await readFile(resolveGlobalConfigPath(), "utf8");
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return DEFAULT_NEW_PROJECT_TLD;
    }
    throw new Error("The global config could not be read");
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("The global config is not a JSON object");
  }
  const configured = parsed[DEFAULT_DOMAIN_CONFIG_KEY];
  return configured === undefined
    ? DEFAULT_NEW_PROJECT_TLD
    : parseDefaultDomain(configured);
}

/** Keep the built-in roots active in parallel with a configured default. */
export function managedLocalDomains(defaultDomain: string): readonly string[] {
  return [
    ...new Set([
      DEFAULT_PROJECT_TLD,
      DEFAULT_NEW_PROJECT_TLD,
      DEFAULT_OAUTH_ALIAS_ROOT,
      defaultDomain,
    ]),
  ];
}
