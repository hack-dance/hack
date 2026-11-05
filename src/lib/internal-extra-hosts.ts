import { resolve } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { readOptionalTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  resolvePrimaryLocalProjectDir,
  validatePrimaryLocalFile,
} from "./worktree-local-config.ts";

export function resolveExtraHostsPath(projectDir: string): string {
  return resolve(projectDir, ".internal", "extra-hosts.json");
}

/** Fixed text when a checkout-local alias map exists but cannot be read. */
export const UNREADABLE_EXTRA_HOSTS_MAP =
  "Cannot read the internal extra-hosts map; aliases were not dropped.";

/**
 * Null is a checkout-local tombstone hiding a primary alias.
 *
 * An absent map is empty. A map that exists but cannot be read (a directory,
 * a dangling link, no read permission) refuses with `E_CONFIG_INVALID`, so a
 * configured alias is never silently omitted or overwritten.
 */
export async function readLocalExtraHosts(
  path: string
): Promise<Record<string, string | null>> {
  const file = await readOptionalTextFile(path);
  if (file.kind === "unreadable") {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: UNREADABLE_EXTRA_HOSTS_MAP,
    });
  }
  if (file.kind === "absent" || !file.text) {
    return {};
  }
  const parsed: unknown = JSON.parse(file.text);
  if (!isRecord(parsed)) {
    throw new Error("Invalid internal extra-hosts map");
  }
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      !key.trim() ||
      (value !== null && (typeof value !== "string" || !value.trim()))
    ) {
      throw new Error("Invalid internal extra-hosts entry");
    }
    Object.defineProperty(result, key.trim(), {
      value: value?.trim() ?? null,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export async function resolveInternalExtraHosts(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly staticHosts?: Record<string, string>;
}): Promise<{
  readonly hosts: Record<string, string>;
  readonly origins: Record<string, string>;
}> {
  const primary = await resolvePrimaryLocalProjectDir(opts);
  const hosts: Record<string, string> = {};
  const origins: Record<string, string> = {};
  for (const dir of [...(primary ? [primary] : []), opts.projectDir]) {
    const path = resolveExtraHostsPath(dir);
    if (dir === primary) {
      await validatePrimaryLocalFile(path);
    }
    if (dir === opts.projectDir) {
      for (const [key, value] of Object.entries(opts.staticHosts ?? {})) {
        Object.defineProperty(hosts, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(origins, key, {
          value: "internal.extra_hosts",
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    for (const [key, value] of Object.entries(
      await readLocalExtraHosts(path)
    )) {
      if (value === null) {
        delete hosts[key];
        delete origins[key];
      } else {
        Object.defineProperty(hosts, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(origins, key, {
          value: path,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }
  return { hosts, origins };
}
