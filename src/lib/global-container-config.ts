import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename } from "node:path";

/**
 * The global files and directories that containers running as a non-root
 * user read through a bind mount, with the mode each needs (HACK-2381).
 *
 * CoreDNS (`nonroot`), Loki (uid 10001) and Grafana (uid 472) are not the
 * user who wrote these files. Docker mounts a single file by its inode, so
 * the file must be readable by others but its parent directories need not
 * be; a mounted directory must also be searchable. Written under a strict
 * umask (077: a user's own shell setting, or the prerelease manager before
 * it restored the caller's umask) they were 0600/0700 and the three
 * containers exited with "permission denied".
 *
 * Hack widens a mode only for content it knows: a file whose bytes are
 * exactly the template Hack renders, and the dashboards directory only when
 * it holds nothing but Hack's own dashboard with that content. Those hold
 * service addresses, ports and dashboard layout, nothing secret. A file the
 * user customised (`global install` keeps a differing file unless the user
 * agrees to overwrite it) may hold anything, for example a datasource with
 * credentials, so its mode is never changed here. The list is closed on
 * purpose: Compose files, the global config, the project registry, env keys,
 * certificates and Caddy's data (a Docker volume, not a host directory) are
 * not in it.
 */
export type ContainerReadablePath =
  | {
      readonly kind: "file";
      readonly path: string;
      /** The template Hack renders for this file. */
      readonly template: string;
      /** The container and user that reads it. */
      readonly reader: string;
    }
  | {
      readonly kind: "directory";
      readonly path: string;
      /** The one file Hack puts in it, and that file's template. */
      readonly onlyFile: string;
      readonly template: string;
      readonly reader: string;
    };

/** 0644 for a file, 0755 for a directory. */
export function containerReadableMode(kind: "file" | "directory"): number {
  return kind === "file" ? 0o644 : 0o755;
}

export function containerReadableGlobalPaths(opts: {
  readonly coreDnsConfig: { readonly path: string; readonly template: string };
  readonly lokiConfig: { readonly path: string; readonly template: string };
  readonly grafanaDatasource: {
    readonly path: string;
    readonly template: string;
  };
  readonly grafanaDashboardsProvisioning: {
    readonly path: string;
    readonly template: string;
  };
  readonly grafanaDashboardsDir: string;
  readonly grafanaDashboard: {
    readonly path: string;
    readonly template: string;
  };
}): ContainerReadablePath[] {
  const file = (
    entry: { readonly path: string; readonly template: string },
    reader: string
  ): ContainerReadablePath => ({ kind: "file", ...entry, reader });
  return [
    file(opts.coreDnsConfig, "CoreDNS (nonroot)"),
    file(opts.lokiConfig, "Loki (uid 10001)"),
    file(opts.grafanaDatasource, "Grafana (uid 472)"),
    file(opts.grafanaDashboardsProvisioning, "Grafana (uid 472)"),
    {
      kind: "directory",
      path: opts.grafanaDashboardsDir,
      onlyFile: opts.grafanaDashboard.path,
      template: opts.grafanaDashboard.template,
      reader: "Grafana (uid 472)",
    },
    file(opts.grafanaDashboard, "Grafana (uid 472)"),
  ];
}

/** A listed path whose mode Hack left alone because its content is not Hack's. */
export type RetainedCustomPath = {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly reader: string;
};

/**
 * Opens `path` without following a link at its last component, so the entry
 * that is checked is the entry whose mode is changed. Returns null for a
 * link or anything else that cannot be opened.
 */
async function openNoFollow(path: string, directory: boolean) {
  return await open(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : 0)
  ).catch(() => null);
}

/**
 * Sets each listed path to its container-readable mode when, and only when,
 * its content is Hack's template (see the type's comment). Runs on every
 * `hack global install`, whether or not a file was rewritten, so it also
 * repairs template files an earlier run wrote too tightly. A symlink is left
 * alone: its target is the user's own choice. The content check and the mode
 * change go through one descriptor opened without following links, so a path
 * swapped for a link in between cannot redirect the change.
 *
 * Returns the paths it changed, and the customised ones it left with a mode
 * the container user cannot read, so the caller can say what to do.
 */
