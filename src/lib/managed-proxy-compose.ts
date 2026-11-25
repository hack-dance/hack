/**
 * The global proxy Compose file (`~/.hack/caddy/docker-compose.yml`) is Hack's
 * own output: `hack global install` and `hack doctor --fix` render it from
 * settings (`proxy.bind_address`, and whether the ingress network has the
 * static subnet). A changed setting must reach the file without a prompt, or a
 * run without a terminal keeps the stale file and the setting never applies
 * (HACK-2328).
 *
 * Invariant: a file that differs from every Hack rendering was edited by hand.
 * Before replacing such a file, its bytes are copied to a timestamped
 * `.bak-<UTC>` sibling, so a hand edit is never lost. A file matching some
 * Hack rendering (for other settings) is replaced without a backup.
 */
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";

import { GLOBAL_CADDY_PROJECT_NAME } from "../constants.ts";
import {
  renderGlobalCaddyCompose,
  renderGlobalLoggingCompose,
} from "../templates.ts";
import { updateGlobalConfig } from "./config.ts";
import { readTextFile, writeTextFileIfChanged } from "./fs.ts";
import {
  PROXY_BIND_CONFIG_KEY,
  parseProxyBindAddress,
  readProxyBindFromCompose,
  resolveProxyBindAddress,
} from "./proxy-bind.ts";
import { exec } from "./shell.ts";

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const FRACTIONAL_SECONDS = /\.\d+Z$/;

