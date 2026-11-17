import { isCaddySiteLabel } from "./branch-hosts.ts";
import { isRecord } from "./guards.ts";
import { exec, findExecutableInPath } from "./shell.ts";

/**
 * Running instances that claim the same Caddy host (HACK-2284). Caddy serves a
 * host once, so two instances that both list it share or steal its traffic.
 * This is an observation for a warning after `hack up`, never a gate: Docker
 * state can change at any time, and reading it may fail.
 */
export type RunningCaddySites = {
  readonly project: string | null;
  readonly sites: readonly string[];
};

const SITE_SEPARATOR = /[\s,]+/;
const SITE = /^(?:https?:\/\/)?(?<host>[^\s/:]+)(?::\d{1,5})?$/i;
// Only the compose project and the root site labels; nothing else is read.
const FORMAT =
  '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"labels":{ {{- range $key,$value := .Config.Labels}}{{if or (eq $key "caddy") (and (ge (len $key) 7) (eq (slice $key 0 6) "caddy_") (eq (len (split $key ".")) 1))}}{{json $key}}:{{json $value}},{{end}}{{end}}"":""}}';

/** Host names a Caddy site label lists (lowercase, no scheme or port). */
export function siteHostnames(value: string): string[] {
  const hosts: string[] = [];
  for (const site of value.split(SITE_SEPARATOR)) {
    const host = SITE.exec(site.trim())?.groups?.host?.toLowerCase();
    if (host) {
      hosts.push(host);
    }
  }
  return hosts;
}

/** Hosts `composeProject` lists that another running compose project lists too. */
export function sharedCaddyHosts(opts: {
  readonly composeProject: string;
  readonly running: readonly RunningCaddySites[];
}): { readonly host: string; readonly others: readonly string[] }[] {
  const owners = new Map<string, Set<string>>();
  for (const container of opts.running) {
    if (container.project === null) {
      continue;
    }
    for (const site of container.sites) {
      for (const host of siteHostnames(site)) {
        const set = owners.get(host) ?? new Set<string>();
        set.add(container.project);
        owners.set(host, set);
      }
    }
  }
  const shared: { host: string; others: string[] }[] = [];
  for (const [host, projects] of [...owners].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (projects.has(opts.composeProject) && projects.size > 1) {
      shared.push({
        host,
        others: [...projects].filter((p) => p !== opts.composeProject).sort(),
      });
    }
  }
  return shared;
}

/** Parse one `docker inspect` line in {@link FORMAT}; undefined when malformed. */
export function parseRunningCaddySites(
  line: string
): RunningCaddySites | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (
    !(
      isRecord(value) &&
      (value.project === null || typeof value.project === "string") &&
      isRecord(value.labels)
    )
  ) {
    return;
  }
  const sites: string[] = [];
  for (const [key, site] of Object.entries(value.labels)) {
    if (isCaddySiteLabel(key) && typeof site === "string") {
      sites.push(site);
    }
  }
  return { project: value.project as string | null, sites };
}

/** Root Caddy site labels of running containers, or null when Docker can't say. */
export async function readRunningCaddySites(): Promise<
  RunningCaddySites[] | null
> {
  if (!findExecutableInPath("docker")) {
    return null;
  }
  const ps = await exec(["docker", "ps", "-q", "--no-trunc"], {
    stdin: "ignore",
    timeoutMs: 10_000,
  });
  if (ps.exitCode !== 0) {
    return null;
  }
  const ids = ps.stdout
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    return [];
  }
  const inspect = await exec(
    ["docker", "inspect", "--format", FORMAT, ...ids],
    { stdin: "ignore", timeoutMs: 10_000 }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }
  const out: RunningCaddySites[] = [];
  for (const line of inspect.stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseRunningCaddySites(line);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

/**
 * Warn about each host this instance shares with another running instance.
 * Best effort: when Docker cannot be read, nothing is said.
 */
export async function warnSharedCaddyHosts(opts: {
  readonly composeProject: string;
  readonly warn: (message: string) => void;
  readonly read?: () => Promise<RunningCaddySites[] | null>;
}): Promise<void> {
  let running: RunningCaddySites[] | null;
  try {
    running = await (opts.read ?? readRunningCaddySites)();
  } catch {
    return;
  }
  if (!running) {
    return;
  }
  for (const { host, others } of sharedCaddyHosts({
    composeProject: opts.composeProject,
    running,
  })) {
    opts.warn(
      `Host ${host} is also claimed by running instance ${others.join(", ")}; Caddy will not route it to this instance alone. Stop the other instance or give each its own host.`
    );
  }
}