export async function ensureContainerReadable(
  entries: readonly ContainerReadablePath[]
): Promise<{
  readonly changed: string[];
  readonly retained: RetainedCustomPath[];
}> {
  const changed: string[] = [];
  const retained: RetainedCustomPath[] = [];
  for (const entry of entries) {
    const before = await lstat(entry.path).catch(() => null);
    // Only a regular file, or a real directory, is ever opened: a link is
    // the user's own arrangement, and opening a FIFO would block.
    if (
      before === null ||
      !(entry.kind === "file" ? before.isFile() : before.isDirectory())
    ) {
      continue;
    }
    const wanted = containerReadableMode(entry.kind);
    const keep = (mode: number) =>
      retained.push({
        path: entry.path,
        kind: entry.kind,
        mode,
        reader: entry.reader,
      });
    const handle = await openNoFollow(entry.path, entry.kind === "directory");
    if (handle === null) {
      // Its owner cannot open it, so nothing is known about its content.
      if ((before.mode & wanted) !== wanted) {
        keep(before.mode & 0o777);
      }
      continue;
    }
    try {
      const info = await handle.stat();
      const expectedKind =
        entry.kind === "file" ? info.isFile() : info.isDirectory();
      const mode = info.mode & 0o777;
      if (!expectedKind || (mode & wanted) === wanted) {
        continue;
      }
      const known =
        entry.kind === "file"
          ? (await handle.readFile("utf8")) === entry.template
          : JSON.stringify(await readdir(entry.path).catch(() => null)) ===
              JSON.stringify([basename(entry.onlyFile)]) &&
            (await fileHasTemplate(entry.onlyFile, entry.template));
      if (!known) {
        keep(mode);
        continue;
      }
      await handle.chmod(wanted);
      changed.push(entry.path);
    } finally {
      await handle.close();
    }
  }
  return { changed, retained };
}

/** Whether a regular file (not a link) holds exactly `template`. */
async function fileHasTemplate(
  path: string,
  template: string
): Promise<boolean> {
  const handle = await openNoFollow(path, false);
  if (handle === null) {
    return false;
  }
  try {
    return (
      (await handle.stat()).isFile() &&
      (await handle.readFile("utf8")) === template
    );
  } finally {
    await handle.close();
  }
}

/**
 * The listed paths a container user cannot read right now, by mode alone.
 * Used when a global container is found not running, to name the likely
 * cause without reading or changing anything.
 */
export async function unreadableContainerPaths(
  paths: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[]
): Promise<{ path: string; kind: "file" | "directory"; mode: number }[]> {
  const unreadable: {
    path: string;
    kind: "file" | "directory";
    mode: number;
  }[] = [];
  for (const entry of paths) {
    const info = await lstat(entry.path).catch(() => null);
    const expectedKind =
      entry.kind === "file" ? info?.isFile() : info?.isDirectory();
    const wanted = containerReadableMode(entry.kind);
    if (info && expectedKind && (info.mode & wanted) !== wanted) {
      unreadable.push({
        path: entry.path,
        kind: entry.kind,
        mode: info.mode & 0o777,
      });
    }
  }
  return unreadable;
}

/** What to do about configs a container user cannot read. */
export function describeUnreadableContainerPaths(
  unreadable: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly mode: number;
  }[]
): string {
  return [
    `Not readable by the containers that mount ${unreadable.length === 1 ? "it" : "them"}: ${unreadable.map((entry) => `${entry.path} (mode ${entry.mode.toString(8)})`).join(", ")}.`,
    "hack global install resets the mode of a config whose content is exactly what this Hack writes. It never changes the permissions of one that differs (customised, or written with other settings or by another Hack version), because it may hold something private.",
    ...unreadable.map(
      (entry) =>
        `If you want the container to read it: chmod ${containerReadableMode(entry.kind).toString(8)} ${entry.path} (or, for Hack's own content again, rerun hack global install and agree to overwrite it)`
    ),
  ].join("\n");
}
