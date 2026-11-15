/** Complete, observe-only path traversal for the NSS read admission witness. */
import { dirname, isAbsolute } from "node:path";
import type { LinuxTrustHost } from "./linux-trust-setup.ts";

const MAX_LINKS = 40;
const MAX_ENTRIES = 256;

/**
 * Follow components in kernel order, including every intermediate link target
 * and its ancestor chain. Endpoints alone cannot prove a path is safe. Every
 * visited entry is pinned; group/world-writable directories are refused even
 * when sticky. No owner-home repair or service-path policy is used here.
 *
 * Older injected boundaries without lstat/readlink can prove only paths with
 * no aliases: each inspected prefix must equal its resolved path.
 */
export async function inspectNssReadPath(opts: {
  readonly host: LinuxTrustHost;
  readonly path: string;
}): Promise<string | null> {
  if (!isAbsolute(opts.path)) {
    return null;
  }
  const { host } = opts;
  const queue = opts.path.split("/");
  const entries: unknown[] = [];
  let current = "/";
  let links = 0;
  const root = await host.inspectPath("/");
  if (!(root?.isDirectory && safeOwnerMode(root, host.uid, false))) {
    return null;
  }
  entries.push(["/", root.identity]);
  while (queue.length > 0) {
    if (entries.length >= MAX_ENTRIES) {
      return null;
    }
    const component = queue.shift();
    if (["", ".", undefined].includes(component)) {
      continue;
    }
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const named = current === "/" ? `/${component}` : `${current}/${component}`;
    const entry = await readPathEntry({ host, path: named });
    if (entry === null) {
      return null;
    }
    entries.push([named, entry.identity, entry.target]);
    if (entry.target === null) {
      current = named;
      continue;
    }
    if (++links > MAX_LINKS) {
      return null;
    }
    if (isAbsolute(entry.target)) {
      current = "/";
    }
    queue.unshift(...entry.target.split("/"));
  }
  return JSON.stringify([current, entries]);
}

async function readPathEntry(opts: {
  readonly host: LinuxTrustHost;
  readonly path: string;
}): Promise<{
  readonly identity: string;
  readonly target: string | null;
} | null> {
  const { host, path } = opts;
  if (!(host.inspectEntry && host.readLink)) {
    const info = await host.inspectPath(path);
    return info?.isDirectory &&
      info.realPath === path &&
      safeOwnerMode(info, host.uid, false)
      ? { identity: info.identity, target: null }
      : null;
  }
  const info = await host.inspectEntry(path);
  if (!(info && safeOwnerMode(info, host.uid, info.isSymbolicLink))) {
    return null;
  }
  if (!info.isSymbolicLink) {
    return info.isDirectory ? { identity: info.identity, target: null } : null;
  }
  const target = await host.readLink(path);
  return target ? { identity: info.identity, target } : null;
}

function safeOwnerMode(
  info: { readonly uid: number; readonly mode: number },
  uid: number,
  link: boolean
): boolean {
  return [uid, 0].includes(info.uid) && (link || (info.mode & 0o022) === 0);
}
