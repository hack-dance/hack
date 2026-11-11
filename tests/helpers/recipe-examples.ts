import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "../../src/lib/guards.ts";

/**
 * Static checks for the recipe and config-example projects under
 * `examples/recipes` and `examples/configs`. Every function returns closed,
 * value-free issue codes so a test can assert an exact list, and a negative
 * control can show which rule a mutation broke.
 */

/** The two example roots, relative to the repository root. */
export const RECIPE_EXAMPLE_ROOTS = [
  "examples/configs",
  "examples/recipes",
] as const;

/** Repository-relative directories of every example project (has `.hack/`). */
export async function listRecipeExamples(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const root of RECIPE_EXAMPLE_ROOTS) {
    const entries = await readdir(join(repoRoot, root), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = `${root}/${entry.name}`;
      if (
        await Bun.file(join(repoRoot, dir, ".hack/hack.config.json")).exists()
      ) {
        found.push(dir);
      }
    }
  }
  return found.sort();
}

type Services = Record<string, Record<string, unknown>>;

function services(compose: Record<string, unknown>): Services {
  const raw = compose.services;
  const result: Services = {};
  if (!isRecord(raw)) {
    return result;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      result[name] = value;
    }
  }
  return result;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function labels(service: Record<string, unknown>): Record<string, string> {
  const raw = service.labels;
  const result: Record<string, string> = {};
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
  }
  return result;
}

function networks(service: Record<string, unknown>): string[] {
  const raw = service.networks;
  if (Array.isArray(raw)) {
    return stringList(raw);
  }
  return isRecord(raw) ? Object.keys(raw) : [];
}

/** Compose `volumes` entries of one service, as `source:target[:mode]`. */
function mounts(service: Record<string, unknown>): string[] {
  return stringList(service.volumes);
}

function mountTarget(mount: string): { source: string; target: string } {
  const [source = "", target = ""] = mount.split(":");
  return { source, target };
}

const RUNTIME_IMAGE = /^(oven\/bun|node):/;

/**
 * Compose rules every example follows:
 * - the Compose `name` equals the config `name`;
 * - every image has an explicit tag that is not `latest`;
 * - a `caddy` route is the dev host or a subdomain of it, and its service
 *   joins the external `hack-dev` network;
 * - a `depends_on` target exists.
 */
export function composeIssues(opts: {
  readonly compose: Record<string, unknown>;
  readonly configName: string;
  readonly devHost: string;
}): string[] {
  const issues: string[] = [];
  if (opts.compose.name !== opts.configName) {
    issues.push("compose-name-differs-from-config");
  }
  const all = services(opts.compose);
  if (Object.keys(all).length === 0) {
    issues.push("no-services");
  }
  const topNetworks = opts.compose.networks;
  const hackDev = isRecord(topNetworks) ? topNetworks["hack-dev"] : undefined;
  const hackDevExternal = isRecord(hackDev) && hackDev.external === true;
  for (const [name, service] of Object.entries(all)) {
    issues.push(
      ...imageIssues(service).map((issue) => `${name}: ${issue}`),
      ...routeIssues({ service, devHost: opts.devHost }).map(
        (issue) => `${name}: ${issue}`
      ),
      ...dependsOnTargets(service)
        .filter((target) => !all[target])
        .map(() => `${name}: depends-on-unknown-service`)
    );
    if (labels(service).caddy !== undefined && !hackDevExternal) {
      issues.push("hack-dev-not-external");
    }
  }
  return [...new Set(issues)];
}

function imageIssues(service: Record<string, unknown>): string[] {
  const image = service.image;
  if (typeof image !== "string" || !/:[^/:]+$/.test(image)) {
    return ["image-without-tag"];
  }
  return image.endsWith(":latest") ? ["image-latest"] : [];
}

function routeIssues(opts: {
  readonly service: Record<string, unknown>;
  readonly devHost: string;
}): string[] {
  const route = labels(opts.service).caddy;
  if (route === undefined) {
    return [];
  }
  const issues = route
    .split(",")
    .map((item) => item.trim())
    .filter(
      (host) => host !== opts.devHost && !host.endsWith(`.${opts.devHost}`)
    )
    .map(() => "route-outside-dev-host");
  if (!networks(opts.service).includes("hack-dev")) {
    issues.push("route-without-hack-dev");
  }
  return issues;
}

function dependsOnTargets(service: Record<string, unknown>): string[] {
  const dependsOn = service.depends_on;
  if (Array.isArray(dependsOn)) {
    return stringList(dependsOn);
  }
  return isRecord(dependsOn) ? Object.keys(dependsOn) : [];
}

/**
 * The deps-service pattern, for a project whose packages install in
 * containers. Every Node or Bun service that mounts the source (`..:/app`)
 * must mount each volume the `deps` service mounts under `/app` at the same
 * path, and wait for `deps` with `service_completed_successfully`.
 */
