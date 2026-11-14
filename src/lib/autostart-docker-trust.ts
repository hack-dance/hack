import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertAutostartPathAclsTrustedSync } from "./autostart-path-acl.ts";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { walkReplaceableChain } from "./path-trust.ts";

/** Authenticate Docker's engine-selection inputs without exposing credentials. */
export function assertAutostartDockerConfigTrusted(opts: {
  readonly home: string;
  readonly systemPluginDirectories?: readonly string[];
}): void {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error("Unavailable owner");
    }
    const root = join(opts.home, ".docker");
    const checked = new Set<string>();
    const visited = new Set<string>();
    let count = 0;
    const visit = (path: string, depth: number): void => {
      count += 1;
      if (count > 4096 || depth > 16) {
        throw new Error("Selection inputs exceed bound");
      }
      const trust = walkReplaceableChain({
        path,
        uid,
        hackHome: null,
        checked,
        allowMissing: true,
      });
      if ("error" in trust) {
        throw new Error("Unsafe selection input");
      }
      if (!trust.complete) {
        return;
      }
      const info = statSync(path);
      if (info.isFile()) {
        return;
      }
      if (!info.isDirectory()) {
        throw new Error("Unsupported selection input");
      }
      const physical = realpathSync(path);
      if (visited.has(physical)) {
        throw new Error("Cyclic selection input");
      }
      visited.add(physical);
      for (const name of readdirSync(path)) {
        visit(join(path, name), depth + 1);
      }
    };
    // Docker loads context metadata/TLS below this directory. Other .docker
    // caches do not select an engine and can be arbitrarily large.
    visit(join(root, "config.json"), 0);
    visit(join(root, "contexts"), 0);
    visit(join(root, "cli-plugins"), 0);
    for (const directory of opts.systemPluginDirectories ?? [
      "/usr/local/lib/docker/cli-plugins",
      "/usr/local/libexec/docker/cli-plugins",
      "/usr/lib/docker/cli-plugins",
      "/usr/libexec/docker/cli-plugins",
    ]) {
      visit(directory, 0);
    }
    const configPath = join(root, "config.json");
    assertAutostartPathAclsTrustedSync(checked);
    const configTrust = walkReplaceableChain({
      path: configPath,
      uid,
      hackHome: null,
      allowMissing: true,
    });
    if (!("error" in configTrust) && configTrust.complete) {
      if (statSync(configPath).size > 1024 * 1024) {
        throw new Error("Docker configuration exceeds bound");
      }
      // Credential fields stay inside this parser and never enter diagnostics.
      const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!isRecord(config)) {
        throw new Error("Invalid Docker configuration");
      }
      if (config.cliPluginsExtraDirs !== undefined) {
        // Custom plugin discovery is not part of the fixed login toolchain.
        throw new Error("Custom plugin search path requires manual startup");
      }
    }
  } catch {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Automatic startup refused unsafe Docker engine-selection files. Review Docker configuration ownership and permissions before retrying. Values omitted.",
      detail: { reason: "docker_config_untrusted" },
    });
  }
}
