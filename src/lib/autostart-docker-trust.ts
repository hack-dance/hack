import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { walkReplaceableChain } from "./path-trust.ts";

/** Authenticate Docker's engine-selection inputs without reading credentials. */
export function assertAutostartDockerConfigTrusted(opts: {
  readonly home: string;
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
  } catch {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Automatic startup refused unsafe Docker engine-selection files. Review Docker configuration ownership and permissions before retrying. Values omitted.",
      detail: { reason: "docker_config_untrusted" },
    });
  }
}