/** Whether `text` is exactly one of the files Hack renders for this template. */
export function isHackRenderedProxyCompose(text: string): boolean {
  const bindAddress = readProxyBindFromCompose(text);
  for (const useStaticCoreDnsIp of [false, true]) {
    for (const useStaticCaddyIp of [false, true]) {
      // Either healthcheck variant: the file is rendered for its engine.
      for (const startInterval of [false, true]) {
        const rendered = renderGlobalCaddyCompose({
          useStaticCoreDnsIp,
          useStaticCaddyIp,
          bindAddress,
          startInterval,
        });
        if (rendered === text) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Whether `text` is exactly one of the logging Compose files Hack renders. */
export function isHackRenderedLoggingCompose(text: string): boolean {
  return [false, true].some(
    (startInterval) => renderGlobalLoggingCompose({ startInterval }) === text
  );
}

/**
 * Which host addresses an existing proxy Compose file publishes the `caddy`
 * ports on, read as YAML so any valid Compose syntax counts: short mappings in
 * any quoting, with comments or a protocol suffix, and the long form with
 * `host_ip`. `all` when no mapping names a host address (Docker's default);
 * `address` when every mapping names the same one (wildcards included, since
 * `0.0.0.0` and `::` each cover one address family only); `unknown` for
 * anything else (no caddy ports, mixed or different addresses, unparsable).
 */
export type ProxyBindScope =
  | { readonly kind: "all" }
  | { readonly kind: "address"; readonly address: string }
  | { readonly kind: "unknown" };

const PROTOCOL_SUFFIX = /\/(?:tcp|udp|sctp)$/;

/** The host address of one Compose port mapping, "" for none, null if unreadable. */
function mappingHostAddress(mapping: unknown): string | null {
  if (typeof mapping === "number") {
    return "";
  }
  if (typeof mapping === "string") {
    const spec = mapping.trim().replace(PROTOCOL_SUFFIX, "");
    if (spec.startsWith("[")) {
      const close = spec.indexOf("]");
      return close > 1 && spec[close + 1] === ":" ? spec.slice(1, close) : null;
    }
    const parts = spec.split(":");
    if (parts.length <= 2) {
      return "";
    }
    return parts.length === 3 ? (parts[0] ?? null) : null;
  }
  if (mapping !== null && typeof mapping === "object") {
    const hostIp = (mapping as { host_ip?: unknown }).host_ip;
    if (hostIp === undefined) {
      return "";
    }
    return typeof hostIp === "string" ? hostIp : null;
  }
  return null;
}

export function readProxyBindScope(text: string): ProxyBindScope {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return { kind: "unknown" };
  }
  const ports = (
    parsed as { services?: { caddy?: { ports?: unknown } } } | null
  )?.services?.caddy?.ports;
  if (!Array.isArray(ports) || ports.length === 0) {
    return { kind: "unknown" };
  }
  const hosts = new Set<string>();
  for (const mapping of ports) {
    const host = mappingHostAddress(mapping);
    if (host === null) {
      return { kind: "unknown" };
    }
    hosts.add(host);
  }
  if (hosts.size !== 1) {
    return { kind: "unknown" };
  }
  const [host] = [...hosts];
  if (host === "") {
    return { kind: "all" };
  }
  try {
    return { kind: "address", address: parseProxyBindAddress(host ?? "") };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * The address to render the proxy ports with (HACK-2328, Codex security
 * reviews). Because the file is now rewritten without a prompt, an existing
 * file must never be widened while `proxy.bind_address` is unset: that would
 * expose routes such as the unauthenticated Loki endpoint to LAN and tunnel
 * peers. So, with the setting unset:
 * - a file publishing every caddy port on one address (wildcards included) has
 *   that address written into `proxy.bind_address`, so the file, login
 *   autostart's check and `hack config get` agree;
 * - a file whose binding cannot be determined is left as it is (`keep`), with
 *   the reason, until the user sets the address or moves the file aside;
 * - a missing file, or one publishing on every interface, renders the default.
 * If the address cannot be saved (for example the global config is not valid
 * JSON), the file is still rendered with it and `saveError` says why.
 */
export async function resolveManagedProxyBind(opts: {
  readonly path: string;
}): Promise<{
  readonly bindAddress: string | null;
  /** The address moved from the file into config, or null. */
  readonly migrated: string | null;
  /** Why the address could not be saved into config. */
  readonly saveError?: string;
  /** Why the existing file must be left unchanged. */
  readonly keep?: string;
}> {
  const configured = await resolveProxyBindAddress();
  if (configured !== null) {
    return { bindAddress: configured, migrated: null };
  }
  const existing = await readTextFile(opts.path);
  if (existing === null) {
    return { bindAddress: null, migrated: null };
  }
  const scope = readProxyBindScope(existing);
  if (scope.kind === "all") {
    return { bindAddress: null, migrated: null };
  }
  if (scope.kind === "unknown") {
    return {
      bindAddress: null,
      migrated: null,
      keep: `could not tell which addresses ${opts.path} publishes the proxy on, so it was left unchanged. Set the address with hack config set --global proxy.bind_address <address>, or move the file aside, then rerun`,
    };
  }
  const address = scope.address;
  try {
    await updateGlobalConfig({ path: PROXY_BIND_CONFIG_KEY, value: address });
  } catch (error: unknown) {
    // Never widen: keep rendering the restricted address even unsaved.
    return {
      bindAddress: address,
      migrated: null,
      saveError: error instanceof Error ? error.message : String(error),
    };
  }
  return { bindAddress: address, migrated: address };
}

export type ManagedProxyComposeWrite =
  | { readonly kind: "unchanged" }
  | { readonly kind: "written" }
  | { readonly kind: "replaced-hand-edit"; readonly backupPath: string };

/**
 * Writes a rendered global Compose file (the proxy's, or the logging
 * stack's) without prompting: Hack owns these files, and an engine upgrade
 * changes their healthchecks. An existing file that is not one of Hack's
 * renderings (edited by hand, or written by an older Hack) is copied to
 * `<path>.bak-<UTC stamp>` first.
 */
export async function writeManagedProxyCompose(opts: {
  readonly path: string;
  readonly content: string;
  /** Injected for tests; defaults to the current time. */
  readonly now?: Date;
  /** Which existing text is Hack's own; defaults to the proxy template. */
  readonly isHackRendered?: (text: string) => boolean;
}): Promise<ManagedProxyComposeWrite> {
  const existing = await readTextFile(opts.path);
  if (existing === opts.content) {
    return { kind: "unchanged" };
  }
  const isHackRendered = opts.isHackRendered ?? isHackRenderedProxyCompose;
  if (existing === null || isHackRendered(existing)) {
    await writeTextFileIfChanged(opts.path, opts.content);
    return { kind: "written" };
  }
  const stamp = (opts.now ?? new Date())
    .toISOString()
    .replaceAll(":", "")
    .replace(FRACTIONAL_SECONDS, "Z");
  const backupPath = await copyToFreshBackup({
    path: opts.path,
    base: `${opts.path}.bak-${stamp}`,
  });
  await writeTextFileIfChanged(opts.path, opts.content);
  return { kind: "replaced-hand-edit", backupPath };
}

/**
 * Copies `path` to `base`, or `base-1`, `base-2`… when that name exists, never
 * overwriting an earlier backup (two replacements within one second share a
 * timestamp). Returns the path written.
 */
async function copyToFreshBackup(opts: {
  readonly path: string;
  readonly base: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? opts.base : `${opts.base}-${attempt}`;
    try {
      await copyFile(opts.path, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(
    `Too many backups named ${opts.base}; remove old ones and retry`
  );
}

/** Outcome of {@link removeUnstartedProxyContainers}. */
export type UnstartedProxyCleanup =
  | { readonly kind: "none" }
  | {
      readonly kind: "removed";
      readonly ids: readonly string[];
      /** Why Docker could not start them; see {@link readStartErrors}. */
      readonly startError: string | null;
    }
  | {
      readonly kind: "failed";
      /** Ids that could not be removed; empty when listing itself failed. */
      readonly ids: readonly string[];
      /** What the user can run instead. */
      readonly message: string;
      /** Why Docker could not start them; null when listing failed. */
      readonly startError: string | null;
    };

const DOCKER_CLEANUP_TIMEOUT_MS = 15_000;

/**
 * Removes global proxy (`caddy` service) containers that Docker created but
 * never started.
 *
 * When `docker compose up` fails while publishing ports (for example :443 is
 * in use), the proxy container stays in `created` state with no network
 * endpoint. A later `up` with an unchanged file starts that container as is,
 * and it runs attached to no network. Only this Compose project's `caddy`
 * containers in `created` state are removed: they never ran, so they hold no
 * state, and named volumes are untouched. A concurrent `hack global up` may
 * hold its own container in `created` for a moment between create and start;
 * removing it then makes that start fail recoverably, which is accepted.
 * Each Docker call is bounded, and a failure is returned, not hidden.
 */
export async function removeUnstartedProxyContainers(): Promise<UnstartedProxyCleanup> {
  const listed = await exec(
    [
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT_NAME}`,
      "--filter",
      "label=com.docker.compose.service=caddy",
      "--filter",
      "status=created",
    ],
    { stdin: "ignore", timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS }
  );
  if (listed.exitCode !== 0) {
    return {
      kind: "failed",
      ids: [],
      message: `Could not list never-started proxy containers; check with: docker ps --all --filter label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT_NAME} --filter label=com.docker.compose.service=caddy --filter status=created, and remove any with docker rm <id> before retrying`,
      startError: null,
    };
  }
  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CONTAINER_ID.test(line));
  if (ids.length === 0) {
    return { kind: "none" };
  }
  const startError = await readStartErrors(ids);
  const removed = await exec(["docker", "rm", ...ids], {
    stdin: "ignore",
    timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS,
  });
  if (removed.exitCode !== 0) {
    return {
      kind: "failed",
      ids,
      message: `Could not remove the never-started proxy container (${ids.join(", ")}); it would start with no network next time. Remove it with: docker rm ${ids.join(" ")}`,
      startError,
    };
  }
  return { kind: "removed", ids, startError };
}

/**
 * The error Docker recorded when it could not start these containers
 * (`.State.Error`, for example a port it could not publish), one line per
 * container that has one. Null when the read failed or none recorded one,
 * so callers cannot tell why the start failed. Read before the containers
 * are removed, for the port hint (HACK-2673).
 */
async function readStartErrors(ids: readonly string[]): Promise<string | null> {
  const inspected = await exec(
    ["docker", "inspect", "--format", "{{.State.Error}}", ...ids],
    { stdin: "ignore", timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS }
  );
  if (inspected.exitCode !== 0) {
    return null;
  }
  const lines = inspected.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? null : lines.join("\n");
}
