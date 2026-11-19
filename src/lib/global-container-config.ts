import { chmod, lstat } from "node:fs/promises";

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
 * Nothing here is secret: each file is rendered from Hack's own templates
 * and holds service addresses, ports and dashboard layout. The list is
 * closed on purpose. Compose files, the global config, the project registry,
 * env keys, certificates and Caddy's data (a Docker volume, not a host
 * directory) are not in it and keep the mode they were written with.
 */
export type ContainerReadablePath = {
  readonly path: string;
  readonly kind: "file" | "directory";
  /** 0644 for a file, 0755 for a directory. */
  readonly mode: number;
  /** The container and user that reads it. */
  readonly reader: string;
};

export function containerReadableGlobalPaths(paths: {
  readonly coreDnsConfig: string;
  readonly lokiConfig: string;
  readonly grafanaDatasource: string;
  readonly grafanaDashboardsProvisioning: string;
  readonly grafanaDashboardsDir: string;
  readonly grafanaDashboard: string;
}): ContainerReadablePath[] {
  const file = (path: string, reader: string): ContainerReadablePath => ({
    path,
    kind: "file",
    mode: 0o644,
    reader,
  });
  return [
    file(paths.coreDnsConfig, "CoreDNS (nonroot)"),
    file(paths.lokiConfig, "Loki (uid 10001)"),
    file(paths.grafanaDatasource, "Grafana (uid 472)"),
    file(paths.grafanaDashboardsProvisioning, "Grafana (uid 472)"),
    {
      path: paths.grafanaDashboardsDir,
      kind: "directory",
      mode: 0o755,
      reader: "Grafana (uid 472)",
    },
    file(paths.grafanaDashboard, "Grafana (uid 472)"),
  ];
}

/**
 * Sets each listed path to its mode when it exists as the expected kind and
 * differs. Runs on every `hack global install`, whether or not a file's
 * content changed, so it also repairs files an earlier run wrote too
 * tightly. A symlink is left alone: its target is the user's own choice.
 * Returns the paths it changed.
 */
export async function ensureContainerReadable(
  entries: readonly ContainerReadablePath[]
): Promise<string[]> {
  const changed: string[] = [];
  for (const entry of entries) {
    const info = await lstat(entry.path).catch(() => null);
    const expected =
      entry.kind === "file" ? info?.isFile() : info?.isDirectory();
    if (!(info && expected) || (info.mode & 0o777) === entry.mode) {
      continue;
    }
    await chmod(entry.path, entry.mode);
    changed.push(entry.path);
  }
  return changed;
}
