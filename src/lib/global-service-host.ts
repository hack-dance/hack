import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_GRAFANA_HOST,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  LEGACY_GRAFANA_HOST,
} from "../constants.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";

/** Select only literal known routes; unknown/custom configuration is never guessed. */
export function selectGlobalGrafanaHost(text: string): string | null {
  try {
    const value: unknown = Bun.YAML.parse(text);
    if (
      !(
        isRecord(value) &&
        isRecord(value.services) &&
        isRecord(value.services.grafana)
      )
    ) {
      return null;
    }
    const labels = value.services.grafana.labels;
    let route: unknown;
    if (isRecord(labels)) {
      route = labels.caddy;
    } else if (Array.isArray(labels)) {
      const matches = labels.filter(
        (entry) => typeof entry === "string" && entry.startsWith("caddy=")
      );
      if (matches.length !== 1) {
        return null;
      }
      route = matches[0]?.slice(6);
    }
    if (typeof route !== "string" || route.includes("$")) {
      return null;
    }
    const hosts = route.split(",").map((host) => host.trim());
    if (hosts.includes(DEFAULT_GRAFANA_HOST)) {
      return DEFAULT_GRAFANA_HOST;
    }
    return hosts.includes(LEGACY_GRAFANA_HOST) ? LEGACY_GRAFANA_HOST : null;
  } catch {
    return null;
  }
}

/** Bounded read only; selecting a configured route does not prove a live service. */
export async function resolveInstalledGrafanaHost(
  opts: { readonly root?: string } = {}
): Promise<string | null> {
  try {
    const file = await open(
      resolve(
        opts.root ?? resolveGlobalHackDir(),
        GLOBAL_LOGGING_DIR_NAME,
        GLOBAL_LOGGING_COMPOSE_FILENAME
      ),
      constants.O_RDONLY | constants.O_NONBLOCK
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        return null;
      }
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size || bytesRead > 1024 * 1024) {
        return null;
      }
      return selectGlobalGrafanaHost(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead)
        )
      );
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
