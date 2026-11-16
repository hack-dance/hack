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
  isDarwinDaemonDirectory,
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

function visit(step: string, path: string, checked: Set<string>, depth = 0) {
  if (refusals.length > 0 || depth > 16) {
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
let host = DEFAULT_DOCKER_HOST;
try {
  const config: unknown = JSON.parse(
    readFileSync(join(home, ".docker/config.json"), "utf8")
  );
  if (
    typeof config === "object" &&
    config !== null &&
    "currentContext" in config &&
    typeof config.currentContext === "string" &&
    config.currentContext
  ) {
    context = config.currentContext;
  }
} catch {
  // No readable config: the default context.
}
if (context !== "default") {
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
    host = typeof endpoint === "string" ? endpoint : "(not a string)";
  } catch {
    host = "(context metadata unreadable)";
  }
}
console.log(`selected context: ${context}`);
console.log(`engine endpoint: ${host}`);

if (refusals.length === 0) {
  if (host.startsWith("unix://")) {
    const path = host.slice("unix://".length);
    const checked = new Set<string>();
    let physical: string | null = null;
    try {
      physical = realpathSync(path);
      console.log(`socket resolves to: ${describe(physical)}`);
      checked.add(physical);
    } catch {
      console.log("socket: missing (accepted as absent)");
    }
    const trust = walkReplaceableChain({
      path,
      uid,
      hackHome: null,
      checked,
      allowMissing: true,
      acceptDarwinAdminDirectories: true,
      acceptDarwinDaemonDirectories: true,
    });
    if ("error" in trust) {
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
          !isDarwinAdminDirectory(info) &&
          !isDarwinDaemonDirectory(info)
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

console.log(
  refusals.length === 0
    ? "first refused input: none"
    : `first refused input: ${refusals[0]}`
);
let decision = "accepted";
try {
  assertAutostartDockerConfigTrusted({ home, env: {} });
} catch {
  decision = "refused";
}
console.log(`product decision (login child): ${decision}`);
