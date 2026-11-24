import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { YAML } from "bun";
import { isRecord } from "./guards.ts";
import { serviceMounts } from "./local-directories.ts";

export const ROOT_OWNED_CHECK = "root-owned checkout files";
const ENTRY_LIMIT = 4096;
const REPORT_LIMIT = 12;
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Bidi_Control}]/gu;
const WALK_MS = 500;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type OwnedPath = { path: string; directory: boolean };

/** Reopen a queued directory without following any checkout-relative component. */
async function openBelow(base: string, parts: readonly string[]) {
  let handle = await open(`${base}/${parts[0] ?? "."}`, DIRECTORY_FLAGS);
  for (const part of parts.slice(1)) {
    const parent = handle;
    try {
      handle = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        DIRECTORY_FLAGS
      );
    } finally {
      await parent.close();
    }
  }
  return handle;
}

export async function findCheckoutFilesOwnedBy(opts: {
  readonly root: string;
  readonly uid: number;
  readonly owns?: (path: string, uid: number) => boolean;
}): Promise<{ paths: OwnedPath[]; incomplete: boolean }> {
  const deadline = performance.now() + WALK_MS;
  let remaining = ENTRY_LIMIT;
  let incomplete = false;
  const paths: OwnedPath[] = [];
  const queue: string[][] = [[]];
  const withinBudget = () =>
    remaining > 0 &&
    paths.length < REPORT_LIMIT &&
    performance.now() < deadline;

  async function scan(base: string, parts: string[]) {
    for await (const entry of await opendir(base)) {
      if (!withinBudget()) {
        incomplete = true;
        break;
      }
      remaining -= 1;
      if (entry.name !== ".git") {
        await visit(base, parts, entry.name).catch(() => {
          incomplete = true;
        });
      }
    }
  }

  async function visit(base: string, parts: string[], name: string) {
    const path = join(opts.root, ...parts, name);
    const stat = await lstat(join(base, name));
    const directory = stat.isDirectory();
    if (
      (directory || stat.isFile()) &&
      (opts.owns?.(path, stat.uid) ?? stat.uid === opts.uid)
    ) {
      paths.push({ path, directory });
    } else if (directory && parts.length < 31) {
      queue.push([...parts, name]);
    } else if (directory) {
      incomplete = true;
    }
  }

  const root = await open(opts.root, DIRECTORY_FLAGS).catch(() => null);
  if (!root) {
    return { paths, incomplete: true };
  }
  try {
    for (const parts of queue) {
      if (!withinBudget()) {
        incomplete = true;
        break;
      }
      try {
        const handle = await openBelow(`/proc/self/fd/${root.fd}`, parts);
        try {
          await scan(`/proc/self/fd/${handle.fd}`, parts);
        } finally {
          await handle.close();
        }
      } catch {
        incomplete = true;
      }
    }
  } finally {
    await root.close();
  }
  return { paths, incomplete };
}

export async function checkRootOwnedCheckout(
  opts: { readonly projectRoot: string; readonly composeFile: string },
  ownerUid = 0
): Promise<{
  readonly name: typeof ROOT_OWNED_CHECK;
  readonly status: "ok" | "warn";
  readonly message: string;
}> {
  const observed = await findCheckoutFilesOwnedBy({
    root: opts.projectRoot,
    uid: ownerUid,
  });
  if (observed.paths.length === 0) {
    return {
      name: ROOT_OWNED_CHECK,
      status: "ok",
      message: observed.incomplete
        ? `No root-owned checkout paths found in a partial scan (up to ${ENTRY_LIMIT.toLocaleString("en-US")} entries, ${WALK_MS} ms, and 32 directory levels).`
        : "No root-owned checkout paths found.",
    };
  }
  const compose: unknown = await Bun.file(opts.composeFile)
    .text()
    .then((text) => YAML.parse(text))
    .catch(() => null);
  const services =
    isRecord(compose) && isRecord(compose.services)
      ? Object.entries(compose.services)
      : [];
  const servicesToFix = new Set<string>();
  const paths = observed.paths.map(({ path, directory }) => {
    const owners = services
      .filter(
        ([, spec]) =>
          isRecord(spec) &&
          !Object.hasOwn(spec, "user") &&
          serviceMounts(spec, dirname(opts.composeFile)).some(
            (mount) =>
              mount.type === "bind" &&
              !mount.readOnly &&
              mount.source !== undefined &&
              (path === mount.source ||
                path.startsWith(`${mount.source}/`) ||
                (directory && mount.source.startsWith(`${path}/`)))
          )
      )
      .map(([name]) => name);
    for (const name of owners) {
      servicesToFix.add(name);
    }
    return `${JSON.stringify(relative(opts.projectRoot, path)).replace(UNSAFE_TERMINAL_TEXT, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}${owners.length ? ` (possible services: ${owners.join(", ")})` : ""}`;
  });
  return {
    name: ROOT_OWNED_CHECK,
    status: "warn",
    message: [
      `Root-owned checkout paths: ${paths.join(", ")}.`,
      observed.incomplete
        ? "This list may be partial. Rerun Doctor after repair to find more."
        : "",
      servicesToFix.size
        ? `Set user: "${process.getuid?.()}:${process.getgid?.()}" on ${[...servicesToFix].join(", ")} in the Compose file.`
        : "",
      "Before repairing ownership manually, stop all containers and other processes that can write to the checkout. Verify that each target is inside the checkout and that neither the target nor any component of its full path is a symlink. If you cannot keep those paths stable during repair, leave ownership unchanged.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
