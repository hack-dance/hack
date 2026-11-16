/**
 * Contributor diagnostic: what automatic startup's Docker trust check decides
 * on this machine, and the first input it refuses.
 *
 *   bun scripts/diagnose-autostart-docker-trust.ts
 *
 * It mirrors `assertAutostartDockerConfigTrusted` for the login child, which
 * gets no `DOCKER_*` variables: `~/.docker` selection inputs, the fixed system
 * plugin directories, then the engine socket of the selected context (the
 * default `/var/run/docker.sock` when none is selected). It prints path names,
 * owners, groups and modes only: never file contents, config values or
 * credentials. It changes nothing. The last line is the product's own decision.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertAutostartDockerConfigTrusted,
  DEFAULT_DOCKER_HOST,
  DOCKER_SYSTEM_PLUGIN_DIRECTORIES,
} from "../src/lib/autostart-docker-trust.ts";
import { hasDevMutationAcl } from "../src/lib/dev-acl.ts";
import {
  isDarwinAdminDirectory,
  walkReplaceableChain,
} from "../src/lib/path-trust.ts";

const home = homedir();
const uid = process.getuid?.() ?? -1;
const refusals: string[] = [];
const describe = (path: string): string => {
  try {
    const info = lstatSync(path);
    const kind = info.isSymbolicLink()
      ? "link"
      : info.isDirectory()
        ? "dir"
        : info.isSocket()
          ? "socket"
          : "file";
    return `${path} (${kind}, uid ${info.uid}, gid ${info.gid}, mode ${(info.mode & 0o7777).toString(8)})`;
  } catch {
    return `${path} (missing)`;
  }
};
const refuse = (step: string, reason: string): void => {
  refusals.push(`${step}: ${reason}`);
};

function aclRefusal(paths: Iterable<string>): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  for (const path of paths) {
    const result = spawnSync("/bin/ls", ["-blde", "--", path], {
      env: { LC_ALL: "C" },
      timeout: 3000,
    });
    if (result.status !== 0) {
      return `ACL inspection failed for ${describe(path)}`;
    }
    if (hasDevMutationAcl(result.stdout.toString("utf8"))) {
      return `mutation ACL on ${describe(path)}`;
    }
  }
  return null;
}

let visited = 0;
function visit(step: string, path: string, checked: Set<string>, depth = 0) {
  if (refusals.length > 0) {
    return;
  }
  visited += 1;
  if (visited > 4096 || depth > 16) {
    refuse(step, "selection inputs exceed the 4096-entry or depth-16 bound");
    return;
  }
  const trust = walkReplaceableChain({
    path,
    uid,
    hackHome: null,
    checked,
    allowMissing: true,
    acceptDarwinAdminDirectories: true,
  });
  if ("error" in trust) {
    refuse(step, trust.error);
    return;
  }
  const existing = statSync(trust.existing);
  if (
    existing.isDirectory() &&
    (existing.mode & 0o022) !== 0 &&
    !isDarwinAdminDirectory(existing)
  ) {
    refuse(
      step,
      `${describe(trust.existing)} lets others create the missing ${path}`
    );
    return;
  }
  if (!(trust.complete && statSync(path).isDirectory())) {
    return;
  }
  for (const name of readdirSync(path)) {
    visit(step, join(path, name), checked, depth + 1);
  }
}

const selection = new Set<string>();
for (const name of ["config.json", "contexts", "cli-plugins"]) {
  visit("docker selection input", join(home, ".docker", name), selection);
}
for (const directory of DOCKER_SYSTEM_PLUGIN_DIRECTORIES) {
  visit("system plugin directory", directory, selection);
}
if (refusals.length === 0) {
  const acl = aclRefusal(selection);
  if (acl) {
    refuse("docker selection ACL", acl);
  }
}

let context = "default";
let host: string | null = DEFAULT_DOCKER_HOST;
const configPath = join(home, ".docker/config.json");
try {
  if (statSync(configPath).size > 1024 * 1024) {
    refuse("docker config", "config.json exceeds 1 MiB");
  }
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    refuse("docker config", "config.json is not a JSON object");
  } else {
    const record = config as Record<string, unknown>;
    if (record.currentContext !== undefined) {
      if (typeof record.currentContext === "string") {
        context = record.currentContext || "default";
      } else {
        refuse("docker config", "currentContext is not a string");
      }
    }
    if (record.cliPluginsExtraDirs !== undefined) {
      refuse("docker config", "cliPluginsExtraDirs requires a manual start");
    }
  }
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    refuse("docker config", "config.json could not be read or parsed");
  }
}
if (context !== "default") {
  host = null;
  try {
    const digest = createHash("sha256").update(context).digest("hex");
    const meta: unknown = JSON.parse(
      readFileSync(
        join(home, ".docker/contexts/meta", digest, "meta.json"),
        "utf8"
      )
    );
    const endpoint = (meta as { Endpoints?: { docker?: { Host?: unknown } } })
      .Endpoints?.docker?.Host;
    if (typeof endpoint === "string") {
      host = endpoint;
    } else {
      refuse("docker context", "the context has no string Docker endpoint");
    }
  } catch {
    refuse("docker context", "context metadata is missing or unreadable");
  }
}
// Endpoint values can carry credentials: print only the transport, and the
// path for a unix socket (a filesystem name).
const transport =
  host === null
    ? "unknown"
    : (/^([a-z][a-z0-9+.-]*):\/\//i.exec(host)?.[1] ?? "unknown");
console.log(
  `selected context: ${context === "default" ? "default" : "(named)"}`
);
console.log(
  `engine endpoint: ${transport}${transport === "unix" && host ? ` ${host.slice("unix://".length)}` : ""}`
);

if (refusals.length === 0) {
  if (host?.startsWith("unix://")) {
    const path = host.slice("unix://".length);
    const checked = new Set<string>();
    let physical: string | null = null;
    try {
      physical = realpathSync(path);
      console.log(`socket resolves to: ${describe(physical)}`);
      const info = lstatSync(physical);
      if (!info.isSocket() || (info.uid !== uid && info.uid !== 0)) {
        refuse(
          "socket",
          `${describe(physical)} is not a socket owned by you or root`
        );
      }
      checked.add(physical);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        console.log("socket: missing (accepted as absent)");
      } else {
        refuse("socket", "the socket path could not be resolved");
      }
    }
    const trust = walkReplaceableChain({
      path,
      uid,
      hackHome: null,
      checked,
      allowMissing: true,
      acceptDarwinAdminDirectories: true,
    });
    if (refusals.length > 0) {
      // Already refused above.
    } else if ("error" in trust) {
      refuse("socket path", trust.error);
    } else {
      for (const entry of checked) {
        if (entry === physical) {
          continue;
        }
        const info = lstatSync(entry);
        if (
          info.isDirectory() &&
          (info.mode & 0o022) !== 0 &&
          !isDarwinAdminDirectory(info)
        ) {
          refuse("socket parent", `${describe(entry)} is replaceable`);
          break;
        }
      }
      if (refusals.length === 0) {
        const acl = aclRefusal(checked);
        if (acl) {
          refuse("socket ACL", acl);
        }
      }
    }
  } else {
    refuse("engine endpoint", "not a unix socket (automatic startup refuses)");
  }
}

let decision = "accepted";
try {
  assertAutostartDockerConfigTrusted({ home, env: {} });
} catch {
  decision = "refused";
}
console.log(
  refusals.length > 0
    ? `first refused input: ${refusals[0]}`
    : decision === "refused"
      ? "first refused input: not identified by this diagnostic (for example a symlink cycle); the product refused"
      : "first refused input: none"
);
console.log(`product decision (login child): ${decision}`);
if (refusals[0]?.startsWith("socket") && context === "default") {
  console.log(
    "hint: no Docker context is selected, so the default /var/run/docker.sock is used; select your engine's own context (for example: docker context use orbstack, or desktop-linux), whose socket is in your home"
  );
}
