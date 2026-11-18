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
  const backupPath = `${opts.path}.bak-${stamp}`;
  await copyFile(opts.path, backupPath);
  await writeTextFileIfChanged(opts.path, opts.content);
  return { kind: "replaced-hand-edit", backupPath };
}

/**
 * Removes global proxy containers that Docker created but never started.
 *
 * When `docker compose up` fails while publishing ports (for example :443 is
 * in use), the proxy container stays in `created` state with no network
 * endpoint. A later `up` with an unchanged file starts that container as is,
 * and it runs attached to no network. Only containers of this Compose project
 * in `created` state are removed: they never ran, so they hold no state.
 * Returns the removed container ids.
 */
export async function removeUnstartedProxyContainers(): Promise<
  readonly string[]
> {
  const listed = await exec(
    [
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT_NAME}`,
      "--filter",
      "status=created",
    ],
    { stdin: "ignore" }
  );
  if (listed.exitCode !== 0) {
    return [];
  }
  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CONTAINER_ID.test(line));
  if (ids.length === 0) {
    return [];
  }
  const removed = await exec(["docker", "rm", ...ids], {
    stdin: "ignore",
  });
  return removed.exitCode === 0 ? ids : [];
}