export function depsPatternIssues(compose: Record<string, unknown>): string[] {
  const all = services(compose);
  const deps = all.deps;
  if (!deps) {
    return ["no-deps-service"];
  }
  const issues: string[] = [];
  const depsCommand = stringList(deps.command).join(" ");
  if (!/(--frozen-lockfile|\bci\b|--immutable|pip install)/.test(depsCommand)) {
    issues.push("deps-install-not-locked");
  }
  const depsVolumes = mounts(deps)
    .map(mountTarget)
    .filter((mount) => mount.source !== ".." && mount.target.startsWith("/"));
  for (const [name, service] of Object.entries(all)) {
    if (name === "deps" || typeof service.image !== "string") {
      continue;
    }
    if (!RUNTIME_IMAGE.test(service.image)) {
      continue;
    }
    const own = mounts(service).map(mountTarget);
    if (!own.some((mount) => mount.source === "..")) {
      continue;
    }
    for (const volume of depsVolumes) {
      if (
        !own.some(
          (mount) =>
            mount.source === volume.source && mount.target === volume.target
        )
      ) {
        issues.push(`${name}: missing-deps-volume`);
      }
    }
    const dependsOn = service.depends_on;
    const gate = isRecord(dependsOn) ? dependsOn.deps : undefined;
    if (
      !(isRecord(gate) && gate.condition === "service_completed_successfully")
    ) {
      issues.push(`${name}: not-gated-on-deps`);
    }
  }
  return [...new Set(issues)];
}

/** Exact dependency versions from one `package.json`, workspace links excluded. */
export function pinnedDependencies(packageJson: unknown): string[] {
  if (!isRecord(packageJson)) {
    return [];
  }
  const result: string[] = [];
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = packageJson[field];
    if (!isRecord(deps)) {
      continue;
    }
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === "string" && !version.startsWith("workspace:")) {
        result.push(`${name}@${version}`);
      }
    }
  }
  return result;
}

/** Each pinned dependency must be an exact version recorded in `bun.lock`. */
export function lockfileIssues(opts: {
  readonly pinned: readonly string[];
  readonly lockfile: string | null;
}): string[] {
  if (opts.pinned.length === 0) {
    return [];
  }
  if (opts.lockfile === null) {
    return ["missing-lockfile"];
  }
  const issues: string[] = [];
  for (const entry of opts.pinned) {
    const version = entry.slice(entry.lastIndexOf("@") + 1);
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      issues.push("dependency-not-exact");
    } else if (!opts.lockfile.includes(`"${entry}"`)) {
      issues.push("dependency-not-in-lockfile");
    }
  }
  return [...new Set(issues)];
}

/**
 * Env files are committed examples: `version: 1`, an `environment` that
 * matches the file name, scopes that are `global`, `host` or a service, and
 * no encrypted values (secrets belong in machine-local files).
 */
export function envFileIssues(opts: {
  readonly fileName: string;
  readonly document: unknown;
  readonly serviceNames: readonly string[];
}): string[] {
  if (opts.fileName.endsWith(".local.yaml")) {
    return ["local-env-file-committed"];
  }
  const match = /^hack\.env\.([a-z0-9-]+)\.yaml$/.exec(opts.fileName);
  if (!match || match[1] === undefined) {
    return ["unexpected-env-file-name"];
  }
  const doc = opts.document;
  if (!isRecord(doc)) {
    return ["env-file-not-a-mapping"];
  }
  const issues: string[] = [];
  if (doc.version !== 1) {
    issues.push("env-version");
  }
  if (doc.environment !== match[1]) {
    issues.push("env-name-differs-from-file");
  }
  const values = doc.values;
  if (!isRecord(values)) {
    issues.push("env-values-missing");
    return issues;
  }
  for (const [scope, entries] of Object.entries(values)) {
    if (!["global", "host", ...opts.serviceNames].includes(scope)) {
      issues.push("env-unknown-scope");
    }
    if (isRecord(entries) && Object.values(entries).some(isRecord)) {
      issues.push("env-committed-secret");
    }
  }
  return [...new Set(issues)];
}

/** Lifecycle commands of the form `sh <path>` or `bun <path>` name a file that exists. */
export function lifecycleScriptPaths(config: unknown): string[] {
  const paths: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const command = value.command;
    if (typeof command === "string") {
      const script = /^(?:sh|bun)\s+(scripts\/\S+)/.exec(command);
      if (script?.[1]) {
        paths.push(script[1]);
      }
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  if (isRecord(config)) {
    visit(config.lifecycle);
  }
  return paths;
}

/** Lifecycle script paths of a project's config that do not exist on disk. */
export async function missingLifecycleScripts(opts: {
  readonly projectDir: string;
  readonly config: unknown;
}): Promise<string[]> {
  const missing: string[] = [];
  for (const script of lifecycleScriptPaths(opts.config)) {
    if (!(await Bun.file(join(opts.projectDir, script)).exists())) {
      missing.push(script);
    }
  }
  return missing;
}
