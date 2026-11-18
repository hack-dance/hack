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
import { renderGlobalCaddyCompose } from "../templates.ts";
import { readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { readProxyBindFromCompose } from "./proxy-bind.ts";
import { exec } from "./shell.ts";

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const FRACTIONAL_SECONDS = /\.\d+Z$/;

/** Whether `text` is exactly one of the files Hack renders for this template. */
export function isHackRenderedProxyCompose(text: string): boolean {
  const bindAddress = readProxyBindFromCompose(text);
  for (const useStaticCoreDnsIp of [false, true]) {
    for (const useStaticCaddyIp of [false, true]) {
      const rendered = renderGlobalCaddyCompose({
        useStaticCoreDnsIp,
        useStaticCaddyIp,
        bindAddress,
      });
      if (rendered === text) {
        return true;
      }
    }
  }
  return false;
}

export type ManagedProxyComposeWrite =
  | { readonly kind: "unchanged" }
  | { readonly kind: "written" }
  | { readonly kind: "replaced-hand-edit"; readonly backupPath: string };

/**
 * Writes the rendered proxy Compose file without prompting. A hand-edited
 * existing file is copied to `<path>.bak-<UTC stamp>` first.
 */
export async function writeManagedProxyCompose(opts: {
  readonly path: string;
  readonly content: string;
  /** Injected for tests; defaults to the current time. */
  readonly now?: Date;
}): Promise<ManagedProxyComposeWrite> {
  const existing = await readTextFile(opts.path);
  if (existing === opts.content) {
    return { kind: "unchanged" };
  }
  if (existing === null || isHackRenderedProxyCompose(existing)) {
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
  | { readonly kind: "removed"; readonly ids: readonly string[] }
  | {
      readonly kind: "failed";
      /** Ids that could not be removed; empty when listing itself failed. */
      readonly ids: readonly string[];
      /** What the user can run instead. */
      readonly message: string;
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
    };
  }
  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CONTAINER_ID.test(line));
  if (ids.length === 0) {
    return { kind: "none" };
  }
  const removed = await exec(["docker", "rm", ...ids], {
    stdin: "ignore",
    timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS,
  });
  if (removed.exitCode !== 0) {
    return {
      kind: "failed",
      ids,
      message: `Could not remove the never-started proxy container (${ids.join(", ")}); it would start with no network next time. Remove it with: docker rm ${ids.join(" ")}`,
    };
  }
  return { kind: "removed", ids };
}
